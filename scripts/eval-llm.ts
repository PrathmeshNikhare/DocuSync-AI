// Usage: npm run eval:llm   (needs OLLAMA_MODEL and a running Ollama)
// Runs deterministic and model-assisted analysis over fixtures/impact/*.json, checks
// proposals against fixtures/patches/labels.json, and writes
// docs/evaluation/llm-assisted.md. Labels are never changed here.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ASSIST_POLICY_VERSION, assistImpact } from "@/lib/assist/assist";
import {
  assistedImpact,
  checkPatchLabel,
  patchLabelsSchema,
  renderLlmReport,
  type LlmEvalRun,
} from "@/lib/assist/evaluate";
import { getOllamaEnv } from "@/lib/env";
import { ENGINE_VERSION } from "@/lib/impact-engine/config";
import {
  scenarioSchema,
  scoreScenario,
  snapshotFor,
} from "@/lib/impact-engine/evaluate";
import { createOllamaProvider } from "@/lib/llm/ollama";
import { readBodyLimited } from "@/lib/read-body";
import { ASSESS_PROMPT_VERSION, PATCH_PROMPT_VERSION } from "@/lib/llm/prompts";

const ROOT = process.cwd();
const REPORT_PATH = path.join(ROOT, "docs", "evaluation", "llm-assisted.md");

/** The server's version for the report: hardened like the provider, and shape-checked. */
async function ollamaVersion(baseUrl: string): Promise<string> {
  try {
    const res = await fetch(
      new URL("api/version", baseUrl.replace(/\/?$/, "/")),
      {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    const body = res.ok ? await readBodyLimited(res, 4_096) : null;
    const parsed = body
      ? z
          .object({ version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/) })
          .safeParse(JSON.parse(new TextDecoder().decode(body)))
      : undefined;
    return parsed?.success ? parsed.data.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const env = getOllamaEnv();
  if (!env) {
    console.error(
      "LLM_NOT_CONFIGURED: set OLLAMA_MODEL to run this evaluation",
    );
    process.exit(1);
  }
  const version = await ollamaVersion(env.baseUrl);

  const dir = path.join(ROOT, "fixtures", "impact");
  const scenarios = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) =>
      scenarioSchema.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8"))),
    );
  const labels = patchLabelsSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(ROOT, "fixtures", "patches", "labels.json"),
        "utf8",
      ),
    ),
  );
  const provider = createOllamaProvider(env);

  const run: LlmEvalRun = {
    environment: {
      model: env.model,
      ollamaVersion: version,
      numCtx: env.numCtx,
      timeoutMs: env.timeoutMs,
      promptVersions: [ASSESS_PROMPT_VERSION, PATCH_PROMPT_VERSION],
      assistPolicy: ASSIST_POLICY_VERSION,
      engineVersion: ENGINE_VERSION,
      datasetVersions: [...new Set(scenarios.map((s) => s.datasetVersion))],
      patchLabelVersion: labels.datasetVersion,
      date: new Date().toISOString().slice(0, 10),
    },
    scenarios: [],
  };
  for (const s of scenarios) {
    const docs = Object.entries(s.docs).map(([p, content]) => ({
      path: p,
      content,
    }));
    const result = await assistImpact(snapshotFor(s), docs, provider);
    run.scenarios.push({
      id: s.id,
      deterministic: scoreScenario(s, result.deterministic),
      assisted: scoreScenario(s, assistedImpact(result)),
      result,
      patches: labels.labels
        .filter((l) => l.scenario === s.id)
        .map((l) => ({
          docPath: l.docPath,
          outcome: checkPatchLabel(l, s.docs[l.docPath]!, result),
        })),
    });
    console.error(`${s.id}: ${result.modelStatus}`);
  }

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, renderLlmReport(run));
  console.error(`Wrote ${path.relative(ROOT, REPORT_PATH)}`);
}

main().catch((err: unknown) => {
  if (
    err instanceof Error &&
    err.message.startsWith("Invalid server environment")
  )
    console.error(err.message);
  else console.error("EVAL_LLM_FAILED");
  process.exit(1);
});
