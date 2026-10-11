// Usage: npm run eval:impact
// Runs the deterministic engine over fixtures/impact/*.json and writes
// docs/evaluation/impact-baseline.md. Labels in the fixtures are never changed here.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  renderReport,
  runScenario,
  scenarioSchema,
  scoreScenario,
} from "@/lib/impact-engine/evaluate";

const SCENARIO_DIR = path.join(process.cwd(), "fixtures", "impact");
const REPORT_PATH = path.join(
  process.cwd(),
  "docs",
  "evaluation",
  "impact-baseline.md",
);

const scenarios = readdirSync(SCENARIO_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) =>
    scenarioSchema.parse(
      JSON.parse(readFileSync(path.join(SCENARIO_DIR, f), "utf8")),
    ),
  );
const results = scenarios.map((s) => scoreScenario(s, runScenario(s)));

mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, renderReport(scenarios, results));
const t = results.reduce(
  (a, r) => ({
    tp: a.tp + r.counts.tp,
    fp: a.fp + r.counts.fp,
    fn: a.fn + r.counts.fn,
    tn: a.tn + r.counts.tn,
  }),
  { tp: 0, fp: 0, fn: 0, tn: 0 },
);
console.log(
  `${scenarios.length} scenarios: TP ${t.tp}, FP ${t.fp}, FN ${t.fn}, TN ${t.tn}. Wrote ${path.relative(process.cwd(), REPORT_PATH)}`,
);
