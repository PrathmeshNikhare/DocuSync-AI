import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { validatePatch } from "@/lib/patches/validate";
import {
  reviewDecisionInputSchema,
  reviewDecisionRecordSchema,
  type ReviewDecisionRecord,
} from "@/lib/schemas";
import { validationContextSchema } from "@/lib/assist/assist";

export type DecideResult =
  | { ok: true; record: ReviewDecisionRecord }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "ALREADY_DECIDED"
        | "PROPOSAL_NOT_VALID"
        | "EDIT_UNCHANGED"
        | "EDIT_INVALID";
      issues?: string[];
    };

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Records the one final decision on a proposal (D-012). The reviewer comes from
 * the session and the proposal from the URL; only `decision` and `editedPatch`
 * come from the client. Everything else in the record is read from the stored
 * proposal, which the app role cannot change (migration 0004). The unique
 * proposal_id means two concurrent decisions can't both win.
 * Accepting is not a GitHub write.
 */
export async function decide(
  pool: Pool,
  reviewerId: string,
  proposalId: string,
  body: unknown,
): Promise<DecideResult> {
  const input = reviewDecisionInputSchema.safeParse(body);
  if (!input.success) return { ok: false, code: "INVALID_INPUT" };
  if (!z.uuid().safeParse(proposalId).success)
    return { ok: false, code: "NOT_FOUND" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      target_path: string;
      head_sha: string;
      base_blob_sha: string;
      base_content: string;
      patch_text: string;
      validation_status: string;
      validation_context: unknown;
      repository_id: string;
    }>(
      `SELECT pp.target_path, pp.head_sha, pp.base_blob_sha, pp.base_content, pp.patch_text,
              pp.validation_status, pp.validation_context, r.id AS repository_id
         FROM patch_proposals pp
         JOIN impact_candidates c ON c.id = pp.candidate_id
         JOIN analyses a ON a.id = c.analysis_id
         JOIN pull_requests p ON p.id = a.pull_request_id
         JOIN repositories r ON r.id = p.repository_id
         JOIN repository_reviewers rr ON rr.repository_id = r.id AND rr.reviewer_id = $1
        WHERE pp.id = $2`,
      [reviewerId, proposalId],
    );
    const p = rows[0];
    const fail = async (
      code: Extract<DecideResult, { ok: false }>["code"],
      issues?: string[],
    ) => {
      await client.query("ROLLBACK");
      return { ok: false as const, code, ...(issues ? { issues } : {}) };
    };
    if (!p) return await fail("NOT_FOUND");
    const existing = await client.query(
      "SELECT 1 FROM review_decisions WHERE proposal_id = $1",
      [proposalId],
    );
    if (existing.rowCount) return await fail("ALREADY_DECIDED");
    if (p.validation_status !== "valid")
      return await fail("PROPOSAL_NOT_VALID");

    const decision = input.data;
    // Whatever is approved is validated now, against the stored doc and context:
    // the reviewer's edit, and on accept the stored patch too, so a row that was
    // marked valid without passing (a future writer, a manual fix) is never approved.
    const check = (patch: string) => {
      const context = validationContextSchema.parse(p.validation_context);
      return validatePatch({
        targetPath: p.target_path,
        patch,
        baseBlobSha: p.base_blob_sha,
        doc: { path: p.target_path, content: p.base_content },
        relatedLines: context.relatedLines,
        relatedTerms: context.relatedTerms,
        knownLinks: new Set(context.knownLinks),
      });
    };
    if (decision.decision === "edited") {
      if (decision.editedPatch === p.patch_text)
        return await fail("EDIT_UNCHANGED");
      const checked = check(decision.editedPatch);
      if (!checked.ok) return await fail("EDIT_INVALID", checked.issues);
    } else if (decision.decision === "accepted") {
      const checked = check(p.patch_text);
      if (!checked.ok) return await fail("PROPOSAL_NOT_VALID", checked.issues);
    }

    const approvedPatch =
      decision.decision === "edited" ? decision.editedPatch : p.patch_text;
    const inserted = await client.query<{ decided_at: Date }>(
      `INSERT INTO review_decisions (proposal_id, reviewer_id, decision, edited_patch,
                                     repository_id, head_sha, base_blob_sha, patch_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING decided_at`,
      [
        proposalId,
        reviewerId,
        decision.decision,
        decision.decision === "edited" ? decision.editedPatch : null,
        p.repository_id,
        p.head_sha,
        p.base_blob_sha,
        sha256(approvedPatch),
      ],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      record: reviewDecisionRecordSchema.parse({
        ...decision,
        proposalId,
        reviewerId,
        repositoryId: p.repository_id,
        headSha: p.head_sha,
        baseBlobSha: p.base_blob_sha,
        patchSha256: sha256(approvedPatch),
        decidedAt: inserted.rows[0]!.decided_at.toISOString(),
      }),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // A concurrent decision that got in first: the unique proposal_id refuses this one.
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, code: "ALREADY_DECIDED" };
    }
    throw err;
  } finally {
    client.release();
  }
}
