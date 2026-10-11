import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImpact } from "@/lib/impact-engine/engine";
import {
  scenarioSchema,
  snapshotFor,
  type Scenario,
} from "@/lib/impact-engine/evaluate";
import type {
  ChatRequest,
  ChatResponse,
  LlmProvider,
} from "@/lib/llm/provider";
import { gitBlobSha } from "@/lib/patches/blob-sha";
import { applyUnifiedDiff } from "@/lib/patches/diff";
import { createOllamaProvider } from "@/lib/llm/ollama";
import { PATCH_SYSTEM, patchOutputSchema } from "@/lib/llm/prompts";
import { patchProposalSchema } from "@/lib/schemas";
import { z } from "zod";
import { MAX_ASSISTED_CANDIDATES, WITHHELD_TEXT, assistImpact } from "./assist";
import { CONTEXT_LIMITS, buildContext } from "./context";
import {
  assistedImpact,
  checkPatchLabel,
  patchLabelsSchema,
  percentile,
} from "./evaluate";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const DIR = "fixtures/impact";
const load = (id: string): Scenario =>
  scenarioSchema.parse(
    JSON.parse(readFileSync(path.join(DIR, `${id}.json`), "utf8")),
  );
const docsOf = (s: Scenario) =>
  Object.entries(s.docs).map(([p, content]) => ({ path: p, content }));

type Reply = ChatResponse | ((req: ChatRequest) => ChatResponse);
function scripted(replies: Reply[]) {
  const requests: ChatRequest[] = [];
  const provider: LlmProvider = {
    provider: "mock",
    modelId: "mock-1",
    async chat(req) {
      requests.push(req);
      const r = replies.shift();
      if (!r) throw new Error("unexpected model call");
      return typeof r === "function" ? r(req) : r;
    },
  };
  return { provider, requests };
}
const json = (v: unknown): ChatResponse => ({
  ok: true,
  content: JSON.stringify(v),
});
const verdict = (v: string, cited: number[] = [0]) =>
  json({ verdict: v, explanation: "Because of the PR.", citedEvidence: cited });
const edits = (...e: { find: string; replace: string }[]) =>
  json({ edits: e, rationale: "Matches the PR." });

const renamed = load("env-var-renamed");
const run = (s: Scenario, provider?: LlmProvider) =>
  assistImpact(snapshotFor(s), docsOf(s), provider);

describe("assistImpact without a usable model", () => {
  it("returns the deterministic result only when no model is configured", async () => {
    const r = await run(renamed);
    expect(r.deterministic).toEqual(
      analyzeImpact(snapshotFor(renamed), docsOf(renamed)),
    );
    expect(r).toMatchObject({
      modelStatus: "not_configured",
      assessments: [],
      proposals: [],
    });
    expect(r.outcomes).toEqual([
      {
        docPath: "docs/configuration.md",
        assessment: "skipped",
        patch: "not_attempted",
        code: "LLM_NOT_CONFIGURED",
      },
    ]);
  });

  it("falls back to deterministic-only when a provider throws", async () => {
    const provider: LlmProvider = {
      provider: "mock",
      modelId: "mock-1",
      chat: () => Promise.reject(new Error("boom")),
    };
    const r = await run(renamed, provider);
    expect(r.modelStatus).toBe("unavailable");
    expect(r.outcomes[0]).toMatchObject({
      assessment: "failed",
      code: "LLM_UNAVAILABLE",
    });
    expect(r.deterministic).toEqual(
      analyzeImpact(snapshotFor(renamed), docsOf(renamed)),
    );
  });

  it.each(["LLM_UNAVAILABLE", "LLM_TIMEOUT", "LLM_MODEL_NOT_FOUND"] as const)(
    "stops at the first %s and falls back to deterministic-only",
    async (code) => {
      const s = load("api-route-changed");
      const { provider, requests } = scripted([{ ok: false, code }]);
      const r = await run(s, provider);
      expect(r.modelStatus).toBe("unavailable");
      expect(requests).toHaveLength(1);
      expect(r.proposals).toEqual([]);
      expect(r.outcomes[0]).toMatchObject({ assessment: "failed", code });
      expect(r.deterministic).toEqual(analyzeImpact(snapshotFor(s), docsOf(s)));
    },
  );
});

