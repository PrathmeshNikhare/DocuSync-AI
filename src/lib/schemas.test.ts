import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  LIMITS,
  analysisStateSchema,
  apiErrorSchema,
  canTransitionAnalysis,
  evidenceReferenceSchema,
  gitShaSchema,
  impactCandidateSchema,
  modelAssessmentSchema,
  patchProposalSchema,
  repoPathSchema,
  reviewDecisionInputSchema,
  reviewDecisionRecordSchema,
} from "./schemas";

const UUID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const SHA1 = "a".repeat(40);
const T0 = "2026-10-10T00:00:00Z";
const T1 = "2026-10-10T00:05:00Z";

/** Asserts rejection and that an issue points at `path` ("" = the root value). */
function expectInvalid(schema: z.ZodType, value: unknown, path: string) {
  const r = schema.safeParse(value);
  expect(r.success).toBe(false);
  expect(r.error?.issues.map((i) => i.path.join("."))).toContain(path);
}

function expectValid(schema: z.ZodType, value: unknown) {
  const r = schema.safeParse(value);
  expect(r.error?.issues ?? []).toEqual([]);
}

const evidence = {
  signal: "env_var",
  sourcePath: "src/config.ts",
  lineRange: { start: 10, end: 12 },
  excerpt: "process.env.NEW_FLAG",
} as const;

const candidate = {
  docPath: "docs/configuration.md",
  status: "likely_affected",
  reason: "New environment variable NEW_FLAG is not documented.",
  evidence: [evidence],
  missingContext: [],
  engineVersion: "0.1.0",
  rankPoints: 8,
  rules: ["env_var_added"],
} as const;

const proposal = {
  candidateId: UUID,
  targetPath: "docs/configuration.md",
  headSha: "b".repeat(40),
  baseBlobSha: SHA1,
  patch: "@@ -1 +1,2 @@\n # Config\n+NEW_FLAG enables x.\n",
  rationale: "Documents the new flag.",
  evidence: [evidence],
  validationStatus: "pending",
  validationIssues: [],
  model: { provider: "ollama", modelId: "llama3", promptVersion: "p1" },
} as const;

describe("repoPathSchema", () => {
  it.each([
    "README.md",
    "docs/api/routes.md",
    ".github/workflows/ci.yml",
    ".env.example",
    "docs/naïve-ünïcode.md",
  ])("accepts %s", (p) => expectValid(repoPathSchema, p));

  it.each([
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["drive letter", "C:/docs/a.md"],
    ["alternate data stream", "docs/a.md:hidden"],
    ["backslash", "docs\\a.md"],
    ["parent traversal", "../secrets.md"],
    ["embedded traversal", "docs/../../a.md"],
    ["dot segment", "./docs/a.md"],
    ["empty segment", "docs//a.md"],
    ["trailing slash", "docs/"],
    ["trailing-dot segment", "docs/..."],
    ["trailing-space segment", "docs/.. /a.md"],
    ["NUL byte", "docs/a.md\u0000.png"],
    ["newline", "docs/a\n.md"],
    ["C1 control", "docs/a\u0085.md"],
    ["bidi override", "docs/\u202Edm.exe"],
    ["zero-width space", "docs/a\u200B.md"],
    ["lone surrogate", "docs/\uD800.md"],
    ["line separator", "docs/a\u2028.md"],
    ["too long", "a".repeat(LIMITS.pathLength + 1)],
  ])("rejects %s", (_label, p) => expectInvalid(repoPathSchema, p, ""));
});

describe("gitShaSchema", () => {
  it("accepts SHA-1 and SHA-256 ids", () => {
    expectValid(gitShaSchema, SHA1);
    expectValid(gitShaSchema, "b".repeat(64));
  });
  it.each(["abc", "A".repeat(40), "g".repeat(40), `${SHA1}\n`])(
    "rejects %j",
    (s) => expectInvalid(gitShaSchema, s, ""),
  );
});

