// Usage: npm run propose -- --fixture env-var-renamed
// Runs the deterministic engine and then, if OLLAMA_MODEL is set, the model
// assessment and patch proposal on one labelled scenario from fixtures/impact/.
// Without a model it prints a deterministic-only result. Nothing is written to
// any repository or file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assistImpact } from "@/lib/assist/assist";
import { getOllamaEnv } from "@/lib/env";
import { scenarioSchema, snapshotFor } from "@/lib/impact-engine/evaluate";
import { createOllamaProvider } from "@/lib/llm/ollama";
import { toTerminalSafeJson } from "@/lib/terminal-safe-json";

const { values } = parseArgs({ options: { fixture: { type: "string" } } });
const name = values.fixture ?? "";
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
  console.error("Usage: npm run propose -- --fixture <scenario name>");
  process.exit(2);
}

async function main() {
  let raw: string;
  try {
    raw = readFileSync(
      path.join(process.cwd(), "fixtures", "impact", `${name}.json`),
      "utf8",
    );
  } catch {
    console.error("FIXTURE_NOT_FOUND");
    process.exit(1);
  }
  const scenario = scenarioSchema.parse(JSON.parse(raw));
  const env = getOllamaEnv();
  const docs = Object.entries(scenario.docs).map(([p, content]) => ({
    path: p,
    content,
  }));
  const result = await assistImpact(
    snapshotFor(scenario),
    docs,
    env && createOllamaProvider(env),
  );
  // Fixture and model text are untrusted: escape terminal-control characters.
  console.log(toTerminalSafeJson(result));
}

main().catch((err: unknown) => {
  // Safe codes only: never print model output or upstream messages.
  if (
    err instanceof Error &&
    err.message.startsWith("Invalid server environment")
  )
    console.error(err.message);
  else console.error("PROPOSE_FAILED");
  process.exit(1);
});