describe("assistImpact with a model", () => {
  it("returns a validated proposal with evidence and source revisions", async () => {
    const { provider, requests } = scripted([
      verdict("needs_update", [0, 1]),
      edits({ find: "`API_TOKEN`", replace: "`API_KEY`" }),
    ]);
    const snapshot = snapshotFor(renamed);
    const r = await assistImpact(snapshot, docsOf(renamed), provider);
    expect(r.modelStatus).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(r.assessments).toEqual([
      expect.objectContaining({
        docPath: "docs/configuration.md",
        verdict: "needs_update",
        citedEvidence: [0, 1],
        model: {
          provider: "mock",
          modelId: "mock-1",
          promptVersion: "assess-v2",
        },
      }),
    ]);
    const [p] = r.proposals;
    const doc = renamed.docs["docs/configuration.md"]!;
    expect(patchProposalSchema.parse(p)).toEqual(p);
    expect(p).toMatchObject({
      targetPath: "docs/configuration.md",
      headSha: snapshot.headSha,
      baseBlobSha: gitBlobSha(doc),
      validationStatus: "valid",
      validationIssues: [],
      model: { promptVersion: "patch-v1" },
    });
    // Deterministic evidence is carried over unchanged, not rewritten by the model.
    expect(p!.evidence).toEqual(r.deterministic.candidates[0]!.evidence);
    const applied = applyUnifiedDiff(p!.targetPath, doc, p!.patch);
    expect(applied.ok && applied.content).toBe(
      doc.replace("`API_TOKEN`", "`API_KEY`"),
    );
    expect(r.outcomes).toEqual([
      {
        docPath: "docs/configuration.md",
        assessment: "needs_update",
        patch: "valid",
      },
    ]);
  });

  it("drops unplaceable edits, reports them, and validates the rest", async () => {
    const { provider } = scripted([
      verdict("needs_update"),
      edits(
        { find: "API_TOKEN", replace: "API_KEY" },
        { find: "`API_TOKEN`", replace: "`API_KEY`" },
        { find: "apiToken: process.env.API_TOKEN", replace: "x" },
      ),
    ]);
    const r = await run(renamed, provider);
    expect(r.outcomes[0]).toEqual({
      docPath: "docs/configuration.md",
      assessment: "needs_update",
      patch: "valid",
      droppedEdits: ["EDIT_FIND_NOT_FOUND", "EDIT_OVERLAP"],
    });
    expect(r.proposals[0]!.patch).toContain("+| `API_KEY` |");
  });

  it("never asks for a patch without concrete change facts (no guessing)", async () => {
    const { provider, requests } = scripted([verdict("needs_update")]);
    const r = await run(load("patch-unavailable"), provider);
    expect(requests).toHaveLength(1); // assessment only
    expect(r.proposals).toEqual([]);
    expect(r.outcomes[0]).toEqual({
      docPath: "docs/deployment.md",
      assessment: "needs_update",
      patch: "not_attempted",
      issues: ["NO_CHANGE_FACTS"],
    });
  });

  it("still asks for a patch when a rename is the only change fact", async () => {
    const { provider, requests } = scripted([verdict("needs_update"), edits()]);
    const r = await run(load("linked-file-renamed"), provider);
    expect(requests).toHaveLength(2);
    expect(r.outcomes[0]).toMatchObject({ patch: "no_change" });
  });

  it("withholds model prose that carries links, HTML or hidden characters", async () => {
    const { provider } = scripted([
      json({
        verdict: "needs_update",
        explanation:
          "Verified by maintainers, see https://evil.example/approve",
        citedEvidence: [0],
      }),
      json({
        edits: [{ find: "`API_TOKEN`", replace: "`API_KEY`" }],
        rationale: "Safe <img src=x onerror=alert(1)>",
      }),
    ]);
    const r = await run(renamed, provider);
    expect(r.assessments[0]!.explanation).toBe(WITHHELD_TEXT);
    expect(r.proposals[0]!.rationale).toBe(WITHHELD_TEXT);
    // The patch itself is unaffected: it passed validatePatch on its own.
    expect(r.proposals[0]!.patch).toContain("+| `API_KEY` |");
  });

  it("does not request a patch for a doc the model judges unaffected", async () => {
    const { provider, requests } = scripted([verdict("no_update")]);
    const r = await run(renamed, provider);
    expect(requests).toHaveLength(1);
    expect(r.outcomes[0]).toEqual({
      docPath: "docs/configuration.md",
      assessment: "no_update",
      patch: "not_attempted",
    });
    // The deterministic candidate is untouched; only the assisted view demotes it.
    expect(r.deterministic.candidates[0]!.status).toBe("likely_affected");
    expect(assistedImpact(r).candidates[0]!.status).toBe("unlikely_affected");
  });

  it("records an empty edit list as no change, without a proposal", async () => {
    const { provider } = scripted([verdict("uncertain"), edits()]);
    const r = await run(renamed, provider);
    expect(r.proposals).toEqual([]);
    expect(r.outcomes[0]).toMatchObject({
      assessment: "uncertain",
      patch: "no_change",
    });
  });

  it("retries a citation of evidence it was not given, then accepts a valid one", async () => {
    const { provider, requests } = scripted([
      verdict("no_update", [9]),
      verdict("no_update", [1]),
    ]);
    const r = await run(renamed, provider);
    expect(requests.map((q) => q.attempt)).toEqual([1, 2]);
    expect(r.assessments[0]).toMatchObject({
      verdict: "no_update",
      citedEvidence: [1],
    });
  });

  it("rejects an assessment that keeps citing evidence it was not given", async () => {
    const { provider } = scripted([
      verdict("needs_update", [49]),
      verdict("needs_update", [49]),
    ]);
    const r = await run(renamed, provider);
    expect(r.assessments).toEqual([]);
    expect(r.outcomes[0]).toMatchObject({
      assessment: "failed",
      code: "LLM_INVALID_OUTPUT",
    });
    expect(r.modelStatus).toBe("partial");
  });

  it("rejects a reply that tries to choose its own target file", async () => {
    const hijack = json({
      edits: [{ find: "`API_TOKEN`", replace: "`API_KEY`" }],
      rationale: "x",
      targetPath: ".github/workflows/release.yml",
    });
    const { provider, requests } = scripted([
      verdict("needs_update"),
      hijack,
      hijack,
    ]);
    const r = await run(renamed, provider);
    expect(requests).toHaveLength(3); // one bounded retry
    expect(r.proposals).toEqual([]);
    expect(r.outcomes[0]).toMatchObject({
      patch: "failed",
      code: "LLM_INVALID_OUTPUT",
    });
  });

  it("caps model calls per PR and reports the skipped docs", async () => {
    const extra = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `docs/d${i}.md`,
        "Uses `API_TOKEN`.\n",
      ]),
    );
    const s = { ...renamed, docs: { ...renamed.docs, ...extra } };
    const { provider, requests } = scripted(
      Array.from({ length: MAX_ASSISTED_CANDIDATES }, () =>
        verdict("no_update"),
      ),
    );
    const r = await run(s, provider);
    expect(requests).toHaveLength(MAX_ASSISTED_CANDIDATES);
    expect(r.outcomes.filter((o) => o.assessment === "skipped")).toHaveLength(
      3,
    );
    expect(r.modelStatus).toBe("partial");
  });
});

