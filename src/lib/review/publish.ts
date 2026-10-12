import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { validationContextSchema } from "@/lib/assist/assist";
import { writesEnabled } from "@/lib/env";
import { decodeDocBytes } from "@/lib/github/doc-bytes";
import { GitHubReadError, livePullSchema } from "@/lib/github/reader";
import type { GitHubWriter, WriteBinding } from "@/lib/github/writer";
import { gitBlobSha } from "@/lib/patches/blob-sha";
import { validatePatch } from "@/lib/patches/validate";
import {
  evidenceReferenceSchema,
  gitShaSchema,
  modelMetaSchema,
} from "@/lib/schemas";
import { commitMessage, prBody, prTitle, type PrContent } from "./pr-content";

// Creates the one documentation PR for an approved decision (docs/13, D-013).
// Every check runs again on every attempt; the first failure stops with a code
// and no GitHub write. Progress is persisted after each step, under a lease, so a
// retry resumes instead of duplicating.

export const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL = "30 seconds";
const LEASE = "60 seconds";
/** Shorter than the lease, so a lease can't expire while its holder still writes. */
export const DEADLINE_MS = 45_000;

export const createPrInputSchema = z.strictObject({
  headSha: gitShaSchema,
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Failures a later attempt may succeed on. Everything else needs a new review. */
export const RETRYABLE: readonly string[] = [
  "GITHUB_TIMEOUT",
  "GITHUB_NETWORK_ERROR",
  "GITHUB_UPSTREAM_ERROR",
  "GITHUB_RATE_LIMITED",
  "GITHUB_UNAUTHORIZED",
  "GITHUB_FORBIDDEN",
  "GITHUB_NOT_FOUND",
  // The App's permissions or installation are being fixed by an operator.
  "GITHUB_TOKEN_SCOPE",
  "GITHUB_TOKEN_REFUSED",
  // A renamed repository redirects until the webhook records the new name.
  "GITHUB_REDIRECT",
  // A write that may have taken effect: the next attempt re-reads GitHub's state.
  "GITHUB_AMBIGUOUS",
  "WRITES_DISABLED",
  "LEASE_LOST",
  "INTERNAL_ERROR",
];

export type PublishResult =
  | {
      ok: true;
      outputId: string;
      prNumber: number;
      prUrl: string;
      /** False when the PR already existed (a repeated request). */
      created: boolean;
    }
  | { ok: false; code: string; outputId?: string };

export interface PublishDeps {
  pool: Pool;
  env?: Record<string, string | undefined>;
  allowedInstallationIds(): ReadonlySet<number>;
  appSlug(): string;
  openWriter(binding: WriteBinding, signal: AbortSignal): Promise<GitHubWriter>;
}

class Stop extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const SHA1 = /^[0-9a-f]{40}$/;

interface Approval {
  target_path: string;
  pp_head: string;
  pp_blob: string;
  base_content: string;
  patch_text: string;
  rationale: string;
  evidence: unknown;
  model: unknown;
  validation_context: unknown;
  repository_id: string;
  source: string;
  owner: string;
  name: string;
  github_repo_id: string | null;
  installation_id: string | null;
  github_pr_number: number;
  pr_head: string;
  head_ref: string | null;
  base_ref: string | null;
  decision_id: string | null;
  decision: string | null;
  edited_patch: string | null;
  d_repo: string | null;
  d_head: string | null;
  d_blob: string | null;
  patch_sha256: string | null;
  decider_name: string | null;
  decider_disabled: Date | null;
  decider_granted: boolean;
}

interface Output {
  id: string;
  github_repo_id: string;
  installation_id: string;
  branch: string;
  docs_pr_base_ref: string;
  step: string;
  error_code: string | null;
  commit_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  attempts: number;
  leased: boolean;
}

const OUTPUT_COLUMNS = `id, github_repo_id, installation_id, branch, docs_pr_base_ref, step,
  error_code, commit_sha, pr_number, pr_url, attempts,
  (lease_until IS NOT NULL AND lease_until > now()) AS leased`;

/** Ungranted and unknown proposals look the same: undefined. */
async function loadApproval(
  pool: Pool,
  reviewerId: string,
  proposalId: string,
) {
  const { rows } = await pool.query<Approval>(
    `SELECT pp.target_path, pp.head_sha AS pp_head, pp.base_blob_sha AS pp_blob, pp.base_content,
            pp.patch_text, pp.rationale, pp.evidence, pp.model, pp.validation_context,
            r.id AS repository_id, r.source, r.owner, r.name, r.github_repo_id, r.installation_id,
            p.github_pr_number, p.head_sha AS pr_head, p.head_ref, p.base_ref,
            d.id AS decision_id, d.decision, d.edited_patch, d.repository_id AS d_repo,
            d.head_sha AS d_head, d.base_blob_sha AS d_blob, d.patch_sha256,
            dv.display_name AS decider_name, dv.disabled_at AS decider_disabled,
            EXISTS (SELECT 1 FROM repository_reviewers g
                     WHERE g.repository_id = r.id AND g.reviewer_id = d.reviewer_id) AS decider_granted
       FROM patch_proposals pp
       JOIN impact_candidates c ON c.id = pp.candidate_id
       JOIN analyses a ON a.id = c.analysis_id
       JOIN pull_requests p ON p.id = a.pull_request_id
       JOIN repositories r ON r.id = p.repository_id
       JOIN repository_reviewers rr ON rr.repository_id = r.id AND rr.reviewer_id = $1
       LEFT JOIN review_decisions d ON d.proposal_id = pp.id
       LEFT JOIN reviewers dv ON dv.id = d.reviewer_id
      WHERE pp.id = $2`,
    [reviewerId, proposalId],
  );
  return rows[0];
}

/** Write-time checks 4-9 of docs/13, in order. Returns the content to write. */
function checkApproval(
  a: Approval,
  input: z.infer<typeof createPrInputSchema>,
  allowed: ReadonlySet<number>,
): string {
  if (!a.decision_id || !a.decision) throw new Stop("NOT_DECIDED");
  if (a.decision === "rejected") throw new Stop("PROPOSAL_REJECTED");
  if (a.decider_disabled || !a.decider_granted)
    throw new Stop("DECISION_REVOKED");
  if (input.headSha !== a.d_head || input.patchSha256 !== a.patch_sha256)
    throw new Stop("APPROVAL_MISMATCH");
  if (
    a.d_repo !== a.repository_id ||
    a.d_head !== a.pp_head ||
    a.pp_head !== a.pr_head ||
    a.d_blob !== a.pp_blob
  )
    throw new Stop("APPROVAL_TAMPERED");
  const approved = a.edited_patch ?? a.patch_text;
  if (sha256(approved) !== a.patch_sha256) throw new Stop("APPROVAL_TAMPERED");
  const context = validationContextSchema.parse(a.validation_context);
  const checked = validatePatch({
    targetPath: a.target_path,
    patch: approved,
    baseBlobSha: a.pp_blob,
    doc: { path: a.target_path, content: a.base_content },
    relatedLines: context.relatedLines,
    relatedTerms: context.relatedTerms,
    knownLinks: new Set(context.knownLinks),
  });
  if (!checked.ok) throw new Stop("PATCH_INVALID");
  if (a.source !== "github" || !a.github_repo_id || !a.installation_id)
    throw new Stop("FIXTURE_NOT_WRITABLE");
  if (!allowed.has(Number(a.installation_id)))
    throw new Stop("INSTALLATION_NOT_ALLOWED");
  if (!a.head_ref || !a.base_ref) throw new Stop("ANALYSIS_TOO_OLD");
  // Writes are SHA-1 only (gitBlobSha); live analyses of SHA-256 repos have no docs.
  if (!SHA1.test(a.pp_head) || !SHA1.test(a.pp_blob))
    throw new Stop("APPROVAL_TAMPERED");
  return checked.content;
}

const blobSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});
const putSchema = z.object({
  content: z.object({ sha: z.string() }),
  commit: z.object({
    sha: z.string().regex(SHA1),
    parents: z.array(z.object({ sha: z.string() })),
  }),
});
const compareSchema = z.object({
  ahead_by: z.number(),
  behind_by: z.number(),
  total_commits: z.number(),
  commits: z.array(
    z.object({
      sha: z.string(),
      parents: z.array(z.object({ sha: z.string().optional() })),
    }),
  ),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        sha: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
const listedPullSchema = z.object({
  number: z.int().min(1),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({
    sha: z.string(),
    repo: z.object({ id: z.number() }).nullable(),
  }),
  base: z.object({ ref: z.string() }),
});

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new GitHubReadError("GITHUB_INVALID_RESPONSE");
  return r.data;
}

export async function createDocsPr(
  deps: PublishDeps,
  reviewerId: string,
  proposalId: string,
  body: unknown,
): Promise<PublishResult> {
  if (!writesEnabled(deps.env)) return { ok: false, code: "WRITES_DISABLED" };
  const input = createPrInputSchema.safeParse(body);
  if (!input.success) return { ok: false, code: "INVALID_INPUT" };
  if (!z.uuid().safeParse(proposalId).success)
    return { ok: false, code: "NOT_FOUND" };
  const a = await loadApproval(deps.pool, reviewerId, proposalId);
  if (!a) return { ok: false, code: "NOT_FOUND" };

  // A PR already opened for this decision is reported as it is, even if the
  // approval could no longer be published now; the review page shows it anyway.
  if (a.decision_id) {
    const done = await deps.pool.query<{
      id: string;
      pr_number: number;
      pr_url: string;
    }>(
      `SELECT id, pr_number, pr_url FROM github_outputs
        WHERE decision_id = $1 AND step = 'pr_opened'`,
      [a.decision_id],
    );
    const d = done.rows[0];
    if (d)
      return {
        ok: true,
        outputId: d.id,
        prNumber: d.pr_number,
        prUrl: d.pr_url,
        created: false,
      };
  }

  let newContent: string;
  try {
    newContent = checkApproval(a, input.data, deps.allowedInstallationIds());
  } catch (err) {
    if (err instanceof Stop) return { ok: false, code: err.code };
    throw err;
  }
  // Everything that can fail on stored data or configuration fails here, before
  // an attempt is claimed or a token minted.
  const appSlug = deps.appSlug();
  const prText: Omit<PrContent, "headRef"> = {
    owner: a.owner,
    repo: a.name,
    pullNumber: a.github_pr_number,
    targetPath: a.target_path,
    decision: a.decision === "edited" ? "edited" : "accepted",
    reviewerName: a.decider_name ?? "a DocuSync reviewer",
    patchSha256: a.patch_sha256!,
    headSha: a.pp_head,
    baseBlobSha: a.pp_blob,
    evidence: z.array(evidenceReferenceSchema).parse(a.evidence),
    model: a.model ? modelMetaSchema.parse(a.model) : null,
    rationale: a.rationale,
  };

  const branch = `docusync/pr-${a.github_pr_number}-${proposalId.replace(/-/g, "").slice(0, 12)}`;
  await deps.pool.query(
    `INSERT INTO github_outputs (decision_id, proposal_id, repository_id, github_repo_id,
                                 installation_id, head_sha, base_blob_sha, patch_sha256,
                                 branch, docs_pr_base_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (decision_id) DO NOTHING`,
    [
      a.decision_id,
      proposalId,
      a.repository_id,
      a.github_repo_id,
      a.installation_id,
      a.pp_head,
      a.pp_blob,
      a.patch_sha256,
      branch,
      a.head_ref,
      reviewerId,
    ],
  );

  const token = randomUUID();
  const claimed = await deps.pool.query<Output>(
    `UPDATE github_outputs
        SET lease_token = $2, lease_until = now() + interval '${LEASE}',
            attempts = attempts + 1, updated_at = now()
      WHERE decision_id = $1 AND step <> 'pr_opened'
        AND (lease_until IS NULL OR lease_until <= now())
        AND attempts < $3
        AND (attempts = 0 OR updated_at < now() - interval '${RETRY_INTERVAL}')
        AND (error_code IS NULL OR error_code = ANY($4))
      RETURNING ${OUTPUT_COLUMNS}`,
    [a.decision_id, token, MAX_ATTEMPTS, RETRYABLE],
  );
  const out = claimed.rows[0];
  if (!out) {
    const { rows } = await deps.pool.query<Output>(
      `SELECT ${OUTPUT_COLUMNS} FROM github_outputs WHERE decision_id = $1`,
      [a.decision_id],
    );
    const o = rows[0]!;
    if (o.step === "pr_opened")
      return {
        ok: true,
        outputId: o.id,
        prNumber: o.pr_number!,
        prUrl: o.pr_url!,
        created: false,
      };
    const code = o.leased
      ? "IN_PROGRESS"
      : o.error_code && !RETRYABLE.includes(o.error_code)
        ? o.error_code
        : o.attempts >= MAX_ATTEMPTS
          ? "ATTEMPT_LIMIT"
          : "RETRY_TOO_SOON";
    return { ok: false, code, outputId: o.id };
  }

  /** Progress writes need the live lease; losing it stops the operation. */
  const advance = async (set: string, values: unknown[]) => {
    const r = await deps.pool.query(
      `UPDATE github_outputs SET ${set}, updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND lease_until > now()`,
      [out.id, token, ...values],
    );
    if (!r.rowCount) throw new Stop("LEASE_LOST");
  };

  const binding: WriteBinding = {
    installationId: Number(out.installation_id),
    githubRepoId: Number(out.github_repo_id),
    owner: a.owner,
    repo: a.name,
    pullNumber: a.github_pr_number,
    headSha: a.pp_head,
    baseBlobSha: a.pp_blob,
    targetPath: a.target_path,
    branch: out.branch,
    docsPrBaseRef: out.docs_pr_base_ref,
  };
  const content: PrContent = { ...prText, headRef: out.docs_pr_base_ref };

  let writer: GitHubWriter | undefined;
  try {
    await deps.pool.query(
      "INSERT INTO github_output_attempts (output_id, reviewer_id) VALUES ($1, $2)",
      [out.id, reviewerId],
    );
    if (
      out.installation_id !== a.installation_id ||
      out.github_repo_id !== a.github_repo_id ||
      !deps.allowedInstallationIds().has(binding.installationId)
    )
      throw new Stop("REPOSITORY_MISMATCH");
    writer = await deps.openWriter(binding, AbortSignal.timeout(DEADLINE_MS));
    const pr = await publishSteps(
      writer,
      binding,
      a,
      out,
      newContent,
      content,
      appSlug,
      advance,
    );
    return { ok: true, outputId: out.id, ...pr };
  } catch (err) {
    const code =
      err instanceof Stop || err instanceof GitHubReadError
        ? err.code
        : "INTERNAL_ERROR";
    // Releases the lease; if it was lost, the new holder's row is left alone.
    await deps.pool.query(
      `UPDATE github_outputs SET error_code = $3, lease_token = NULL, lease_until = NULL,
              updated_at = now()
        WHERE id = $1 AND lease_token = $2`,
      [out.id, token, code],
    );
    if (code === "INTERNAL_ERROR") throw err;
    return { ok: false, code, outputId: out.id };
  } finally {
    await writer?.close();
  }
}

async function publishSteps(
  w: GitHubWriter,
  b: WriteBinding,
  a: Approval,
  out: Output,
  newContent: string,
  content: PrContent,
  appSlug: string,
  advance: (set: string, values: unknown[]) => Promise<void>,
): Promise<{ prNumber: number; prUrl: string; created: boolean }> {
  // 11. The source PR as GitHub sees it now.
  const pull = parse(livePullSchema, await w.getPull());
  if (pull.state !== "open") throw new Stop("PR_NOT_OPEN");
  if (pull.base.repo.id !== b.githubRepoId)
    throw new Stop("REPOSITORY_MISMATCH");
  if (!pull.head.repo || pull.head.repo.id !== pull.base.repo.id)
    throw new Stop("FORK_NOT_SUPPORTED");
  if (pull.head.sha !== b.headSha) throw new Stop("STALE_HEAD");
  // The head ref is compared with this output's snapshot (the docs PR's base),
  // so a later re-analysis can't change where an existing output points.
  if (pull.head.ref !== b.docsPrBaseRef || pull.base.ref !== a.base_ref)
    throw new Stop("PR_RETARGETED");
  const entry = await w.findTarget();
  if (entry === "truncated") throw new Stop("TREE_TRUNCATED");
  if (
    entry === "missing" ||
    entry.type !== "blob" ||
    (entry.mode !== "100644" && entry.mode !== "100755") ||
    entry.sha !== b.baseBlobSha
  )
    throw new Stop("STALE_BLOB");

  // 12. What gets written is the approved patch applied to GitHub's own blob,
  // which must be exactly the text that was reviewed.
  const blob = parse(blobSchema, await w.getBaseBlob());
  const decoded = decodeDocBytes(Buffer.from(blob.content, "base64"));
  if (
    !decoded.ok ||
    gitBlobSha(decoded.text) !== b.baseBlobSha ||
    decoded.text !== a.base_content
  )
    throw new Stop("APPROVAL_TAMPERED");
  const newBlob = gitBlobSha(newContent);

  // Branch, at exactly the reviewed head.
  let tip = await w.branchSha();
  if (!tip) {
    if (out.commit_sha) throw new Stop("BRANCH_CONFLICT");
    tip = (await w.createBranch()) ? b.headSha : await w.branchSha();
    if (!tip) throw new Stop("BRANCH_CONFLICT");
  }
  if (out.step === "pending") await advance("step = 'branch_created'", []);

  /**
   * True if `sha` is exactly our change: one commit on top of the reviewed head,
   * changing only the target, to the approved content.
   */
  const isOurCommit = async (sha: string) => {
    const cmp = parse(compareSchema, await w.compare(sha));
    const c = cmp.commits[0];
    const f = cmp.files?.[0];
    return (
      cmp.ahead_by === 1 &&
      cmp.behind_by === 0 &&
      cmp.total_commits === 1 &&
      cmp.commits.length === 1 &&
      c?.sha === sha &&
      c.parents.length === 1 &&
      c.parents[0]?.sha === b.headSha &&
      cmp.files?.length === 1 &&
      f?.filename === b.targetPath &&
      f.status === "modified" &&
      f.sha === newBlob
    );
  };

  // Commit: ours, exactly once.
  let commit = out.commit_sha;
  if (commit) {
    if (tip !== commit) throw new Stop("BRANCH_CONFLICT");
  } else if (tip === b.headSha) {
    let raw: unknown;
    try {
      raw = await w.putTarget(newContent, commitMessage(content));
    } catch (err) {
      if (err instanceof GitHubReadError && err.code === "GITHUB_CONFLICT")
        throw new Stop("STALE_BLOB");
      throw err;
    }
    // The commit may exist even if its response is unusable: a retry adopts it
    // only through the compare check below.
    const put = putSchema.safeParse(raw);
    if (!put.success || put.data.content.sha !== newBlob)
      throw new Stop("GITHUB_AMBIGUOUS");
    // The PUT is conditioned on the file's blob, not the branch tip: someone with
    // push access could have moved the branch in between, and GitHub would then
    // commit on top of their commit.
    const parents = put.data.commit.parents;
    if (parents.length !== 1 || parents[0]!.sha !== b.headSha)
      throw new Stop("BRANCH_CONFLICT");
    commit = put.data.commit.sha;
  } else if (tip && SHA1.test(tip)) {
    // An earlier PUT whose response was lost: adopt its commit only if it is
    // exactly our change on top of the reviewed head.
    if (!(await isOurCommit(tip))) throw new Stop("BRANCH_CONFLICT");
    commit = tip;
  } else {
    throw new Stop("BRANCH_CONFLICT");
  }
  if (!out.commit_sha)
    await advance("step = 'committed', commit_sha = $3", [commit]);

  // PR: the branch must still be exactly our one commit on the reviewed head.
  if ((await w.branchSha()) !== commit || !(await isOurCommit(commit)))
    throw new Stop("BRANCH_CONFLICT");
  const adoptable = async () => {
    const pulls = parse(z.array(listedPullSchema), await w.listBranchPulls());
    const ours = pulls.find(
      (p) =>
        p.user?.login === `${appSlug}[bot]` &&
        p.base.ref === b.docsPrBaseRef &&
        p.head.sha === commit &&
        p.head.repo?.id === b.githubRepoId,
    );
    if (!ours && pulls.length > 0) throw new Stop("BRANCH_CONFLICT");
    return ours?.number;
  };
  let number = await adoptable();
  let created = false;
  if (number === undefined) {
    const res = await w.createPull(
      prTitle(content),
      prBody({ ...content, commitSha: commit }),
    );
    if (res === undefined) {
      // A 422: either our PR exists already, or GitHub refused (for example,
      // the base branch was deleted).
      number = await adoptable();
      if (number === undefined) throw new Stop("PR_CREATE_REFUSED");
    } else {
      const parsed = z
        .object({
          number: z.int().min(1),
          head: z.object({ sha: z.string() }),
        })
        .safeParse(res);
      // The PR may exist even if its response is unusable; a retry adopts it.
      if (!parsed.success) throw new Stop("GITHUB_AMBIGUOUS");
      // A push between the last check and the create: the PR exists but carries
      // more than our commit. It is not recorded as ours; an operator closes it.
      if (parsed.data.head.sha !== commit) throw new Stop("PR_HEAD_MISMATCH");
      number = parsed.data.number;
      created = true;
    }
  }
  const prUrl = `https://github.com/${b.owner}/${b.repo}/pull/${number}`;
  await advance(
    `step = 'pr_opened', pr_number = $3, pr_url = $4, error_code = NULL,
     lease_token = NULL, lease_until = NULL`,
    [number, prUrl],
  );
  return { prNumber: number, prUrl, created };
}
