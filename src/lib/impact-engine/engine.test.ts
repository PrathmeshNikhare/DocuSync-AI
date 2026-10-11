import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOC_LIMITS,
  impactCandidateSchema,
  type ChangedFile,
  type PullRequestSnapshot,
} from "@/lib/schemas";
import { DEFAULT_CONFIG } from "./config";
import { analyzeImpact } from "./engine";
import {
  runScenario,
  scenarioSchema,
  snapshotFor,
  type Scenario,
} from "./evaluate";
import { diffLines } from "./signals";

const DIR = "fixtures/impact";
const scenarios: Scenario[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) =>
    scenarioSchema.parse(JSON.parse(readFileSync(path.join(DIR, f), "utf8"))),
  );
const byId = (id: string) => scenarios.find((s) => s.id === id)!;
const statusOf = (s: Scenario, doc: string) =>
  runScenario(s).candidates.find((c) => c.docPath === doc)?.status ??
  "not_flagged";

function snapshot(files: ChangedFile[]): PullRequestSnapshot {
  return {
    ref: { owner: "o", repo: "r", number: 1 },
    title: "t",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    files,
    rejectedFiles: [],
    filesTruncated: false,
  };
}
const file = (
  p: string,
  lines: string[],
  extra: Partial<ChangedFile> = {},
): ChangedFile => ({
  path: p,
  status: "modified",
  additions: lines.filter((l) => l[0] === "+").length,
  deletions: lines.filter((l) => l[0] === "-").length,
  patchState: "included",
  hunks: [
    {
      oldStart: 1,
      oldLines: lines.filter((l) => l[0] !== "+").length,
      newStart: 1,
      newLines: lines.filter((l) => l[0] !== "-").length,
      lines,
    },
  ],
  ...extra,
});

