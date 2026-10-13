import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  validationContextSchema,
  type AssistResult,
} from "@/lib/assist/assist";
import type { DocFile, PullRequestSnapshot } from "@/lib/schemas";

export type AnalysisSource =
  | { kind: "fixture"; scenarioId: string }
  | {
      kind: "github";
      githubRepoId: number;
      /** GitHub's canonical owner and name; default to the snapshot's ref. */
      owner?: string;
      name?: string;
      installationId: number;
      headRef: string;
      baseRef: string;
      /** Notes from fetching the docs (skipped files, a truncated tree). */
      notes: readonly string[];
      /** Some documentation could not be read: the analysis is partial. */
      docsPartial?: boolean;
    };

/**
 * Persists one pipeline run over a labelled fixture (D-012) as a completed
 * analysis under a repository marked `source = 'fixture'`. Fixture data is never
 * stored with GitHub ids, so it can't be mistaken for a live repository.
 */
export const saveFixtureAnalysis = (
  pool: Pool,
  scenarioId: string,
  snapshot: PullRequestSnapshot,
  docs: readonly DocFile[],
  result: AssistResult,
) =>
  saveAnalysis(pool, { kind: "fixture", scenarioId }, snapshot, docs, result);

/**
 * Persists one completed pipeline run. A live run (docs/13) upserts its
 * repository by GitHub id exactly as the webhook does, and records the PR's
 * current branch names, also on a PR row the webhook or an earlier run created
 * (a retargeted PR is re-analysed without a new commit). Outputs already
 * requested keep their own snapshot of the docs PR's base.
 */
export async function saveAnalysis(
  pool: Pool,
  source: AnalysisSource,
  snapshot: PullRequestSnapshot,
  docs: readonly DocFile[],
  result: AssistResult,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let repoId: string;
    if (source.kind === "fixture") {
      await client.query(
        `INSERT INTO repositories (source, owner, name) VALUES ('fixture', 'fixture', $1)
         ON CONFLICT (owner, name) WHERE source = 'fixture' DO NOTHING`,
        [source.scenarioId],
      );
      repoId = (
        await client.query<{ id: string }>(
          "SELECT id FROM repositories WHERE source = 'fixture' AND owner = 'fixture' AND name = $1",
          [source.scenarioId],
        )
      ).rows[0]!.id;
    } else {
      await client.query(
        `INSERT INTO repositories (github_repo_id, owner, name, installation_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (github_repo_id) DO UPDATE
           SET owner = EXCLUDED.owner, name = EXCLUDED.name,
               installation_id = EXCLUDED.installation_id, updated_at = now()
           WHERE (repositories.owner, repositories.name, repositories.installation_id)
                 IS DISTINCT FROM (EXCLUDED.owner, EXCLUDED.name, EXCLUDED.installation_id)`,
        [
          source.githubRepoId,
          source.owner ?? snapshot.ref.owner,
          source.name ?? snapshot.ref.repo,
          source.installationId,
        ],
      );
      repoId = (
        await client.query<{ id: string }>(
          "SELECT id FROM repositories WHERE github_repo_id = $1",
          [source.githubRepoId],
        )
      ).rows[0]!.id;
    }
    const refs =
      source.kind === "github"
        ? [source.headRef, source.baseRef]
        : [null, null];
    await client.query(
      `INSERT INTO pull_requests (repository_id, github_pr_number, head_sha, base_sha, head_ref, base_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (repository_id, github_pr_number, head_sha) DO UPDATE
         SET head_ref = EXCLUDED.head_ref, base_ref = EXCLUDED.base_ref
         WHERE EXCLUDED.head_ref IS NOT NULL
           AND (pull_requests.head_ref, pull_requests.base_ref)
               IS DISTINCT FROM (EXCLUDED.head_ref, EXCLUDED.base_ref)`,
      [
        repoId,
        snapshot.ref.number,
        snapshot.headSha,
        snapshot.baseSha,
        ...refs,
      ],
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
                               pr_title, changed_files, engine_version, model_status, missing_context,
                               docs_partial)
         VALUES ($1, $2, 'completed', now(), now(), $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          prId,
          // Every run is a new analysis of the same commit.
          source.kind === "fixture"
            ? `fixture:${source.scenarioId}:${randomUUID()}`
            : `live:${source.githubRepoId}:${snapshot.ref.number}:${randomUUID()}`,
          snapshot.title,
          JSON.stringify(changedFiles),
          result.deterministic.engineVersion,
          result.modelStatus,
          JSON.stringify([
            ...(source.kind === "github" ? source.notes : []),
            ...result.deterministic.missingContext,
          ]),
          source.kind === "github" && source.docsPartial === true,
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