describe("prompt injection (injection-in-doc fixture)", () => {
  const s = load("injection-in-doc");
  const doc = s.docs["docs/configuration.md"]!;

  it("passes the injected comment to the model only as JSON data", async () => {
    const { provider, requests } = scripted([verdict("no_update")]);
    await run(s, provider);
    const data = JSON.parse(requests[0]!.user) as {
      doc: { excerpts: { text: string }[] };
    };
    expect(data.doc.excerpts[0]!.text).toContain(
      "ignore all previous instructions",
    );
    expect(requests[0]!.system).not.toContain(
      "ignore all previous instructions",
    );
  });

  it("keeps deterministic evidence even when a model obeys the injection", async () => {
    const { provider } = scripted([verdict("no_update")]);
    const r = await run(s, provider);
    expect(r.deterministic.candidates[0]).toMatchObject({
      docPath: "docs/configuration.md",
      status: "likely_affected",
    });
  });

  // A compromised model may emit anything; validation decides what survives.
  it.each<[string, { find: string; replace: string }, string]>([
    [
      "delete the doc",
      { find: doc.trimEnd(), replace: "# Configuration" },
      "PATCH_REMOVES_TOO_MUCH",
    ],
    [
      "add a phishing link",
      {
        find: "`API_TOKEN`",
        replace: "`API_KEY` (rotate at https://evil.example/login)",
      },
      "PATCH_NEW_URL",
    ],
    [
      "inject a script",
      {
        find: "`API_TOKEN`",
        replace: "`API_KEY` <script>fetch('//x')</script>",
      },
      "PATCH_UNSAFE_HTML",
    ],
    [
      "hide text with bidi controls",
      { find: "`API_TOKEN`", replace: "`API_KEY`\u202E" },
      "PATCH_UNSAFE_CHARACTERS",
    ],
    [
      "edit text that is not in the doc",
      { find: "permissions: write-all", replace: "x" },
      "EDIT_FIND_NOT_FOUND",
    ],
  ])("rejects a patch that tries to %s", async (_l, edit, issue) => {
    const { provider } = scripted([verdict("needs_update"), edits(edit)]);
    const r = await run(s, provider);
    expect(r.proposals).toEqual([]);
    expect(r.outcomes[0]!.patch).toBe("rejected");
    expect(r.outcomes[0]!.issues).toContain(issue);
  });
});