describe("evidenceReferenceSchema", () => {
  it("accepts a bounded reference", () => {
    expectValid(evidenceReferenceSchema, evidence);
  });
  it("rejects unknown signal types", () => {
    expectInvalid(
      evidenceReferenceSchema,
      { ...evidence, signal: "vibes" },
      "signal",
    );
  });
  it("rejects inverted and zero line ranges", () => {
    expectInvalid(
      evidenceReferenceSchema,
      { ...evidence, lineRange: { start: 5, end: 4 } },
      "lineRange.end",
    );
    expectInvalid(
      evidenceReferenceSchema,
      { ...evidence, lineRange: { start: 0, end: 1 } },
      "lineRange.start",
    );
  });
  it("rejects oversized excerpts and unknown keys", () => {
    expectInvalid(
      evidenceReferenceSchema,
      { ...evidence, excerpt: "x".repeat(LIMITS.excerpt + 1) },
      "excerpt",
    );
    expectInvalid(evidenceReferenceSchema, { ...evidence, extra: 1 }, "");
  });
  it("rejects excerpts Postgres cannot store", () => {
    expectInvalid(
      evidenceReferenceSchema,
      { ...evidence, excerpt: "a\u0000b" },
      "excerpt",
    );
    expectInvalid(
      evidenceReferenceSchema,
      { ...evidence, excerpt: "a\uD800b" },
      "excerpt",
    );
  });
});

describe("impactCandidateSchema", () => {
  it("accepts a candidate with evidence", () => {
    expectValid(impactCandidateSchema, candidate);
  });
  it("accepts verify without evidence, recording missing context", () => {
    expectValid(impactCandidateSchema, {
      ...candidate,
      status: "verify",
      evidence: [],
      missingContext: ["Could not resolve dynamic import"],
    });
  });
  it("rejects likely_affected without evidence", () => {
    expectInvalid(
      impactCandidateSchema,
      { ...candidate, evidence: [] },
      "evidence",
    );
  });
  it("rejects traversal in docPath", () => {
    expectInvalid(
      impactCandidateSchema,
      { ...candidate, docPath: "../outside.md" },
      "docPath",
    );
  });
  it("rejects blank or NUL text, unknown status and too much evidence", () => {
    expectInvalid(
      impactCandidateSchema,
      { ...candidate, reason: "   " },
      "reason",
    );
    expectInvalid(
      impactCandidateSchema,
      { ...candidate, reason: "a\u0000" },
      "reason",
    );
    expectInvalid(
      impactCandidateSchema,
      { ...candidate, engineVersion: "   " },
      "engineVersion",
    );
    expectInvalid(
      impactCandidateSchema,
      { ...candidate, status: "maybe" },
      "status",
    );
    expectInvalid(
      impactCandidateSchema,
      {
        ...candidate,
        evidence: Array(LIMITS.evidencePerItem + 1).fill(evidence),
      },
      "evidence",
    );
  });
  it("rejects missing required fields", () => {
    expectInvalid(
      impactCandidateSchema,
      { ...candidate, engineVersion: undefined },
      "engineVersion",
    );
  });
});

