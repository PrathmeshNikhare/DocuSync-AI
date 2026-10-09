import { z } from "zod";

// Shared runtime contracts. Every external or persisted value crosses one of these
// schemas. Objects are strict: unknown keys are rejected, not silently dropped.

export const LIMITS = {
  pathLength: 512,
  reason: 500,
  excerpt: 500,
  rationale: 2000,
  evidencePerItem: 50,
  missingContextItems: 20,
  patchChars: 100_000,
} as const;

// Postgres rejects NUL in text and jsonb; lone surrogates are not valid Unicode.
const isStorableText = (s: string) => !s.includes("\0") && s.isWellFormed();
const STORABLE = { message: "Text contains NUL or malformed Unicode" };

/** Free text that may contain whitespace-only content (e.g. patches, excerpts). */
const text = (max: number) =>
  z.string().max(max).refine(isStorableText, STORABLE);

/** Non-blank text: trimmed, then required to be non-empty. */
const label = (max: number) =>
  z.string().trim().min(1).max(max).refine(isStorableText, STORABLE);

// Control (Cc), format (Cf: bidi overrides, zero-width), surrogate (Cs) and
// line/paragraph separator characters, plus backslash and colon (drive letters,
// Windows alternate data streams).
const UNSAFE_PATH_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\\:]/u;

/**
 * Repository-relative, already-normalized POSIX path. Rejects (does not repair)
 * absolute paths, unsafe characters, empty, "." or ".." segments, and segments
 * ending in "." or " " (Windows silently strips those, so "docs/.. " aliases "docs/..").
 */
export const repoPathSchema = z
  .string()
  .min(1)
  .max(LIMITS.pathLength)
  .refine((p) => !UNSAFE_PATH_CHAR.test(p), {
    message: "Path contains control, format, separator, '\\' or ':' characters",
  })
  .refine((p) => !p.startsWith("/"), {
    message: "Path must be repository-relative",
  })
  .refine(
    (p) =>
      p
        .split("/")
        .every((s) => s !== "" && !s.endsWith(".") && !s.endsWith(" ")),
    {
      message:
        "Path must be normalized: no empty segments and no segment ending in '.' or ' '",
    },
  );

/** Git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
export const gitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Safe, machine-readable error code. Never a raw error message. */
export const errorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const evidenceSignalSchema = z.enum([
  "path_change",
  "explicit_reference",
  "import_export",
  "api_route",
  "env_var",
  "cli_command",
  "package_script",
  "config_key",
  "doc_link",
  "repo_convention",
]);

export const lineRangeSchema = z
  .strictObject({ start: z.int().min(1), end: z.int().min(1) })
  .refine((r) => r.end >= r.start, {
    message: "end must be >= start",
    path: ["end"],
  });

export const evidenceReferenceSchema = z.strictObject({
  signal: evidenceSignalSchema,
  sourcePath: repoPathSchema,
  lineRange: lineRangeSchema.optional(),
  excerpt: text(LIMITS.excerpt).optional(),
});
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const impactStatusSchema = z.enum([
  "likely_affected",
  "verify",
  "unlikely_affected",
]);

export const impactCandidateSchema = z
  .strictObject({
    docPath: repoPathSchema,
    status: impactStatusSchema,
    reason: label(LIMITS.reason),
    evidence: z.array(evidenceReferenceSchema).max(LIMITS.evidencePerItem),
    missingContext: z
      .array(label(LIMITS.reason))
      .max(LIMITS.missingContextItems),
    engineVersion: label(64),
  })
  // A relationship without evidence must be reported as uncertain, not asserted.
  .refine((c) => c.status !== "likely_affected" || c.evidence.length > 0, {
    message: "likely_affected requires at least one evidence reference",
    path: ["evidence"],
  });
export type ImpactCandidate = z.infer<typeof impactCandidateSchema>;

export const analysisStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

const ANALYSIS_TRANSITIONS: Record<AnalysisStatus, readonly AnalysisStatus[]> =
  {
    queued: ["running", "failed", "cancelled"],
    running: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };

