import type { Pool } from "pg";
import type { EnqueueResult, PullRequestWork } from "@/lib/analysis-work";

/**
 * Records a queued analysis for one PR head commit. Safe under retries and
 * concurrent duplicate deliveries: the unique idempotency key means at most one
 * analysis row exists per key, and a duplicate returns the existing row.
 */
export async function enqueueAnalysis(
  pool: Pool,
  work: PullRequestWork,
  key: string,
  deliveryId: string,
): Promise<EnqueueResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Replayed or duplicate deliveries must not rewrite rows: the repository is
    // updated only when its identity actually changed, and an existing PR row is
    // left untouched. When nothing is written, RETURNING is empty, so read the id.
    const repoId =
      (
        await client.query<{ id: string }>(
          `INSERT INTO repositories (github_repo_id, owner, name, installation_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (github_repo_id) DO UPDATE
             SET owner = EXCLUDED.owner,
                 name = EXCLUDED.name,
                 installation_id = EXCLUDED.installation_id,
                 updated_at = now()
             WHERE (repositories.owner, repositories.name, repositories.installation_id)
                   IS DISTINCT FROM (EXCLUDED.owner, EXCLUDED.name, EXCLUDED.installation_id)
           RETURNING id`,
          [work.githubRepoId, work.owner, work.repo, work.installationId],
        )
      ).rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          "SELECT id FROM repositories WHERE github_repo_id = $1",
          [work.githubRepoId],
        )
      ).rows[0]!.id;
    const prId =
      (
        await client.query<{ id: string }>(
          `INSERT INTO pull_requests (repository_id, github_pr_number, head_sha, base_sha)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (repository_id, github_pr_number, head_sha) DO NOTHING
           RETURNING id`,
          [repoId, work.prNumber, work.headSha, work.baseSha],
        )
      ).rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `SELECT id FROM pull_requests
           WHERE repository_id = $1 AND github_pr_number = $2 AND head_sha = $3`,
          [repoId, work.prNumber, work.headSha],
        )
      ).rows[0]!.id;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO analyses (pull_request_id, idempotency_key, delivery_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [prId, key, deliveryId],
    );
    let result: EnqueueResult;
    if (inserted.rows[0]) {
      result = { analysisId: inserted.rows[0].id, created: true };
    } else {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM analyses WHERE idempotency_key = $1",
        [key],
      );
      result = { analysisId: existing.rows[0]!.id, created: false };
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