describe("analyzeImpact on the labelled fixtures", () => {
  it.each(scenarios.map((s) => [s.id, s] as const))(
    "%s: candidates satisfy the shared schema and evidence quotes real fixture lines",
    (_id, s) => {
      const snap = snapshotFor(s);
      for (const c of runScenario(s).candidates) {
        expect(impactCandidateSchema.safeParse(c).success).toBe(true);
        expect(Number.isInteger(c.rankPoints)).toBe(true);
        for (const e of c.evidence) {
          expect(e.excerpt?.length ?? 0).toBeLessThanOrEqual(300);
          if (!e.lineRange) continue;
          const doc = s.docs[e.sourcePath];
          if (doc !== undefined) {
            // Doc evidence: the excerpt is that line of the doc at head.
            expect(e.side).toBe("head");
            const line = doc.split("\n")[e.lineRange.start - 1]!;
            expect(e.excerpt).toBe(line.trim().slice(0, 300));
          } else {
            // Source evidence: the excerpt is the changed line at that side and number.
            // Removed lines of a renamed file live at its previous path.
            const f = snap.files.find((x) =>
              e.side === "base" && x.previousPath
                ? x.previousPath === e.sourcePath
                : x.path === e.sourcePath,
            )!;
            const want = e.side === "base" ? "-" : "+";
            const line = diffLines(f).find(
              (l) => l.prefix === want && l.line === e.lineRange!.start,
            );
            expect(
              line,
              `${e.sourcePath}:${e.side}:${e.lineRange.start}`,
            ).toBeDefined();
            expect(e.excerpt).toBe(line!.text.trim().slice(0, 300));
          }
        }
      }
    },
  );

  it("is deterministic and independent of doc input order", () => {
    for (const s of scenarios) {
      const docs = Object.entries(s.docs).map(([p, content]) => ({
        path: p,
        content,
      }));
      const a = analyzeImpact(snapshotFor(s), docs);
      const b = analyzeImpact(snapshotFor(s), [...docs].reverse());
      expect(b).toEqual(a);
    }
  });

  it("flags removed or renamed references as likely affected", () => {
    expect(statusOf(byId("env-var-renamed"), "docs/configuration.md")).toBe(
      "likely_affected",
    );
    expect(statusOf(byId("export-renamed"), "docs/usage.md")).toBe(
      "likely_affected",
    );
    expect(statusOf(byId("script-renamed"), "README.md")).toBe(
      "likely_affected",
    );
    expect(statusOf(byId("linked-file-renamed"), "docs/architecture.md")).toBe(
      "likely_affected",
    );
  });

  it("does not claim a doc mentions the new script `fix` because it says `lint:fix`", () => {
    const readme = runScenario(byId("script-renamed")).candidates.find(
      (c) => c.docPath === "README.md",
    )!;
    expect(readme.rules).toEqual([
      "package_script_removed",
      "undocumented_package_script",
    ]);
    expect(readme.reason).not.toContain("Mentions `fix`");
  });

  it("asks for verification when something mentioned only changed", () => {
    expect(statusOf(byId("api-route-changed"), "docs/api.md")).toBe("verify");
    expect(
      statusOf(byId("config-default-changed"), "docs/configuration.md"),
    ).toBe("verify");
  });

  it("points an undocumented new env var at the doc that lists related ones", () => {
    const c = runScenario(byId("env-var-added-undocumented")).candidates;
    expect(c.map((x) => [x.docPath, x.status])).toEqual([
      ["docs/configuration.md", "verify"],
    ]);
    expect(c[0]!.rules).toEqual(["undocumented_env_var"]);
    expect(c[0]!.missingContext.join(" ")).toContain("`NEW_FLAG`");
  });

  it("keeps a doc tied only to an unanalyzed patch at verify and says why", () => {
    const r = runScenario(byId("patch-unavailable"));
    expect(r.missingContext).toEqual([
      "The patch for src/server.ts was not available, so its content changes were not analyzed.",
    ]);
    expect(r.candidates[0]).toMatchObject({
      docPath: "docs/deployment.md",
      status: "verify",
    });
    expect(r.candidates[0]!.missingContext).toEqual([
      "The patch for src/server.ts was not available; check the change by hand.",
    ]);
  });

  it("does not flag unrelated docs, docs for internal refactors, or docs the PR edits", () => {
    expect(runScenario(byId("internal-refactor")).candidates).toEqual([]);
    const docsOnly = runScenario(byId("docs-only"));
    expect(docsOnly.candidates).toEqual([]);
    expect(docsOnly.docsChangedInPr).toEqual(["docs/guide.md"]);
  });

  it("handles the impact-v2 regression scenarios", () => {
    // M4: dependency bumps, versions and CI workflow keys are not doc signals.
    expect(statusOf(byId("dependency-bump"), "docs/install.md")).toBe(
      "not_flagged",
    );
    expect(statusOf(byId("workflow-yaml-changed"), "docs/dev.md")).toBe(
      "not_flagged",
    );
    // M3: the PR documents its own new env var, so nothing is "undocumented".
    expect(runScenario(byId("self-documented-env-var")).candidates).toEqual([]);
    // M6: fixing a typo in a doc does not flag docs that link to it.
    expect(runScenario(byId("linked-doc-edited")).candidates).toEqual([]);
    // L1: block state resets per hunk; a scripts header out of view still works.
    expect(
      statusOf(byId("package-json-multi-hunk"), "docs/contributing.md"),
    ).toBe("not_flagged");
    expect(statusOf(byId("package-json-multi-hunk"), "README.md")).toBe(
      "likely_affected",
    );
    expect(statusOf(byId("scripts-header-out-of-view"), "README.md")).toBe(
      "likely_affected",
    );
    // L2: the root route matches nothing; dynamic segments match across notations.
    expect(statusOf(byId("root-route-removed"), "docs/links.md")).toBe(
      "not_flagged",
    );
    expect(statusOf(byId("dynamic-route-changed"), "docs/api.md")).toBe(
      "verify",
    );
  });

  it("is not influenced by instructions embedded in docs", () => {
    const s = byId("injection-in-doc");
    const clean: Scenario = {
      ...s,
      docs: {
        ...s.docs,
        "docs/configuration.md": s.docs["docs/configuration.md"]!.replace(
          /<!--[^>]*-->/,
          "<!-- note -->",
        ),
      },
    };
    const strip = (r: ReturnType<typeof runScenario>) =>
      r.candidates.map((c) => [c.docPath, c.status, c.rankPoints, c.rules]);
    expect(strip(runScenario(s))).toEqual(strip(runScenario(clean)));
    expect(statusOf(s, "docs/configuration.md")).toBe("likely_affected");
  });

  it("reproduces the known false positive (generic word) and false negative (behaviour only)", () => {
    // Documented blind spots of the deterministic baseline; see docs/evaluation/impact-baseline.md.
    expect(
      statusOf(byId("false-positive-generic-word"), "docs/contributing.md"),
    ).toBe("verify");
    expect(statusOf(byId("false-negative-behaviour"), "docs/api.md")).toBe(
      "not_flagged",
    );
  });

  it("never describes points as probability or confidence", () => {
    for (const s of scenarios) {
      for (const c of runScenario(s).candidates) {
        expect(c.reason).not.toMatch(/%|probab|confiden|likelihood/i);
      }
    }
  });
});