describe("analysis state", () => {
  it("allows only forward transitions", () => {
    expect(canTransitionAnalysis("queued", "running")).toBe(true);
    expect(canTransitionAnalysis("running", "completed")).toBe(true);
    expect(canTransitionAnalysis("running", "queued")).toBe(false);
    expect(canTransitionAnalysis("completed", "running")).toBe(false);
    expect(canTransitionAnalysis("queued", "completed")).toBe(false);
    expect(canTransitionAnalysis("failed", "failed")).toBe(false);
  });

  it.each([
    ["queued", { status: "queued" }],
    ["running", { status: "running", startedAt: T0 }],
    ["completed", { status: "completed", startedAt: T0, completedAt: T1 }],
    [
      "failed after running",
      {
        status: "failed",
        startedAt: T0,
        completedAt: T1,
        errorCode: "DIFF_TOO_LARGE",
      },
    ],
    [
      "failed before starting",
      { status: "failed", completedAt: T0, errorCode: "QUEUE_TIMEOUT" },
    ],
    ["cancelled before starting", { status: "cancelled", completedAt: T0 }],
    [
      "same start and end",
      { status: "completed", startedAt: T0, completedAt: T0 },
    ],
  ])("accepts %s", (_label, a) =>
    expectValid(analysisStateSchema, { id: UUID, ...a }),
  );

  it.each([
    [
      "failed without errorCode",
      { status: "failed", completedAt: T0 },
      "errorCode",
    ],
    [
      "raw error text as errorCode",
      {
        status: "failed",
        completedAt: T0,
        errorCode: "connect ECONNREFUSED postgres://user:pw@db",
      },
      "errorCode",
    ],
    [
      "errorCode on success",
      {
        status: "completed",
        startedAt: T0,
        completedAt: T1,
        errorCode: "OOPS",
      },
      "errorCode",
    ],
    ["running without startedAt", { status: "running" }, "startedAt"],
    ["queued with startedAt", { status: "queued", startedAt: T0 }, "startedAt"],
    [
      "completed without startedAt",
      { status: "completed", completedAt: T1 },
      "startedAt",
    ],
    [
      "completed without completedAt",
      { status: "completed", startedAt: T0 },
      "completedAt",
    ],
    [
      "running with completedAt",
      { status: "running", startedAt: T0, completedAt: T1 },
      "completedAt",
    ],
    ["cancelled without completedAt", { status: "cancelled" }, "completedAt"],
    [
      "completedAt before startedAt",
      { status: "completed", startedAt: T1, completedAt: T0 },
      "completedAt",
    ],
    [
      "malformed timestamp",
      { status: "running", startedAt: "yesterday" },
      "startedAt",
    ],
  ])("rejects %s", (_label, a, path) =>
    expectInvalid(analysisStateSchema, { id: UUID, ...a }, path),
  );

  it("rejects non-UUID ids", () => {
    expectInvalid(analysisStateSchema, { id: "1", status: "queued" }, "id");
  });
});

describe("patchProposalSchema", () => {
  it("accepts a valid proposal, with or without model metadata", () => {
    expectValid(patchProposalSchema, proposal);
    expectValid(patchProposalSchema, { ...proposal, model: undefined });
    // In-memory proposals have no persisted candidate yet (D-011).
    expectValid(patchProposalSchema, { ...proposal, candidateId: undefined });
    expectValid(patchProposalSchema, {
      ...proposal,
      validationStatus: "invalid",
      validationIssues: ["PATCH_STALE_BASE"],
    });
  });
  it.each([
    ["absolute target", { targetPath: "/etc/hosts" }, "targetPath"],
    ["bad sha", { baseBlobSha: "main" }, "baseBlobSha"],
    ["missing head sha", { headSha: undefined }, "headSha"],
    [
      "invalid without issues",
      { validationStatus: "invalid" },
      "validationIssues",
    ],
    [
      "valid with issues",
      { validationStatus: "valid", validationIssues: ["PATCH_EMPTY"] },
      "validationIssues",
    ],
    [
      "free-text issue",
      { validationStatus: "invalid", validationIssues: ["bad patch"] },
      "validationIssues.0",
    ],
    ["empty patch", { patch: "" }, "patch"],
    ["NUL in patch", { patch: "+a\u0000\n" }, "patch"],
    ["oversized patch", { patch: "x".repeat(LIMITS.patchChars + 1) }, "patch"],
    ["blank rationale", { rationale: " " }, "rationale"],
    [
      "unknown validation status",
      { validationStatus: "approved" },
      "validationStatus",
    ],
    [
      "blank model id",
      { model: { provider: "ollama", modelId: " ", promptVersion: "p1" } },
      "model.modelId",
    ],
    ["unknown key", { autoMerge: true }, ""],
  ])("rejects %s", (_label, override, path) => {
    expectInvalid(patchProposalSchema, { ...proposal, ...override }, path);
  });
});

