import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  precision,
  recall,
  renderReport,
  runScenario,
  scenarioSchema,
  scoreScenario,
  type Scenario,
} from "./evaluate";

const DIR = "fixtures/impact";
const scenarios: Scenario[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) =>
    scenarioSchema.parse(JSON.parse(readFileSync(path.join(DIR, f), "utf8"))),
  );

describe("metrics", () => {
  it("computes precision and recall from counts", () => {
    expect(precision({ tp: 9, fp: 1, fn: 1, tn: 15 })).toBeCloseTo(0.9);
    expect(recall({ tp: 3, fp: 0, fn: 1, tn: 0 })).toBeCloseTo(0.75);
  });

  it("returns null instead of inventing a value when undefined", () => {
    expect(precision({ tp: 0, fp: 0, fn: 2, tn: 1 })).toBeNull();
    expect(recall({ tp: 0, fp: 1, fn: 0, tn: 3 })).toBeNull();
  });
});

describe("scoreScenario", () => {
  it("excludes docs the PR edits and counts every other doc exactly once", () => {
    const s = scenarios.find((x) => x.id === "docs-only")!;
    const r = scoreScenario(s, runScenario(s));
    expect(r.excluded).toEqual(["docs/guide.md"]);
    expect(r.docs.map((d) => d.docPath)).toEqual([
      "README.md",
      "docs/architecture.md",
    ]);
    expect(r.counts).toEqual({ tp: 0, fp: 0, fn: 0, tn: 2 });
  });

  it("classifies flagged and labelled docs into TP/FP/FN/TN", () => {
    const fp = scenarios.find((x) => x.id === "false-positive-generic-word")!;
    const fn = scenarios.find((x) => x.id === "false-negative-behaviour")!;
    expect(scoreScenario(fp, runScenario(fp)).counts).toEqual({
      tp: 0,
      fp: 1,
      fn: 0,
      tn: 1,
    });
    expect(scoreScenario(fn, runScenario(fn)).counts).toEqual({
      tp: 0,
      fp: 0,
      fn: 1,
      tn: 1,
    });
  });
});

describe("dataset", () => {
  it("has labelled scenarios covering the planned categories, including no-impact cases", () => {
    const categories = new Set(scenarios.map((s) => s.category));
    for (const c of [
      "env_var",
      "api_route",
      "import_export",
      "package_script",
      "config_key",
      "path_change",
      "no_impact",
      "missing_context",
      "security",
      "known_false_positive",
      "known_false_negative",
    ]) {
      expect(categories.has(c), c).toBe(true);
    }
    expect(scenarios.some((s) => s.labels.affected.length === 0)).toBe(true);
  });

  it("rejects labelling a doc the PR itself edits (it would hide a false negative)", () => {
    const s = scenarios.find((x) => x.id === "docs-only")!;
    const bad = { ...s, labels: { affected: ["docs/guide.md"] } };
    expect(scenarioSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a label that names a doc missing from the scenario", () => {
    const bad = { ...scenarios[0]!, labels: { affected: ["docs/missing.md"] } };
    expect(scenarioSchema.safeParse(bad).success).toBe(false);
  });
});

describe("baseline report", () => {
  it("is deterministic and the committed report is current (run `npm run eval:impact` if this fails)", () => {
    const results = scenarios.map((s) => scoreScenario(s, runScenario(s)));
    const report = renderReport(scenarios, results);
    expect(renderReport(scenarios, results)).toBe(report);
    expect(readFileSync("docs/evaluation/impact-baseline.md", "utf8")).toBe(
      report,
    );
    // Precision/recall are percentages of fixture counts; rule points carry an explicit disclaimer.
    expect(report).toContain("Rule points are not probabilities.");
    expect(report).not.toMatch(/confiden/i);
  });
});
