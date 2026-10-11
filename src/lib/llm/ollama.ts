import { z } from "zod";
import type { OllamaEnv } from "@/lib/env";
import { readBodyLimited } from "@/lib/read-body";
import type { ChatResponse, LlmProvider } from "./provider";

/** A structured reply is a few KiB; anything near this is not a valid answer. */
export const OLLAMA_MAX_RESPONSE_BYTES = 256 * 1024;
/** Tokens kept free for the reply. */
export const OLLAMA_REPLY_TOKENS = 1_024;
/**
 * Conservative characters per token for JSON-heavy English and code. A heuristic,
 * not a tokenizer: it errs toward refusing a prompt rather than truncating one.
 */
export const CHARS_PER_TOKEN = 2.5;

// Ollama adds timing fields; only the reply text is used.
const chatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  done: z.literal(true),
});

const isTimeout = (e: unknown) =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/**
 * Ollama `/api/chat` without streaming. Temperature 0 and a fixed seed per attempt
 * make runs repeatable on one machine, not across machines or model versions.
 */
export function createOllamaProvider(
  env: OllamaEnv,
  fetchImpl: typeof fetch = fetch,
): LlmProvider {
  const endpoint = new URL(
    "api/chat",
    env.baseUrl.endsWith("/") ? env.baseUrl : `${env.baseUrl}/`,
  );
  return {
    provider: "ollama",
    modelId: env.model,
    maxInputChars: Math.floor(
      (env.numCtx - OLLAMA_REPLY_TOKENS) * CHARS_PER_TOKEN,
    ),
    async chat(request): Promise<ChatResponse> {
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: env.model,
            stream: false,
            format: request.jsonSchema,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            // Same seed on the first try for repeatable runs; a new one on a retry.
            options: {
              temperature: 0,
              seed: 41 + request.attempt,
              num_ctx: env.numCtx,
            },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(env.timeoutMs),
        });
        if (!res.ok) {
          await res.body?.cancel();
          return {
            ok: false,
            code:
              res.status === 404 ? "LLM_MODEL_NOT_FOUND" : "LLM_UNAVAILABLE",
          };
        }
        const body = await readBodyLimited(res, OLLAMA_MAX_RESPONSE_BYTES);
        if (!body) return { ok: false, code: "LLM_INVALID_OUTPUT" };
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder().decode(body));
        } catch {
          return { ok: false, code: "LLM_INVALID_OUTPUT" };
        }
        const parsed = chatResponseSchema.safeParse(json);
        return parsed.success
          ? { ok: true, content: parsed.data.message.content }
          : { ok: false, code: "LLM_INVALID_OUTPUT" };
      } catch (e) {
        // The timeout also covers reading the body.
        return {
          ok: false,
          code: isTimeout(e) ? "LLM_TIMEOUT" : "LLM_UNAVAILABLE",
        };
      }
    },
  };
}