describe("modelAssessmentSchema", () => {
  const assessment = {
    docPath: "docs/configuration.md",
    verdict: "needs_update",
    explanation: "The doc lists the renamed variable.",
    citedEvidence: [0, 2],
    model: {
      provider: "ollama",
      modelId: "llama3",
      promptVersion: "assess-v1",
    },
  } as const;
  it("accepts a valid assessment", () => {
    expectValid(modelAssessmentSchema, assessment);
  });
  it.each([
    ["unknown verdict", { verdict: "approve" }, "verdict"],
    ["blank explanation", { explanation: " " }, "explanation"],
    ["negative evidence index", { citedEvidence: [-1] }, "citedEvidence.0"],
    ["missing model metadata", { model: undefined }, "model"],
    ["unknown key", { confidence: 0.97 }, ""],
  ])("rejects %s", (_label, override, path) => {
    expectInvalid(modelAssessmentSchema, { ...assessment, ...override }, path);
  });
});

describe("reviewDecisionInputSchema", () => {
  it("accepts accepted, rejected and edited decisions", () => {
    expectValid(reviewDecisionInputSchema, { decision: "accepted" });
    expectValid(reviewDecisionInputSchema, { decision: "rejected" });
    expectValid(reviewDecisionInputSchema, {
      decision: "edited",
      editedPatch: "+fixed\n",
    });
  });
  it("rejects client-supplied reviewer and proposal ids", () => {
    expectInvalid(
      reviewDecisionInputSchema,
      { decision: "accepted", reviewerId: "admin" },
      "",
    );
    expectInvalid(
      reviewDecisionInputSchema,
      { decision: "accepted", proposalId: UUID },
      "",
    );
  });
  it("requires editedPatch for edited and forbids it otherwise", () => {
    expectInvalid(
      reviewDecisionInputSchema,
      { decision: "edited" },
      "editedPatch",
    );
    expectInvalid(
      reviewDecisionInputSchema,
      { decision: "accepted", editedPatch: "+x\n" },
      "",
    );
  });
  it("rejects unknown decisions", () => {
    expectInvalid(reviewDecisionInputSchema, { decision: "merge" }, "decision");
  });
});

describe("reviewDecisionRecordSchema", () => {
  const base = {
    proposalId: UUID,
    reviewerId: "user-1",
    repositoryId: UUID,
    headSha: SHA1,
    baseBlobSha: "c".repeat(40),
    patchSha256: "d".repeat(64),
    decidedAt: T0,
  };
  it("accepts a server-built record", () => {
    expectValid(reviewDecisionRecordSchema, { ...base, decision: "accepted" });
    expectValid(reviewDecisionRecordSchema, {
      ...base,
      decision: "edited",
      editedPatch: "+x\n",
    });
  });
  it.each([
    "repositoryId",
    "headSha",
    "baseBlobSha",
    "patchSha256",
    "decidedAt",
  ])("rejects a record without approval binding field %s", (field) => {
    expectInvalid(
      reviewDecisionRecordSchema,
      { ...base, decision: "accepted", [field]: undefined },
      field,
    );
  });
  it.each([
    ["headSha", "main"],
    ["patchSha256", SHA1],
    ["patchSha256", "D".repeat(64)],
    ["repositoryId", "owner/repo"],
    ["decidedAt", "now"],
  ])("rejects malformed %s %j", (field, value) => {
    expectInvalid(
      reviewDecisionRecordSchema,
      { ...base, decision: "accepted", [field]: value },
      field,
    );
  });
  it("rejects missing or blank reviewer", () => {
    expectInvalid(
      reviewDecisionRecordSchema,
      { ...base, reviewerId: undefined, decision: "accepted" },
      "reviewerId",
    );
    expectInvalid(
      reviewDecisionRecordSchema,
      { ...base, reviewerId: "  ", decision: "rejected" },
      "reviewerId",
    );
  });
});

describe("apiErrorSchema", () => {
  it("accepts the documented envelope", () => {
    expectValid(apiErrorSchema, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request could not be validated",
        requestId: "req-1",
      },
    });
  });
  it("rejects extra fields such as stack traces", () => {
    expectInvalid(
      apiErrorSchema,
      {
        error: {
          code: "INTERNAL",
          message: "x",
          requestId: "req-1",
          stack: "Error: at ...",
        },
      },
      "error",
    );
  });
});
