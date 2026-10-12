// Usage: npm run analysis:run -- --fixture env-var-renamed
// Runs the real pipeline (deterministic engine, then the model if OLLAMA_MODEL is
// set) on one labelled fixture and saves the result as a completed analysis under
// a repository marked as fixture data (D-012). Uses the app role (DATABASE_URL).
// Grant reviewers access with `npm run reviewer:grant -- --repo fixture/<name>`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { assistImpact } from "@/lib/assist/assist";
import { getOllamaEnv, getServerEnv } from "@/lib/env";
import { scenarioSchema, snapshotFor } from "@/lib/impact-engine/evaluate";
import { createOllamaProvider } from "@/lib/llm/ollama";
import { saveFixtureAnalysis } from "@/lib/review/store";

const { values } = parseArgs({ options: { fixture: { type: "string" } } });
const name = values.fixture ?? "";
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
  console.error("Usage: npm run analysis:run -- --fixture <scenario name>");
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
  const snapshot = snapshotFor(scenario);
  const docs = Object.entries(scenario.docs).map(([p, content]) => ({
    path: p,
    content,
  }));
  const env = getOllamaEnv();
  const result = await assistImpact(
    snapshot,
    docs,
    env && createOllamaProvider(env),
  );
  const pool = new Pool({
    connectionString: getServerEnv().DATABASE_URL,
    max: 1,
  });
  try {
    const id = await saveFixtureAnalysis(
      pool,
      scenario.id,
      snapshot,
      docs,
      result,
    );
    console.error(
      `Saved analysis ${id} (fixture/${scenario.id}, model ${result.modelStatus}, ` +
        `${result.proposals.length} validated proposal(s)). Open /analyses/${id}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const code = (err as { code?: unknown })?.code;
  if (
    err instanceof Error &&
    err.message.startsWith("Invalid server environment")
  ) {
    console.error(err.message);
  } else {
    console.error(
      typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
        ? `ANALYSIS_RUN_FAILED (${code})`
        : "ANALYSIS_RUN_FAILED",
    );
  }
  process.exit(1);
});
