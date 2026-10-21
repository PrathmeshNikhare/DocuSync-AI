import { z } from "zod";
import { normalizeFiles } from "@/lib/diff-analyzer/normalize";
import {
  githubNameSchema,
  pullRequestSnapshotSchema,
  repoPathSchema,
  type PullRequestSnapshot,
} from "@/lib/schemas";
import { DEFAULT_CONFIG, ENGINE_VERSION, type EngineConfig } from "./config";
import { analyzeImpact, type ImpactResult } from "./engine";

/**
 * A labelled scenario: raw GitHub file entries, the docs at the PR head, and the
 * docs a human judged to need an update. Labels are written before the engine runs.
 */
export const scenarioSchema = z
  .strictObject({
    datasetVersion: z.string().min(1).max(32),
    id: githubNameSchema,
    category: z.string().regex(/^[a-z_]{1,40}$/),
    description: z.string().min(1).max(1000),
    files: z.array(z.unknown()).min(1).max(50),
    docs: z.record(repoPathSchema, z.string().max(200_000)),
    labels: z.strictObject({ affected: z.array(repoPathSchema) }),
  })
  .refine((s) => s.labels.affected.every((p) => p in s.docs), {
    message: "Every labelled doc must exist in docs",
    path: ["labels", "affected"],
  })
  // Docs the PR edits are excluded from scoring, so labelling one would hide a
  // false negative instead of counting it.
  .refine(
    (s) => {
      const edited = new Set(
        s.files.map((f) => (f as { filename?: unknown }).filename),
      );
      return s.labels.affected.every((p) => !edited.has(p));
    },
    {
      message: "A doc the PR itself edits cannot be labelled affected",
      path: ["labels", "affected"],
    },
  );
export type Scenario = z.infer<typeof scenarioSchema>;

export function snapshotFor(scenario: Scenario): PullRequestSnapshot {
  const { files, rejectedFiles } = normalizeFiles(scenario.files);
  return pullRequestSnapshotSchema.parse({
    ref: { owner: "fixture", repo: scenario.id, number: 1 },
    title: scenario.description,
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    files,
    rejectedFiles,
    filesTruncated: false,
  });
}

export function runScenario(
  scenario: Scenario,
  config: EngineConfig = DEFAULT_CONFIG,
): ImpactResult {
  const docs = Object.entries(scenario.docs).map(([path, content]) => ({
    path,
    content,
  }));
  return analyzeImpact(snapshotFor(scenario), docs, config);
}

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface DocOutcome {
  docPath: string;
  labelled: boolean;
  flagged: boolean;
  status: string;
  outcome: "tp" | "fp" | "fn" | "tn";
}

export interface ScenarioResult {
  id: string;
  category: string;
  /** Docs the PR itself edits are excluded from scoring. */
  excluded: string[];
  docs: DocOutcome[];
  counts: Counts;
}

/** "Flagged" means the engine asks a human to look: likely_affected or verify. */
export function scoreScenario(
  scenario: Scenario,
  result: ImpactResult,
): ScenarioResult {
  const byDoc = new Map(result.candidates.map((c) => [c.docPath, c.status]));
  const excluded = new Set(result.docsChangedInPr);
  const counts: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const docs: DocOutcome[] = [];
  for (const docPath of Object.keys(scenario.docs).sort()) {
    if (excluded.has(docPath)) continue;
    const status = byDoc.get(docPath) ?? "not_flagged";
    const flagged = status === "likely_affected" || status === "verify";
    const labelled = scenario.labels.affected.includes(docPath);
    const outcome = labelled ? (flagged ? "tp" : "fn") : flagged ? "fp" : "tn";
    counts[outcome]++;
    docs.push({ docPath, labelled, flagged, status, outcome });
  }
  return {
    id: scenario.id,
    category: scenario.category,
    excluded: [...excluded],
    docs,
    counts,
  };
}

export const add = (a: Counts, b: Counts): Counts => ({
  tp: a.tp + b.tp,
  fp: a.fp + b.fp,
  fn: a.fn + b.fn,
  tn: a.tn + b.tn,
});

/** Null when undefined (no flagged docs, or no relevant docs), never a made-up 0 or 1. */
export const precision = (c: Counts): number | null =>
  c.tp + c.fp === 0 ? null : c.tp / (c.tp + c.fp);
export const recall = (c: Counts): number | null =>
  c.tp + c.fn === 0 ? null : c.tp / (c.tp + c.fn);