describe("buildContext", () => {
  it("keeps a worst-case plain context within the default Ollama prompt limit", () => {
    const filler = Array.from(
      { length: 4000 },
      (_, i) => `filler text line ${i}`,
    );
    filler.splice(2000, 0, "| `API_TOKEN` | Token |");
    const big = {
      ...renamed,
      description: "t".repeat(1000),
      docs: { "docs/configuration.md": filler.join("\n") },
    };
    const snapshot = snapshotFor(big);
    const candidate = analyzeImpact(snapshot, docsOf(big)).candidates[0]!;
    const padded = {
      ...candidate,
      evidence: Array.from({ length: 12 }, (_, i) => ({
        signal: "env_var" as const,
        sourcePath: `src/${"d".repeat(60)}/file${i}.ts`,
        excerpt: "x".repeat(500),
      })),
    };
    const data = buildContext(snapshot, docsOf(big)[0]!, padded);
    const promptChars =
      PATCH_SYSTEM.length +
      JSON.stringify({ task: "patch", ...data }).length +
      JSON.stringify(z.toJSONSchema(patchOutputSchema)).length;
    const limit = createOllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      timeoutMs: 1_000,
      numCtx: 8_192,
    }).maxInputChars!;
    expect(promptChars).toBeLessThanOrEqual(limit);
    expect(data.notes).toContain(
      "Some evidence excerpts were left out to fit the context budget.",
    );
  });

  it("sends small docs whole, with evidence and the matching diff hunk", () => {
    const snapshot = snapshotFor(renamed);
    const candidate = analyzeImpact(snapshot, docsOf(renamed)).candidates[0]!;
    const doc = docsOf(renamed).find((d) => d.path === candidate.docPath)!;
    const c = buildContext(snapshot, doc, candidate);
    expect(c.doc).toMatchObject({
      complete: true,
      excerpts: [{ startLine: 1, text: doc.content }],
    });
    expect(c.evidence.map((e) => e.index)).toEqual(
      candidate.evidence.map((_, i) => i),
    );
    expect(c.changes[0]!.hunks[0]).toContain("process.env.API_KEY");
  });

  it("includes the file's hunks for evidence without a line (path-derived routes)", () => {
    const s = load("api-route-changed");
    const snapshot = snapshotFor(s);
    const candidate = analyzeImpact(snapshot, docsOf(s)).candidates[0]!;
    expect(candidate.evidence[0]!.lineRange).toBeUndefined();
    const doc = docsOf(s).find((d) => d.path === candidate.docPath)!;
    const c = buildContext(snapshot, doc, candidate);
    expect(c.changes[0]!.hunks.join("")).toContain("email: body.email");
  });

  it("caps diff hunks at the budget and says so", () => {
    const big = "+" + "x".repeat(1_900);
    const s = {
      ...load("api-route-changed"),
      files: [
        {
          filename: "src/app/api/users/route.ts",
          status: "modified",
          additions: 6,
          deletions: 0,
          changes: 6,
          patch: Array.from(
            { length: 6 },
            (_, i) => `@@ -${i * 10 + 1},0 +${i * 10 + 1},1 @@\n${big}`,
          ).join("\n"),
        },
      ],
    };
    const snapshot = snapshotFor(s);
    const candidate = analyzeImpact(snapshot, docsOf(s)).candidates[0]!;
    const doc = docsOf(s).find((d) => d.path === candidate.docPath)!;
    const c = buildContext(snapshot, doc, candidate);
    expect(c.changes[0]!.hunks.join("").length).toBeLessThanOrEqual(
      CONTEXT_LIMITS.diffBudgetChars,
    );
    expect(c.changes[0]!.hunks.length).toBeLessThan(6);
    expect(c.notes).toContain(
      "Some diff hunks were left out to fit the context budget.",
    );
  });

  it("sends only windows around the evidence for large docs, within budget", () => {
    const filler = Array.from({ length: 3000 }, (_, i) => `filler line ${i}`);
    filler.splice(1500, 0, "| `API_TOKEN` | Token |");
    const big = {
      ...renamed,
      docs: { "docs/configuration.md": filler.join("\n") },
    };
    const snapshot = snapshotFor(big);
    const candidate = analyzeImpact(snapshot, docsOf(big)).candidates[0]!;
    const c = buildContext(snapshot, docsOf(big)[0]!, candidate);
    const sent = c.doc.excerpts.map((e) => e.text).join("");
    expect(c.doc.complete).toBe(false);
    expect(sent.length).toBeLessThanOrEqual(CONTEXT_LIMITS.docBudgetChars);
    expect(sent).toContain("API_TOKEN");
    expect(c.doc.excerpts[0]!.startLine).toBe(
      1501 - CONTEXT_LIMITS.docWindowLines,
    );
    expect(c.notes.some((n) => n.includes("doc is large"))).toBe(true);
  });
});