export function canTransitionAnalysis(
  from: AnalysisStatus,
  to: AnalysisStatus,
): boolean {
  return ANALYSIS_TRANSITIONS[from].includes(to);
}

const TERMINAL: readonly AnalysisStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export const analysisStateSchema = z
  .strictObject({
    id: z.uuid(),
    status: analysisStatusSchema,
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    errorCode: errorCodeSchema.optional(),
  })
  .refine((a) => (a.status === "failed") === (a.errorCode !== undefined), {
    message: "errorCode is required for failed analyses and only for them",
    path: ["errorCode"],
  })
  // failed/cancelled may come straight from queued, so startedAt is optional there.
  .refine(
    (a) =>
      a.status === "queued"
        ? a.startedAt === undefined
        : a.status === "running" || a.status === "completed"
          ? a.startedAt !== undefined
          : true,
    {
      message: "startedAt is required once running and forbidden while queued",
      path: ["startedAt"],
    },
  )
  .refine(
    (a) => TERMINAL.includes(a.status) === (a.completedAt !== undefined),
    {
      message:
        "completedAt is required for terminal statuses and only for them",
      path: ["completedAt"],
    },
  )
  .refine(
    (a) =>
      a.startedAt === undefined ||
      a.completedAt === undefined ||
      Date.parse(a.startedAt) <= Date.parse(a.completedAt),
    {
      message: "completedAt must not precede startedAt",
      path: ["completedAt"],
    },
  );
export type AnalysisState = z.infer<typeof analysisStateSchema>;

export const patchProposalSchema = z.strictObject({
  candidateId: z.uuid(),
  targetPath: repoPathSchema,
  baseBlobSha: gitShaSchema,
  patch: text(LIMITS.patchChars).min(1),
  rationale: label(LIMITS.rationale),
  evidence: z.array(evidenceReferenceSchema).max(LIMITS.evidencePerItem),
  validationStatus: z.enum(["pending", "valid", "invalid"]),
  model: z
    .strictObject({
      provider: label(64),
      modelId: label(128),
      promptVersion: label(64),
    })
    .optional(),
});
export type PatchProposal = z.infer<typeof patchProposalSchema>;

/**
 * Review decision as sent by a client. It deliberately has no reviewer or
 * proposal id: the server takes those from the session and the URL.
 */
export const reviewDecisionInputSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("accepted") }),
  z.strictObject({ decision: z.literal("rejected") }),
  z.strictObject({
    decision: z.literal("edited"),
    editedPatch: text(LIMITS.patchChars).min(1),
  }),
]);
export type ReviewDecisionInput = z.infer<typeof reviewDecisionInputSchema>;

// Binds the decision to the exact repo, revision and patch bytes that were reviewed,
// so a later GitHub write can refuse a stale approval (docs/07 controls 9 and 10).
const reviewRecordBase = {
  proposalId: z.uuid(),
  reviewerId: label(200),
  repositoryId: z.uuid(),
  headSha: gitShaSchema,
  baseBlobSha: gitShaSchema,
  /** SHA-256 (hex) of the approved patch text: the proposal's patch, or editedPatch when edited. */
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  decidedAt: z.iso.datetime(),
};

/**
 * Persisted review decision. Every field except `decision` and `editedPatch` must come
 * from server state (session, URL, stored proposal), never from the request body.
 */
export const reviewDecisionRecordSchema = z.discriminatedUnion("decision", [
  z.strictObject({ ...reviewRecordBase, decision: z.literal("accepted") }),
  z.strictObject({ ...reviewRecordBase, decision: z.literal("rejected") }),
  z.strictObject({
    ...reviewRecordBase,
    decision: z.literal("edited"),
    editedPatch: text(LIMITS.patchChars).min(1),
  }),
]);
export type ReviewDecisionRecord = z.infer<typeof reviewDecisionRecordSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: label(500),
    requestId: label(100),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