describe("analyzeImpact rules", () => {
  it("doubles points for removed references and applies the thresholds", () => {
    const snap = snapshot([
      file("src/a.ts", [
        "-export function oldName() {}",
        "+export function newName() {}",
      ]),
    ]);
    const docs = [
      { path: "docs/a.md", content: "Call oldName()." },
      { path: "docs/b.md", content: "Call newName()." },
    ];
    const { candidates } = analyzeImpact(snap, docs);
    const a = candidates.find((c) => c.docPath === "docs/a.md")!;
    const b = candidates.find((c) => c.docPath === "docs/b.md")!;
    expect(a).toMatchObject({
      rankPoints: 6,
      status: "likely_affected",
      rules: ["import_export_removed"],
    });
    expect(b).toMatchObject({
      rankPoints: 3,
      status: "verify",
      rules: ["import_export_added"],
    });
    // Ordered by points, then path.
    expect(candidates.map((c) => c.docPath)).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
  });

  it("reports unlikely_affected below the verify threshold", () => {
    const snap = snapshot([file("src/a.ts", ["+export function helper() {}"])]);
    const { candidates } = analyzeImpact(
      snap,
      [{ path: "docs/a.md", content: "helper" }],
      {
        ...DEFAULT_CONFIG,
        verifyThreshold: 10,
        likelyThreshold: 20,
      },
    );
    expect(candidates[0]).toMatchObject({
      status: "unlikely_affected",
      rankPoints: 3,
    });
  });

  it("ignores symbols shorter than the minimum length", () => {
    const snap = snapshot([file("src/a.ts", ["-export const id = 1;"])]);
    expect(
      analyzeImpact(snap, [{ path: "docs/a.md", content: "The id field." }])
        .candidates,
    ).toEqual([]);
  });

  it("keeps likely_affected when the analyzed evidence alone reaches it, but notes the gap", () => {
    const snap = snapshot([
      {
        ...file("src/big.ts", []),
        hunks: [],
        patchState: "too_large",
        additions: 400,
        deletions: 10,
      },
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patchState: "omitted",
        hunks: [],
      },
    ]);
    const docs = [
      { path: "docs/a.md", content: "See src/old.ts and src/big.ts." },
    ];
    const c = analyzeImpact(snap, docs).candidates[0]!;
    expect(c.rankPoints).toBe(9); // removed path 6 (analyzed) + modified path 3 (blind)
    expect(c.status).toBe("likely_affected");
    expect(c.rules).not.toContain("patch_unavailable_cap");
    expect(c.missingContext).toEqual([
      "The patch for src/big.ts was not available; check the change by hand.",
    ]);
  });

  it("caps at verify when likely_affected depends on unanalyzed evidence, listing the cap rule first", () => {
    const snap = snapshot([
      {
        ...file("src/big.ts", []),
        hunks: [],
        patchState: "too_large",
        additions: 400,
        deletions: 10,
      },
      file("src/a.ts", ["+export function helper() {}"]),
    ]);
    const c = analyzeImpact(snap, [
      { path: "docs/a.md", content: "See src/big.ts and helper()." },
    ]).candidates[0]!;
    expect(c.rankPoints).toBe(6); // 3 blind + 3 analyzed: analyzed alone is below 6
    expect(c.status).toBe("verify");
    expect(c.rules[0]).toBe("patch_unavailable_cap");
  });

  it("puts the strongest hit first in evidence and reason", () => {
    const names = Array.from({ length: 8 }, (_, i) => `ADDED_${i}`);
    const snap = snapshot([
      file("src/a.ts", [
        ...names.map((n) => `+const v${n} = process.env.${n};`),
        "-const old = process.env.ZZ_REMOVED;",
      ]),
    ]);
    const c = analyzeImpact(snap, [
      { path: "docs/a.md", content: [...names, "ZZ_REMOVED"].join(" ") },
    ]).candidates[0]!;
    expect(c.reason.startsWith("Mentions `ZZ_REMOVED` (env var removed")).toBe(
      true,
    );
    expect(c.evidence[0]).toMatchObject({
      excerpt: "const old = process.env.ZZ_REMOVED;",
    });
    expect(c.evidence[1]).toMatchObject({
      sourcePath: "docs/a.md",
      side: "head",
    });
  });

  it("never throws on long paths or names and bounds every message", () => {
    const longPath = `src/${"a".repeat(450)}.ts`;
    const longVar = `V${"X".repeat(2000)}`;
    const snap = snapshot([
      {
        ...file(longPath, []),
        hunks: [],
        patchState: "too_large",
        additions: 5,
      },
      file("src/b.ts", [`+const x = process.env.${longVar};`]),
    ]);
    const r = analyzeImpact(snap, [
      { path: "README.md", content: `# Demo ${longPath}` },
    ]);
    for (const m of r.missingContext) expect(m.length).toBeLessThanOrEqual(500);
    for (const c of r.candidates) {
      expect(impactCandidateSchema.safeParse(c).success).toBe(true);
      for (const m of c.missingContext)
        expect(m.length).toBeLessThanOrEqual(500);
    }
  });

  it("does not throw when an excerpt cut would split an emoji", () => {
    const snap = snapshot([file("src/a.ts", ["-export const handler = 1;"])]);
    const line = "handler " + "x".repeat(291) + "\u{1F600}tail";
    const c = analyzeImpact(snap, [{ path: "docs/a.md", content: line }])
      .candidates[0]!;
    const docEv = c.evidence.find((e) => e.sourcePath === "docs/a.md")!;
    expect(docEv.excerpt!.length).toBe(299);
    expect(docEv.excerpt!.isWellFormed()).toBe(true);
  });

  it("reports truncated and rejected files instead of implying no impact", () => {
    const snap = {
      ...snapshot([]),
      filesTruncated: true,
      rejectedFiles: [
        { index: 0, reason: "invalid_path" as const },
        { index: 3, reason: "invalid_entry" as const },
      ],
    };
    const r = analyzeImpact(snap, [{ path: "README.md", content: "x" }]);
    expect(r.candidates).toEqual([]);
    expect(r.missingContext).toEqual([
      "The PR changes more files than the analysis limit; only the first 300 were analyzed, so affected docs may be missing.",
      "2 changed file(s) were rejected (unsafe or invalid entries) and not analyzed.",
    ]);
  });

  it("caps the number of signals matched and says so", () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `+export const name${i} = ${i};`,
    );
    const r = analyzeImpact(snapshot([file("src/a.ts", lines)]), [], {
      ...DEFAULT_CONFIG,
      maxSignals: 10,
    });
    // 40 exports + 1 path signal = 41 eligible signals.
    expect(r.missingContext).toEqual([
      "41 signals were extracted; only the first 10 were matched against docs.",
    ]);
  });

  it("falls back to README.md for an undocumented env var when no doc lists env vars", () => {
    const snap = snapshot([
      file("src/a.ts", ["+const x = process.env.BRAND_NEW;"]),
    ]);
    const docs = [
      { path: "README.md", content: "# Demo" },
      { path: "docs/other.md", content: "Nothing relevant." },
    ];
    const c = analyzeImpact(snap, docs).candidates;
    expect(c.map((x) => [x.docPath, x.status, x.rules])).toEqual([
      ["README.md", "verify", ["undocumented_env_var_readme_fallback"]],
    ]);
    // Honest wording: README lists nothing related; it is only the default place.
    expect(c[0]!.reason).toContain("README.md is the default place");
    expect(c[0]!.reason).not.toContain("Lists env vars");
  });

  it("never reaches likely_affected without a line of the doc as evidence", () => {
    const snap = snapshot([
      file("src/a.ts", [
        "+const a = process.env.ONE_NEW;",
        "+const b = process.env.TWO_NEW;",
      ]),
    ]);
    const c = analyzeImpact(snap, [{ path: "README.md", content: "# Demo" }])
      .candidates[0]!;
    expect(c.rankPoints).toBe(6);
    expect(c.status).toBe("verify");
    expect(c.rules[0]).toBe("no_doc_evidence_cap");
    expect(c.evidence.some((e) => e.sourcePath === "README.md")).toBe(false);
  });

  it("matches renames and deletions before additions when signals are capped", () => {
    const many = Array.from(
      { length: 310 },
      (_, i) => `+export const a${String(i).padStart(3, "0")} = 1;`,
    );
    const snap = snapshot([
      file("src/big.ts", many),
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patchState: "omitted",
        hunks: [],
      },
    ]);
    const r = analyzeImpact(snap, [
      { path: "docs/a.md", content: "See src/old.ts" },
    ]);
    expect(r.candidates.map((c) => [c.docPath, c.rules])).toEqual([
      ["docs/a.md", ["path_change_removed"]],
    ]);
    expect(r.missingContext[0]).toMatch(/only the first 300 were matched/);
  });

  it("rejects duplicate doc paths", () => {
    const snap = snapshot([file("src/a.ts", ["-export const zzz = 1;"])]);
    expect(() =>
      analyzeImpact(snap, [
        { path: "a.md", content: "zzz" },
        { path: "a.md", content: "x\nzzz" },
      ]),
    ).toThrow();
  });

  it("writes untrusted names into the reason as plain text only", () => {
    const evil = "fix`;\u202Erun\u200Bme";
    const snap = snapshot([
      file("package.json", ['   "scripts": {', `-    "${evil}": "x",`]),
    ]);
    const c = analyzeImpact(snap, [
      { path: "README.md", content: `npm run ${evil}` },
    ]).candidates[0]!;
    expect(c.reason).not.toMatch(/[\u202E\u200B]/u);
    expect(c.reason).toContain("Mentions `fix???run?me`");
    // Quoted evidence stays byte-exact.
    expect(c.evidence.find((e) => e.sourcePath === "README.md")!.excerpt).toBe(
      `npm run ${evil}`,
    );
  });

  it("skips docs past the total size budget and says so", () => {
    const snap = snapshot([file("src/a.ts", ["-export const zzz = 1;"])]);
    const r = analyzeImpact(
      snap,
      [
        { path: "a.md", content: "zzz " + "x".repeat(50) },
        { path: "b.md", content: "zzz " + "x".repeat(50) },
      ],
      { ...DEFAULT_CONFIG, maxTotalDocChars: 60 },
    );
    expect(r.candidates.map((c) => c.docPath)).toEqual(["a.md"]);
    expect(r.missingContext).toContain(
      "1 doc(s) were not analyzed because the documentation exceeds the size budget.",
    );
  });

  it("stops matching when the work budget is spent and says so", () => {
    const snap = snapshot([
      file("src/a.ts", [
        "-export const alpha = 1;",
        "-export const omega = 2;",
      ]),
    ]);
    const content = ["alpha", ...Array(50).fill("filler"), "omega"].join("\n");
    const r = analyzeImpact(snap, [{ path: "a.md", content }], {
      ...DEFAULT_CONFIG,
      maxLineScans: 60, // one scan of the 52-line doc fits, the second does not
    });
    expect(r.candidates[0]!.rules).toEqual(["import_export_removed"]);
    expect(r.missingContext).toContain(
      "The matching work budget (60 doc lines) was used up; some signals were not checked against every doc.",
    );
  });

  it("caps evidence per candidate", () => {
    const names = Array.from({ length: 20 }, (_, i) => `NAME_${i}`);
    const snap = snapshot([
      file(
        "src/a.ts",
        names.map((n) => `-const v${n} = process.env.${n};`),
      ),
    ]);
    const c = analyzeImpact(snap, [
      { path: "docs/a.md", content: names.join(" ") },
    ]).candidates[0]!;
    expect(c.evidence.length).toBe(DEFAULT_CONFIG.maxEvidencePerCandidate);
    expect(c.reason).toContain("and 17 more");
  });

  it("validates the docs it is given", () => {
    const snap = snapshot([]);
    expect(() =>
      analyzeImpact(snap, [{ path: "../etc/passwd", content: "" }]),
    ).toThrow();
    expect(() =>
      analyzeImpact(snap, [{ path: "a.md", content: "nul\u0000" }]),
    ).toThrow();
    const many = Array.from({ length: DOC_LIMITS.maxDocs + 1 }, (_, i) => ({
      path: `d${i}.md`,
      content: "",
    }));
    expect(() => analyzeImpact(snap, many)).toThrow();
  });
});

describe("engine module boundaries", () => {
  it("does not import Next.js, server-only, database, GitHub or model code", () => {
    const dir = "src/lib/impact-engine";
    for (const f of readdirSync(dir).filter(
      (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
    )) {
      const src = readFileSync(path.join(dir, f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${f} imports ${spec}`).toMatch(
          /^(\.\/|zod$|node:path$|@\/lib\/schemas$|@\/lib\/diff-analyzer\/normalize$)/,
        );
      }
    }
  });
});