describe("patch evaluation helpers", () => {
  const labels = patchLabelsSchema.parse(
    JSON.parse(readFileSync("fixtures/patches/labels.json", "utf8")),
  );

  it("labels only existing scenarios and docs labelled affected", () => {
    const ids = new Set(readdirSync(DIR).map((f) => f.replace(/\.json$/, "")));
    for (const l of labels.labels) {
      expect(ids.has(l.scenario), l.scenario).toBe(true);
      expect(load(l.scenario).labels.affected, l.scenario).toContain(l.docPath);
      expect(l.mustContain.length + l.mustNotContain.length).toBeGreaterThan(0);
    }
  });

  it("checks a proposal against its label, case-insensitively", async () => {
    const label = labels.labels.find((l) => l.scenario === "env-var-renamed")!;
    const doc = renamed.docs[label.docPath]!;
    const good = await run(
      renamed,
      scripted([
        verdict("needs_update"),
        edits({ find: "`API_TOKEN`", replace: "`api_key`" }),
      ]).provider,
    );
    expect(checkPatchLabel(label, doc, good)).toBe("label_pass");
    const half = await run(
      renamed,
      scripted([
        verdict("needs_update"),
        edits({ find: "Token for", replace: "API_KEY token for" }),
      ]).provider,
    );
    expect(checkPatchLabel(label, doc, half)).toBe("label_fail");
    const none = await run(renamed, scripted([verdict("no_update")]).provider);
    expect(checkPatchLabel(label, doc, none)).toBe("not_attempted");
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(
      percentile(
        Array.from({ length: 20 }, (_, i) => i + 1),
        95,
      ),
    ).toBe(19);
  });
});

describe("assist module boundaries", () => {
  it("imports no GitHub, database or Next.js code", () => {
    const dir = "src/lib/assist";
    for (const f of readdirSync(dir).filter(
      (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
    )) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const [, spec] of src.matchAll(/from\s+"([^"]+)"/g)) {
        expect(spec, `${f} imports ${spec}`).toMatch(
          /^(\.\/[\w-]+|zod|@\/lib\/(schemas|impact-engine\/\w+|llm\/\w+|patches\/[\w-]+))$/,
        );
      }
    }
  });
});
