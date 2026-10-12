// Seeding for review DB tests: real pipeline output (scripted model) saved as a
// fixture analysis, plus reviewers and grants created with the owner role.
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { assistImpact } from "@/lib/assist/assist";
import {
  scenarioSchema,
  snapshotFor,
  type Scenario,
} from "@/lib/impact-engine/evaluate";
import type { ChatResponse, LlmProvider } from "@/lib/llm/provider";
import { saveFixtureAnalysis } from "@/lib/review/store";
import { withOwner } from "./db";

export const PASSWORD = "correct horse battery staple";
export const DOC_PATH = "docs/configuration.md";

export const scenario = scenarioSchema.parse(
  JSON.parse(readFileSync("fixtures/impact/env-var-renamed.json", "utf8")),
);
export const docs = Object.entries(scenario.docs).map(([p, content]) => ({
  path: p,
  content,
}));

export const addReviewer = (
  ownerUrl: string,
  username: string,
  passwordHash: string,
  disabled = false,
) =>
  withOwner(ownerUrl, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO reviewers (username, display_name, password_hash, disabled_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        username,
        username.toUpperCase(),
        passwordHash,
        disabled ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  });

export const grant = (
  ownerUrl: string,
  reviewerId: string,
  repositoryId: string,
) =>
  withOwner(ownerUrl, (c) =>
    c.query(
      "INSERT INTO repository_reviewers (repository_id, reviewer_id) VALUES ($1, $2)",
      [repositoryId, reviewerId],
    ),
  );

function scripted(replies: unknown[]): LlmProvider {
  return {
    provider: "mock",
    modelId: "mock-1",
    async chat(): Promise<ChatResponse> {
      return { ok: true, content: JSON.stringify(replies.shift()) };
    },
  };
}

/** A completed fixture analysis with one valid proposal (API_TOKEN -> API_KEY). */
export async function seedAnalysis(pool: Pool, s: Scenario = scenario) {
  const snapshot = snapshotFor(s);
  const sDocs = Object.entries(s.docs).map(([p, content]) => ({
    path: p,
    content,
  }));
  const result = await assistImpact(
    snapshot,
    sDocs,
    scripted([
      { verdict: "needs_update", explanation: "Renamed.", citedEvidence: [0] },
      {
        edits: [{ find: "`API_TOKEN`", replace: "`API_KEY`" }],
        rationale: "Rename.",
      },
    ]),
  );
  if (result.proposals.length !== 1)
    throw new Error("seed: expected one proposal");
  const analysisId = await saveFixtureAnalysis(
    pool,
    s.id,
    snapshot,
    sDocs,
    result,
  );
  const { rows } = await pool.query<{
    repository_id: string;
    proposal_id: string;
  }>(
    `SELECT p.repository_id, pp.id AS proposal_id FROM analyses a
       JOIN pull_requests p ON p.id = a.pull_request_id
       JOIN impact_candidates c ON c.analysis_id = a.id
       JOIN patch_proposals pp ON pp.candidate_id = c.id WHERE a.id = $1`,
    [analysisId],
  );
  return {
    analysisId,
    repositoryId: rows[0]!.repository_id,
    proposalId: rows[0]!.proposal_id,
  };
}
