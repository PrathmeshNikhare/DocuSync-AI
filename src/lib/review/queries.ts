import "server-only";
import type { Pool } from "pg";
import { z } from "zod";
import { writesEnabled } from "@/lib/env";
import {
  evidenceReferenceSchema,
  impactStatusSchema,
  modelAssessmentSchema,
  modelMetaSchema,
} from "@/lib/schemas";

// Every read joins through repository_reviewers, so a reviewer without a grant
// gets "not found", never someone else's data. JSONB is re-validated on read.

const uuid = z.uuid();
const stringList = z.array(z.string().max(2000)).max(200);

export const changedFileViewSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patchState: z.string(),
});
export const outcomeSchema = z.object({
  docPath: z.string(),
  assessment: z.string(),
  patch: z.string(),
  code: z.string().optional(),
  issues: stringList.optional(),
  droppedEdits: stringList.optional(),
});

export interface RepositoryRef {
  id: string;
  source: "github" | "fixture";
  owner: string;
  name: string;
}

export interface AnalysisSummary {
  id: string;
  repository: RepositoryRef;
  prNumber: number;
  headSha: string;
  status: string;
  errorCode: string | null;
  modelStatus: string | null;
  createdAt: string;
  candidates: number;
  flagged: number;
  proposals: number;
  decided: number;
}