const pct = (v: number | null) =>
  v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;

/** Deterministic Markdown report (no timestamps) so it can be checked into the repo. */
export function renderReport(
  scenarios: readonly Scenario[],
  results: readonly ScenarioResult[],
): string {
  const total = results.reduce((acc, r) => add(acc, r.counts), {
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
  });
  const versions = [...new Set(scenarios.map((s) => s.datasetVersion))].join(
    ", ",
  );
  const byDataset = new Map<string, Counts>();
  results.forEach((r, i) => {
    const v = scenarios[i]!.datasetVersion;
    byDataset.set(
      v,
      add(byDataset.get(v) ?? { tp: 0, fp: 0, fn: 0, tn: 0 }, r.counts),
    );
  });
  const byCategory = new Map<string, Counts>();
  for (const r of results) {
    byCategory.set(
      r.category,
      add(
        byCategory.get(r.category) ?? { tp: 0, fp: 0, fn: 0, tn: 0 },
        r.counts,
      ),
    );
  }
  const row = (name: string, c: Counts) =>
    `| ${name} | ${c.tp} | ${c.fp} | ${c.fn} | ${c.tn} | ${pct(precision(c))} | ${pct(recall(c))} |`;
  const adversarial = scenarios
    .filter((s) => s.category.startsWith("known_"))
    .map((s) => `\`${s.id}\``);
  const lines = [
    "# Impact engine baseline (deterministic)",
    "",
    "Generated by `npm run eval:impact`. Do not edit by hand.",
    "",
    `- Engine: \`${ENGINE_VERSION}\` (no model)`,
    `- Dataset: \`${versions}\`, ${scenarios.length} synthetic scenarios in \`fixtures/impact/\`, ${results.reduce((n, r) => n + r.docs.length, 0)} scored docs (docs edited by the PR itself are excluded)`,
    "- Flagged = `likely_affected` or `verify`. Rule points are not probabilities.",
    "",
    "## Overall",
    "",
    "| Scope | TP | FP | FN | TN | Precision | Recall |",
    "|---|---|---|---|---|---|---|",
    row("All scenarios", total),
    ...[...byDataset.keys()]
      .sort()
      .map((k) => row(`Dataset \`${k}\``, byDataset.get(k)!)),
    "",
    "## By category",
    "",
    "| Category | TP | FP | FN | TN | Precision | Recall |",
    "|---|---|---|---|---|---|---|",
    ...[...byCategory.keys()].sort().map((k) => row(k, byCategory.get(k)!)),
    "",
    "## Per scenario",
    "",
    "| Scenario | Doc | Labelled affected | Engine status | Outcome |",
    "|---|---|---|---|---|",
    ...results.flatMap((r) =>
      r.docs.map(
        (d) =>
          `| ${r.id} | ${d.docPath} | ${d.labelled ? "yes" : "no"} | ${d.status} | ${d.outcome.toUpperCase()} |`,
      ),
    ),
    "",
    "## Limits of this dataset",
    "",
    "- Small and synthetic: every scenario was written for this project, and the same author wrote the labels and the engine. The `impact-v1` labels were written before the engine existed. The dataset is not independent, and only `impact-v3` (below) was kept out of tuning.",
    "- These numbers describe these fixtures only. They do not estimate performance on real repositories and must not be quoted as such.",
    `- ${adversarial.length} scenarios are deliberately adversarial (${adversarial.join(", ")}): their categories start with \`known_\` and show the deterministic baseline's blind spots (generic words that collide with exported names, behaviour changes that leave no name, path or key in the diff, files the engine does not parse).`,
    "- `impact-v2` holds regression scenarios written for specific review findings (dependency bumps, CI workflows, self-documenting PRs, docs linked from edited docs, multi-hunk `package.json`, root and dynamic routes). They were labelled before the fixes and scored TP 2, FP 6, FN 1, TN 5 on engine `deterministic-0.1.0`. A perfect score on them after the fixes shows the fixes work, not that the engine generalizes.",
    "- `impact-v3` was written and labelled in Phase 06 before the engine or model was run on it (label hash in `docs/08-testing-and-evaluation.md`), and the engine was not changed in response. It is the only set not used for tuning, so its row is the closest thing here to a held-out result. It is still small and synthetic, written by the same author.",
    "- Only TypeScript/JavaScript sources, `.env*` files, `package.json` scripts and JSON/YAML/TOML keys are understood. Other languages contribute file-path signals only.",
    "",
  ];
  return lines.join("\n");
}
