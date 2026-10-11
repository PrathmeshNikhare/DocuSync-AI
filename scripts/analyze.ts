// Usage: npm run analyze -- --fixture env-var-renamed
// Runs the deterministic impact engine on one labelled scenario from
// fixtures/impact/ and prints the result. Live repositories are not supported yet
// (fetching docs needs the Contents permission; see the Phase 02 handoff).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runScenario, scenarioSchema } from "@/lib/impact-engine/evaluate";
import { toTerminalSafeJson } from "@/lib/terminal-safe-json";

const { values } = parseArgs({ options: { fixture: { type: "string" } } });
const name = values.fixture ?? "";
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
  console.error("Usage: npm run analyze -- --fixture <scenario name>");
  process.exit(2);
}

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
// Fixture text is untrusted: escape terminal-control characters.
console.log(toTerminalSafeJson(runScenario(scenario)));