export interface Dashboard {
  repositories: (RepositoryRef & { analyses: number })[];
  analyses: AnalysisSummary[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const repoOf = (r: {
  repository_id: string;
  source: string;
  owner: string;
  name: string;
}): RepositoryRef => ({
  id: r.repository_id,
  source: r.source === "fixture" ? "fixture" : "github",
  owner: r.owner,
  name: r.name,
});

/** Repositories the reviewer may see, and their 50 most recent analyses. */
export async function getDashboard(
  pool: Pool,
  reviewerId: string,
): Promise<Dashboard> {
  const repos = await pool.query<{
    repository_id: string;
    source: string;
    owner: string;
    name: string;
    analyses: string;
  }>(
    `SELECT r.id AS repository_id, r.source, r.owner, r.name,
            (SELECT count(*) FROM analyses a JOIN pull_requests p ON p.id = a.pull_request_id
              WHERE p.repository_id = r.id) AS analyses
       FROM repositories r
       JOIN repository_reviewers rr ON rr.repository_id = r.id AND rr.reviewer_id = $1
      ORDER BY r.owner, r.name`,
    [reviewerId],
  );
  const analyses = await pool.query<{
    id: string;
    repository_id: string;
    source: string;
    owner: string;
    name: string;
    github_pr_number: number;
    head_sha: string;
    status: string;
    error_code: string | null;
    model_status: string | null;
    created_at: Date;
    candidates: string;
    flagged: string;
    proposals: string;
    decided: string;
  }>(
    `SELECT a.id, r.id AS repository_id, r.source, r.owner, r.name, p.github_pr_number, p.head_sha,
            a.status, a.error_code, a.model_status, a.created_at,
            (SELECT count(*) FROM impact_candidates c WHERE c.analysis_id = a.id) AS candidates,
            (SELECT count(*) FROM impact_candidates c WHERE c.analysis_id = a.id
               AND c.impact_status IN ('likely_affected', 'verify')) AS flagged,
            (SELECT count(*) FROM patch_proposals pp JOIN impact_candidates c ON c.id = pp.candidate_id
              WHERE c.analysis_id = a.id) AS proposals,
            (SELECT count(*) FROM review_decisions d JOIN patch_proposals pp ON pp.id = d.proposal_id
               JOIN impact_candidates c ON c.id = pp.candidate_id WHERE c.analysis_id = a.id) AS decided
       FROM analyses a
       JOIN pull_requests p ON p.id = a.pull_request_id
       JOIN repositories r ON r.id = p.repository_id
       JOIN repository_reviewers rr ON rr.repository_id = r.id AND rr.reviewer_id = $1
      ORDER BY a.created_at DESC, a.id
      LIMIT 50`,
    [reviewerId],
  );
  return {
    repositories: repos.rows.map((r) => ({
      ...repoOf(r),
      analyses: Number(r.analyses),
    })),
    analyses: analyses.rows.map((a) => ({
      id: a.id,
      repository: repoOf(a),
      prNumber: a.github_pr_number,
      headSha: a.head_sha,
      status: a.status,
      errorCode: a.error_code,
      modelStatus: a.model_status,
      createdAt: a.created_at.toISOString(),
      candidates: Number(a.candidates),
      flagged: Number(a.flagged),
      proposals: Number(a.proposals),
      decided: Number(a.decided),
    })),
  };
}

export interface CandidateView {
  id: string;
  docPath: string;
  status: z.infer<typeof impactStatusSchema>;
  reason: string;
  evidence: z.infer<typeof evidenceReferenceSchema>[];
  missingContext: string[];
  rankPoints: number;
  rules: string[];
  modelAssessment: z.infer<typeof modelAssessmentSchema> | null;
  outcome: z.infer<typeof outcomeSchema> | null;
  proposal: { id: string; decision: string | null } | null;
}

export interface AnalysisView {
  id: string;
  repository: RepositoryRef;
  pr: {
    number: number;
    headSha: string;
    baseSha: string;
    title: string | null;
  };
  status: string;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  engineVersion: string | null;
  modelStatus: string | null;
  missingContext: string[];
  /** Some documentation could not be read (/review L8). */
  docsPartial: boolean;
  changedFiles: z.infer<typeof changedFileViewSchema>[];
  candidates: CandidateView[];
}

export async function getAnalysis(
  pool: Pool,
  reviewerId: string,
  analysisId: string,
): Promise<AnalysisView | undefined> {
  if (!uuid.safeParse(analysisId).success) return undefined;
  const { rows } = await pool.query<{
    id: string;
    repository_id: string;
    source: string;
    owner: string;
    name: string;
    github_pr_number: number;
    head_sha: string;
    base_sha: string;
    pr_title: string | null;
    status: string;
    error_code: string | null;
    created_at: Date;
    completed_at: Date | null;
    engine_version: string | null;
    model_status: string | null;
    missing_context: unknown;
    changed_files: unknown;
    docs_partial: boolean;
  }>(
    `SELECT a.id, r.id AS repository_id, r.source, r.owner, r.name, p.github_pr_number,
            p.head_sha, p.base_sha, a.pr_title, a.status, a.error_code, a.created_at,
            a.completed_at, a.engine_version, a.model_status, a.missing_context, a.changed_files,
            a.docs_partial
       FROM analyses a
       JOIN pull_requests p ON p.id = a.pull_request_id
       JOIN repositories r ON r.id = p.repository_id
       JOIN repository_reviewers rr ON rr.repository_id = r.id AND rr.reviewer_id = $1
      WHERE a.id = $2`,
    [reviewerId, analysisId],
  );
  const a = rows[0];
  if (!a) return undefined;
  const candidates = await pool.query<{
    id: string;
    doc_path: string;
    impact_status: string;
    reason: string;
    evidence: unknown;
    missing_context: unknown;
    rank_points: number;
    rules: unknown;
    model_assessment: unknown;
    assist_outcome: unknown;
    proposal_id: string | null;
    decision: string | null;
  }>(
    `SELECT c.id, c.doc_path, c.impact_status, c.reason, c.evidence, c.missing_context,
            c.rank_points, c.rules, c.model_assessment, c.assist_outcome,
            pp.id AS proposal_id, d.decision
       FROM impact_candidates c
       LEFT JOIN patch_proposals pp ON pp.candidate_id = c.id
       LEFT JOIN review_decisions d ON d.proposal_id = pp.id
      WHERE c.analysis_id = $1
      ORDER BY c.rank_points DESC, c.doc_path`,
    [a.id],
  );
  return {
    id: a.id,
    repository: repoOf(a),
    pr: {
      number: a.github_pr_number,
      headSha: a.head_sha,
      baseSha: a.base_sha,
      title: a.pr_title,
    },
    status: a.status,
    errorCode: a.error_code,
    createdAt: a.created_at.toISOString(),
    completedAt: iso(a.completed_at),
    engineVersion: a.engine_version,
    modelStatus: a.model_status,
    missingContext: stringList.parse(a.missing_context ?? []),
    docsPartial: a.docs_partial,
    changedFiles: z
      .array(changedFileViewSchema)
      .max(300)
      .parse(a.changed_files ?? []),
    candidates: candidates.rows.map((c) => ({
      id: c.id,
      docPath: c.doc_path,
      status: impactStatusSchema.parse(c.impact_status),
      reason: c.reason,
      evidence: z.array(evidenceReferenceSchema).parse(c.evidence),
      missingContext: stringList.parse(c.missing_context),
      rankPoints: c.rank_points,
      rules: stringList.parse(c.rules),
      modelAssessment: c.model_assessment
        ? modelAssessmentSchema.parse(c.model_assessment)
        : null,
      outcome: c.assist_outcome ? outcomeSchema.parse(c.assist_outcome) : null,
      proposal: c.proposal_id
        ? { id: c.proposal_id, decision: c.decision }
        : null,
    })),
  };
}

export interface DecisionView {
  decision: "accepted" | "edited" | "rejected";
  editedPatch: string | null;
  reviewer: { username: string; displayName: string };
  decidedAt: string;
  patchSha256: string;
  headSha: string;
  baseBlobSha: string;
}

export interface ReviewView {
  proposal: {
    id: string;
    targetPath: string;
    headSha: string;
    baseBlobSha: string;
    baseContent: string;
    patch: string;
    rationale: string;
    evidence: z.infer<typeof evidenceReferenceSchema>[];
    validationStatus: "valid" | "invalid";
    validationIssues: string[];
    model: z.infer<typeof modelMetaSchema> | null;
    createdAt: string;
  };
  candidate: {
    status: z.infer<typeof impactStatusSchema>;
    reason: string;
    rules: string[];
    missingContext: string[];
    modelAssessment: z.infer<typeof modelAssessmentSchema> | null;
  };
  analysisId: string;
  repository: RepositoryRef;
  pr: {
    number: number;
    headSha: string;
    baseSha: string;
    title: string | null;
    /** Recorded by live analyses only; a GitHub write needs it. */
    headRef: string | null;
  };
  decision: DecisionView | null;
  /** The documentation PR for this decision, once one was requested (docs/13). */
  output: {
    step: "pending" | "branch_created" | "committed" | "pr_opened";
    errorCode: string | null;
    prNumber: number | null;
    prUrl: string | null;
  } | null;
  writesEnabled: boolean;
}

export async function getReview(
  pool: Pool,
  reviewerId: string,
  proposalId: string,
): Promise<ReviewView | undefined> {
  if (!uuid.safeParse(proposalId).success) return undefined;
  const { rows } = await pool.query<{
    id: string;
    target_path: string;
    head_sha: string;
    base_blob_sha: string;
    base_content: string;
    patch_text: string;
    rationale: string;
    evidence: unknown;
    validation_status: string;
    validation_issues: unknown;
    model: unknown;
    created_at: Date;
    impact_status: string;
    reason: string;
    rules: unknown;
    missing_context: unknown;
    model_assessment: unknown;
    analysis_id: string;
    repository_id: string;
    source: string;
    owner: string;
    name: string;
    github_pr_number: number;
    pr_head_sha: string;
    base_sha: string;
    pr_title: string | null;
    decision: string | null;
    edited_patch: string | null;
    decided_at: Date | null;
    patch_sha256: string | null;
    d_head_sha: string | null;
    d_base_blob_sha: string | null;
    username: string | null;
    display_name: string | null;
    head_ref: string | null;
    out_step: string | null;
    out_error: string | null;
    pr_number: number | null;
    pr_url: string | null;
  }>(
    `SELECT pp.id, pp.target_path, pp.head_sha, pp.base_blob_sha, pp.base_content, pp.patch_text,
            pp.rationale, pp.evidence, pp.validation_status, pp.validation_issues, pp.model,
            pp.created_at, c.impact_status, c.reason, c.rules, c.missing_context, c.model_assessment,
            a.id AS analysis_id, r.id AS repository_id, r.source, r.owner, r.name,
            p.github_pr_number, p.head_sha AS pr_head_sha, p.base_sha, a.pr_title,
            d.decision, d.edited_patch, d.decided_at, d.patch_sha256,
            d.head_sha AS d_head_sha, d.base_blob_sha AS d_base_blob_sha,
            rv.username, rv.display_name, p.head_ref,
            go.step AS out_step, go.error_code AS out_error, go.pr_number, go.pr_url
       FROM patch_proposals pp
       JOIN impact_candidates c ON c.id = pp.candidate_id
       JOIN analyses a ON a.id = c.analysis_id
       JOIN pull_requests p ON p.id = a.pull_request_id
       JOIN repositories r ON r.id = p.repository_id
       JOIN repository_reviewers rr ON rr.repository_id = r.id AND rr.reviewer_id = $1
       LEFT JOIN review_decisions d ON d.proposal_id = pp.id
       LEFT JOIN reviewers rv ON rv.id = d.reviewer_id
       LEFT JOIN github_outputs go ON go.decision_id = d.id
      WHERE pp.id = $2`,
    [reviewerId, proposalId],
  );
  const r = rows[0];
  if (!r) return undefined;
  const prUrl = z
    .string()
    .regex(
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/,
    )
    .nullable()
    .parse(r.pr_url);
  return {
    proposal: {
      id: r.id,
      targetPath: r.target_path,
      headSha: r.head_sha,
      baseBlobSha: r.base_blob_sha,
      baseContent: r.base_content,
      patch: r.patch_text,
      rationale: r.rationale,
      evidence: z.array(evidenceReferenceSchema).parse(r.evidence),
      validationStatus: r.validation_status === "valid" ? "valid" : "invalid",
      validationIssues: stringList.parse(r.validation_issues),
      model: r.model ? modelMetaSchema.parse(r.model) : null,
      createdAt: r.created_at.toISOString(),
    },
    candidate: {
      status: impactStatusSchema.parse(r.impact_status),
      reason: r.reason,
      rules: stringList.parse(r.rules),
      missingContext: stringList.parse(r.missing_context),
      modelAssessment: r.model_assessment
        ? modelAssessmentSchema.parse(r.model_assessment)
        : null,
    },
    analysisId: r.analysis_id,
    repository: repoOf(r),
    pr: {
      number: r.github_pr_number,
      headSha: r.pr_head_sha,
      baseSha: r.base_sha,
      title: r.pr_title,
      headRef: r.head_ref,
    },
    decision:
      r.decision && r.decided_at && r.patch_sha256 && r.username
        ? {
            decision: z
              .enum(["accepted", "edited", "rejected"])
              .parse(r.decision),
            editedPatch: r.edited_patch,
            reviewer: {
              username: r.username,
              displayName: r.display_name ?? r.username,
            },
            decidedAt: r.decided_at.toISOString(),
            patchSha256: r.patch_sha256,
            headSha: r.d_head_sha ?? r.head_sha,
            baseBlobSha: r.d_base_blob_sha ?? r.base_blob_sha,
          }
        : null,
    output: r.out_step
      ? {
          step: z
            .enum(["pending", "branch_created", "committed", "pr_opened"])
            .parse(r.out_step),
          errorCode: r.out_error,
          prNumber: r.pr_number,
          prUrl,
        }
      : null,
    writesEnabled: writesEnabled(),
  };
}
