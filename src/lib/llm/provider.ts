import { z } from "zod";
import { logEvent } from "@/lib/log";
import type { ModelMeta } from "@/lib/schemas";

export type LlmFailureCode =
  | "LLM_NOT_CONFIGURED"
  | "LLM_UNAVAILABLE"
  | "LLM_TIMEOUT"
  | "LLM_MODEL_NOT_FOUND"
  | "LLM_INVALID_OUTPUT"
  /** The prompt would not fit the model's context; it was not sent. */
  | "LLM_CONTEXT_TOO_LARGE";

export interface ChatRequest {
  system: string;
  /** JSON-encoded data. Untrusted repository content lives only in here. */
  user: string;
  /** JSON schema the reply must follow (constrained decoding where supported). */
  jsonSchema: Record<string, unknown>;
  /**
   * 1 for the first try. A retry repeats the same request, so a provider must vary
   * its sampling (Ollama: a different seed) or the retry returns the same reply.
   */
  attempt: number;
}

export type ChatResponse =
  | { ok: true; content: string }
  | {
      ok: false;
      code: Exclude<
        LlmFailureCode,
        "LLM_NOT_CONFIGURED" | "LLM_CONTEXT_TOO_LARGE"
      >;
    };

/**
 * A transport to one model. It is given no tools and no credentials: it can only
 * return text, which callers validate before use.
 */
export interface LlmProvider {
  readonly provider: string;
  readonly modelId: string;
  /**
   * Largest prompt (system + user + schema, in characters) the model can take
   * without silently truncating it. Unset means no limit is known.
   */
  readonly maxInputChars?: number;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export type StructuredResult<T> =
  | {
      ok: true;
      value: T;
      meta: ModelMeta;
      attempts: number;
      durationMs: number;
    }
  | { ok: false; code: LlmFailureCode; attempts: number; durationMs: number };

/** Invalid output is retried this many times in total; transport failures never are. */
export const MAX_ATTEMPTS = 2;

/**
 * Sends `data` as JSON and validates the reply against `schema`. The schema is
 * the only way model output reaches callers.
 */
export async function generateStructured<T>(
  provider: LlmProvider,
  request: {
    promptVersion: string;
    system: string;
    data: unknown;
    schema: z.ZodType<T>;
  },
): Promise<StructuredResult<T>> {
  const started = performance.now();
  const chat: Omit<ChatRequest, "attempt"> = {
    system: request.system,
    user: JSON.stringify(request.data),
    jsonSchema: z.toJSONSchema(request.schema) as Record<string, unknown>,
  };
  const finish = (result: StructuredResult<T>): StructuredResult<T> => {
    logEvent("llm_call", {
      outcome: result.ok ? "ok" : "failed",
      code: result.ok ? undefined : result.code,
      model: provider.modelId,
      promptVersion: request.promptVersion,
      durationMs: String(Math.round(result.durationMs)),
    });
    return result;
  };

  // An over-long prompt would be truncated by the server, possibly dropping the
  // doc or the untrusted-data warning: refuse it instead of sending it.
  const promptChars =
    chat.system.length +
    chat.user.length +
    JSON.stringify(chat.jsonSchema).length;
  if (
    provider.maxInputChars !== undefined &&
    promptChars > provider.maxInputChars
  ) {
    return finish({
      ok: false,
      code: "LLM_CONTEXT_TOO_LARGE",
      attempts: 0,
      durationMs: 0,
    });
  }

  for (let attempt = 1; ; attempt++) {
    let reply: ChatResponse;
    try {
      reply = await provider.chat({ ...chat, attempt });
    } catch {
      // The contract is failure codes; a provider that throws counts as unavailable.
      reply = { ok: false, code: "LLM_UNAVAILABLE" };
    }
    const durationMs = performance.now() - started;
    if (!reply.ok) {
      return finish({
        ok: false,
        code: reply.code,
        attempts: attempt,
        durationMs,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.content);
    } catch {
      parsed = undefined;
    }
    const valid = request.schema.safeParse(parsed);
    if (valid.success) {
      return finish({
        ok: true,
        value: valid.data,
        meta: {
          provider: provider.provider,
          modelId: provider.modelId,
          promptVersion: request.promptVersion,
        },
        attempts: attempt,
        durationMs,
      });
    }
    if (attempt >= MAX_ATTEMPTS) {
      return finish({
        ok: false,
        code: "LLM_INVALID_OUTPUT",
        attempts: attempt,
        durationMs,
      });
    }
  }
}
