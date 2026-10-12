import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  validationContextSchema,
  type AssistResult,
} from "@/lib/assist/assist";
import type { DocFile, PullRequestSnapshot } from "@/lib/schemas";

/**
 * Persists one pipeline run over a labelled fixture (D-012) as a completed
 * analysis under a repository marked `source = 'fixture'`. Fixture data is never
 * stored with GitHub ids, so it can't be mistaken for a live repository.
 */
export async function saveFixtureAnalysis(
  pool: Pool,
  scenarioId: string,
  snapshot: PullRequestSnapshot,
  docs: readonly DocFile[],
  result: AssistResult,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO repositories (source, owner, name) VALUES ('fixture', 'fixture', $1)
       ON CONFLICT (owner, name) WHERE source = 'fixture' DO NOTHING`,
      [scenarioId],
    );
    const repoId = (
      await client.query<{ id: string }>(
        "SELECT id FROM repositories WHERE source = 'fixture' AND owner = 'fixture' AND name = $1",
        [scenarioId],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO pull_requests (repository_id, github_pr_number, head_sha, base_sha)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repository_id, github_pr_number, head_sha) DO NOTHING`,
      [repoId, snapshot.ref.number, snapshot.headSha, snapshot.baseSha],
    );
    const prId = (
      await client.query<{ id: string }>(
        `SELECT id FROM pull_requests
          WHERE repository_id = $1 AND github_pr_number = $2 AND head_sha = $3`,
        [repoId, snapshot.ref.number, snapshot.headSha],
      )
    ).rows[0]!.id;

    const changedFiles = snapshot.files.map((f) => ({
      path: f.path,
      ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patchState: f.patchState,
    }));
    const analysisId = (
      await client.query<{ id: string }>(
        `INSERT INTO analyses (pull_request_id, idempotency_key, status, started_at, completed_at,
                               pr_title, changed_files, engine_version, model_status, missing_context)
         VALUES ($1, $2, 'completed', now(), now(), $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          prId,
          // Every fixture run is a new analysis of the same fixture commit.
          `fixture:${scenarioId}:${randomUUID()}`,
          snapshot.title,
          JSON.stringify(changedFiles),
          result.deterministic.engineVersion,
          result.modelStatus,
          JSON.stringify(result.deterministic.missingContext),
        ],
      )
    ).rows[0]!.id;

    const candidateIds = new Map<string, string>();
    for (const c of result.deterministic.candidates) {
      const assessment = result.assessments.find(
        (a) => a.docPath === c.docPath,
      );
      const outcome = result.outcomes.find((o) => o.docPath === c.docPath);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO impact_candidates (analysis_id, doc_path, impact_status, reason, evidence,
                                        missing_context, rank_points, rules, engine_version,
                                        model_assessment, assist_outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          analysisId,
          c.docPath,
          c.status,
          c.reason,
          JSON.stringify(c.evidence),
          JSON.stringify(c.missingContext),
          c.rankPoints,
          JSON.stringify(c.rules),
          c.engineVersion,
          assessment ? JSON.stringify(assessment) : null,
          outcome ? JSON.stringify(outcome) : null,
        ],
      );
      candidateIds.set(c.docPath, rows[0]!.id);
    }

    for (const p of result.proposals) {
      const doc = docs.find((d) => d.path === p.targetPath)!;
      await client.query(
        `INSERT INTO patch_proposals (candidate_id, target_path, head_sha, base_blob_sha,
                                      base_content, patch_text, rationale, evidence,
                                      validation_status, validation_issues, validation_context, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          candidateIds.get(p.targetPath)!,
          p.targetPath,
          p.headSha,
          p.baseBlobSha,
          doc.content,
          p.patch,
          p.rationale,
          JSON.stringify(p.evidence),
          p.validationStatus,
          JSON.stringify(p.validationIssues),
          // Checked with the same schema that reads it back for edits.
          JSON.stringify(
            validationContextSchema.parse(
              result.validationContexts[p.targetPath],
            ),
          ),
          p.model ? JSON.stringify(p.model) : null,
        ],
      );
    }
    await client.query("COMMIT");
    return analysisId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
