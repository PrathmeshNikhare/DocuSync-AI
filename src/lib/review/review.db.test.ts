import { createHash } from "node:crypto";
import path from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { migrate } from "@/lib/db/migrate";
import { renderEdits } from "@/lib/patches/diff";
import { appPool, requireTestDbUrls, withOwner } from "@/test/db";
import {
  DOC_PATH,
  PASSWORD,
  addReviewer as addReviewerAs,
  grant as grantAs,
  scenario,
  seedAnalysis as seed,
} from "@/test/review-seed";
import { decide } from "./decisions";
import { hashPassword } from "./password";
import { getAnalysis, getDashboard, getReview } from "./queries";
import {
  LOGIN_LIMIT,
  MAX_CONCURRENT_LOGINS,
  MAX_SESSIONS_PER_REVIEWER,
  login,
  reviewerForToken,
  revokeSession,
} from "./session";

const { appUrl, ownerUrl } = requireTestDbUrls();
let pool: Pool;
let passwordHash: string;
const addReviewer = (username: string, disabled = false) =>
  addReviewerAs(ownerUrl, username, passwordHash, disabled);
const grant = (reviewerId: string, repositoryId: string) =>
  grantAs(ownerUrl, reviewerId, repositoryId);
const seedAnalysis = () => seed(pool);

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await withOwner(ownerUrl, (c) =>
    migrate(c, path.join(process.cwd(), "migrations")),
  );
  pool = appPool(appUrl);
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await withOwner(ownerUrl, (c) =>
    c.query(
      "TRUNCATE repositories, reviewers, sessions, login_failures CASCADE",
    ),
  );
});

describe("login and sessions", () => {
  it("creates a session for valid credentials and resolves the reviewer", async () => {
    const id = await addReviewer("alice");
    const r = await login(pool, "alice", PASSWORD);
    expect(r).toMatchObject({ ok: true, reviewer: { id, username: "alice" } });
    const token = r.ok ? r.token : "";
    expect(await reviewerForToken(pool, token)).toMatchObject({ id });
    // Only a hash of the token is stored.
    const { rows } = await pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions",
    );
    expect(rows[0]!.token_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(rows[0]!.token_hash).not.toContain(token);
  });

  it("gives one generic error for a wrong password, unknown or disabled user", async () => {
    await addReviewer("alice");
    await addReviewer("bob", true);
    for (const [u, p] of [
      ["alice", "wrong password!!"],
      ["nobody", PASSWORD],
      ["bob", PASSWORD],
      ["Not A Username", PASSWORD],
    ] as const) {
      expect(await login(pool, u, p)).toEqual({
        ok: false,
        code: "INVALID_CREDENTIALS",
      });
    }
  });

  it("can't be raced: concurrent guesses get exactly the allowed number of tries", async () => {
    await addReviewer("alice");
    // Waves of as many attempts as the process checks at once. Without the
    // per-username lock, the second wave would all see 4 failures and all be checked.
    const codes: string[] = [];
    for (let wave = 0; wave < 5; wave++) {
      const results = await Promise.all(
        Array.from({ length: MAX_CONCURRENT_LOGINS }, () =>
          login(pool, "alice", "wrong password!!"),
        ),
      );
      codes.push(...results.map((r) => (r.ok ? "OK" : r.code)));
    }
    expect(codes.filter((c) => c === "INVALID_CREDENTIALS")).toHaveLength(
      LOGIN_LIMIT.failures,
    );
    expect(codes.filter((c) => c === "RATE_LIMITED")).toHaveLength(
      5 * MAX_CONCURRENT_LOGINS - LOGIN_LIMIT.failures,
    );
  });

  it("checks at most a few sign-ins at once and refuses the rest as busy", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        login(pool, `user${i}`, "wrong password!!"),
      ),
    );
    const codes = results.map((r) => (r.ok ? "OK" : r.code));
    expect(codes.filter((c) => c === "INVALID_CREDENTIALS")).toHaveLength(
      MAX_CONCURRENT_LOGINS,
    );
    expect(codes.filter((c) => c === "BUSY")).toHaveLength(
      10 - MAX_CONCURRENT_LOGINS,
    );
  });

  it("refuses a malformed username at once, without recording or hashing", async () => {
    const started = performance.now();
    expect(await login(pool, "Not A Username", PASSWORD)).toEqual({
      ok: false,
      code: "INVALID_CREDENTIALS",
    });
    expect(performance.now() - started).toBeLessThan(15); // a scrypt run takes far longer
    const { rows } = await pool.query("SELECT 1 FROM login_failures");
    expect(rows).toHaveLength(0);
  });

  it("records nothing for a successful sign-in, so earlier failures still count", async () => {
    await addReviewer("alice");
    for (let i = 0; i < LOGIN_LIMIT.failures - 1; i++) {
      await login(pool, "alice", "wrong password!!");
    }
    expect((await login(pool, "alice", PASSWORD)).ok).toBe(true);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM login_failures WHERE username = 'alice'",
    );
    expect(Number(rows[0]!.n)).toBe(LOGIN_LIMIT.failures - 1);
  });

  it("refuses further tries after repeated failures, even with the right password", async () => {
    await addReviewer("alice");
    for (let i = 0; i < LOGIN_LIMIT.failures; i++) {
      await login(pool, "alice", "wrong password!!");
    }
    expect(await login(pool, "alice", PASSWORD)).toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
  });

  it("rejects revoked, expired, malformed and disabled-reviewer sessions", async () => {
    const id = await addReviewer("alice");
    const r = await login(pool, "alice", PASSWORD);
    const token = r.ok ? r.token : "";
    await revokeSession(pool, token);
    expect(await reviewerForToken(pool, token)).toBeUndefined();

    const r2 = await login(pool, "alice", PASSWORD);
    const t2 = r2.ok ? r2.token : "";
    await withOwner(ownerUrl, (c) =>
      c.query(
        "UPDATE sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'",
      ),
    );
    expect(await reviewerForToken(pool, t2)).toBeUndefined();

    const r3 = await login(pool, "alice", PASSWORD);
    await withOwner(ownerUrl, (c) =>
      c.query("UPDATE reviewers SET disabled_at = now() WHERE id = $1", [id]),
    );
    expect(await reviewerForToken(pool, r3.ok ? r3.token : "")).toBeUndefined();
    expect(await reviewerForToken(pool, "x' OR 1=1 --")).toBeUndefined();
    expect(await reviewerForToken(pool, undefined)).toBeUndefined();
  });

  it("keeps at most a few live sessions per reviewer, revoking the oldest", async () => {
    await addReviewer("alice");
    const tokens: string[] = [];
    for (let i = 0; i <= MAX_SESSIONS_PER_REVIEWER; i++) {
      const r = await login(pool, "alice", PASSWORD);
      tokens.push(r.ok ? r.token : "");
    }
    expect(await reviewerForToken(pool, tokens[0])).toBeUndefined();
    for (const t of tokens.slice(1))
      expect(await reviewerForToken(pool, t)).toBeDefined();
    const { rows } = await pool.query<{ live: string }>(
      "SELECT count(*) AS live FROM sessions WHERE revoked_at IS NULL",
    );
    expect(Number(rows[0]!.live)).toBe(MAX_SESSIONS_PER_REVIEWER);
  });
});

describe("authorized reads", () => {
  it("show analyses, candidates and proposals only to granted reviewers", async () => {
    const alice = await addReviewer("alice");
    const mallory = await addReviewer("mallory");
    const { analysisId, repositoryId, proposalId } = await seedAnalysis();
    await grant(alice, repositoryId);

    const dash = await getDashboard(pool, alice);
    expect(dash.repositories).toEqual([
      {
        id: repositoryId,
        source: "fixture",
        owner: "fixture",
        name: scenario.id,
        analyses: 1,
      },
    ]);
    expect(dash.analyses[0]).toMatchObject({
      id: analysisId,
      flagged: 1,
      proposals: 1,
      decided: 0,
    });

    const a = await getAnalysis(pool, alice, analysisId);
    expect(a?.candidates[0]).toMatchObject({
      docPath: DOC_PATH,
      status: "likely_affected",
      modelAssessment: { verdict: "needs_update" },
      proposal: { id: proposalId, decision: null },
    });
    expect(a?.changedFiles[0]).toMatchObject({ path: "src/config.ts" });

    const review = await getReview(pool, alice, proposalId);
    expect(review?.proposal.baseContent).toBe(scenario.docs[DOC_PATH]);
    expect(review?.repository.source).toBe("fixture");

    // No grant: indistinguishable from a missing id.
    expect(await getDashboard(pool, mallory)).toEqual({
      repositories: [],
      analyses: [],
    });
    expect(await getAnalysis(pool, mallory, analysisId)).toBeUndefined();
    expect(await getReview(pool, mallory, proposalId)).toBeUndefined();
    expect(await getReview(pool, alice, "not-a-uuid")).toBeUndefined();
  });

  it("stores fixture repositories without GitHub ids", async () => {
    await seedAnalysis();
    const { rows } = await pool.query(
      "SELECT source, github_repo_id, installation_id FROM repositories",
    );
    expect(rows).toEqual([
      { source: "fixture", github_repo_id: null, installation_id: null },
    ]);
  });
});

describe("decide", () => {
  let alice: string;
  let seeded: Awaited<ReturnType<typeof seedAnalysis>>;
  beforeEach(async () => {
    alice = await addReviewer("alice");
    seeded = await seedAnalysis();
    await grant(alice, seeded.repositoryId);
  });

  it("records an acceptance bound to the reviewed revision and patch bytes", async () => {
    const review = (await getReview(pool, alice, seeded.proposalId))!;
    const r = await decide(pool, alice, seeded.proposalId, {
      decision: "accepted",
    });
    expect(r).toMatchObject({
      ok: true,
      record: {
        decision: "accepted",
        proposalId: seeded.proposalId,
        reviewerId: alice,
        repositoryId: seeded.repositoryId,
        headSha: review.proposal.headSha,
        baseBlobSha: review.proposal.baseBlobSha,
        patchSha256: createHash("sha256")
          .update(review.proposal.patch)
          .digest("hex"),
      },
    });
    expect(
      (await getReview(pool, alice, seeded.proposalId))!.decision,
    ).toMatchObject({
      decision: "accepted",
      reviewer: { username: "alice" },
    });
  });

  it("allows exactly one decision per proposal", async () => {
    expect(
      (await decide(pool, alice, seeded.proposalId, { decision: "rejected" }))
        .ok,
    ).toBe(true);
    expect(
      await decide(pool, alice, seeded.proposalId, { decision: "accepted" }),
    ).toEqual({
      ok: false,
      code: "ALREADY_DECIDED",
    });
  });

  it("lets only one of many concurrent decisions win", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        decide(pool, alice, seeded.proposalId, {
          decision: i % 2 ? "accepted" : "rejected",
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results
        .filter((r) => !r.ok)
        .every((r) => !r.ok && r.code === "ALREADY_DECIDED"),
    ).toBe(true);
  });

  it("accepts a valid edit and hashes the edited patch", async () => {
    const edited = renderEdits(DOC_PATH, scenario.docs[DOC_PATH]!, [
      {
        find: "| `API_TOKEN` | Token for the upstream API |",
        replace: "| `API_KEY` | Key for the upstream API |",
      },
    ]);
    expect(edited.ok).toBe(true);
    const patch = edited.ok ? edited.patch : "";
    const r = await decide(pool, alice, seeded.proposalId, {
      decision: "edited",
      editedPatch: patch,
    });
    expect(r).toMatchObject({
      ok: true,
      record: {
        decision: "edited",
        editedPatch: patch,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
      },
    });
  });

  it("rejects an edit that fails validation, is unchanged, or targets another file", async () => {
    const review = (await getReview(pool, alice, seeded.proposalId))!;
    expect(
      await decide(pool, alice, seeded.proposalId, {
        decision: "edited",
        editedPatch: review.proposal.patch,
      }),
    ).toEqual({ ok: false, code: "EDIT_UNCHANGED" });
    const phishing = renderEdits(DOC_PATH, scenario.docs[DOC_PATH]!, [
      {
        find: "`API_TOKEN`",
        replace: "`API_KEY` (rotate at https://evil.example)",
      },
    ]);
    expect(
      await decide(pool, alice, seeded.proposalId, {
        decision: "edited",
        editedPatch: phishing.ok ? phishing.patch : "",
      }),
    ).toEqual({ ok: false, code: "EDIT_INVALID", issues: ["PATCH_NEW_URL"] });
    expect(
      await decide(pool, alice, seeded.proposalId, {
        decision: "edited",
        editedPatch: review.proposal.patch.replaceAll(
          DOC_PATH,
          ".github/workflows/ci.yml",
        ),
      }),
    ).toMatchObject({ ok: false, code: "EDIT_INVALID" });
    // Nothing was recorded by the failed attempts.
    expect(
      (await getReview(pool, alice, seeded.proposalId))!.decision,
    ).toBeNull();
  });

  it("rejects bodies with extra fields or a client-chosen reviewer", async () => {
    for (const body of [
      { decision: "approve" },
      { decision: "accepted", reviewerId: alice },
      { decision: "accepted", proposalId: seeded.proposalId },
      { decision: "edited" },
      null,
    ]) {
      expect(await decide(pool, alice, seeded.proposalId, body)).toEqual({
        ok: false,
        code: "INVALID_INPUT",
      });
    }
  });

  it("hides proposals the reviewer has no grant for", async () => {
    const mallory = await addReviewer("mallory");
    expect(
      await decide(pool, mallory, seeded.proposalId, { decision: "accepted" }),
    ).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(
      await decide(pool, alice, "00000000-0000-4000-8000-000000000000", {
        decision: "accepted",
      }),
    ).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("re-validates the stored patch on accept, even if the row says valid", async () => {
    // A row marked valid that no longer passes (a future writer, a manual fix).
    await withOwner(ownerUrl, (c) =>
      c.query(
        `UPDATE patch_proposals SET patch_text = replace(patch_text, '+++ b/docs/', '+++ b/.github/')`,
      ),
    );
    expect(
      await decide(pool, alice, seeded.proposalId, { decision: "accepted" }),
    ).toMatchObject({
      ok: false,
      code: "PROPOSAL_NOT_VALID",
      issues: ["PATCH_HEADER_MISMATCH"],
    });
    // Rejecting doesn't approve anything, so it needs no re-validation.
    expect(
      (await decide(pool, alice, seeded.proposalId, { decision: "rejected" }))
        .ok,
    ).toBe(true);
  });

  it("refuses a decision on a proposal that is not valid", async () => {
    await withOwner(ownerUrl, (c) =>
      c.query(
        `UPDATE patch_proposals SET validation_status = 'invalid', validation_issues = '["PATCH_STALE_BASE"]'`,
      ),
    );
    expect(
      await decide(pool, alice, seeded.proposalId, { decision: "accepted" }),
    ).toEqual({
      ok: false,
      code: "PROPOSAL_NOT_VALID",
    });
  });
});

describe("large pull requests", () => {
  it("store a bounded validation context, so an edit on a big PR still validates", async () => {
    // 260 exported names (past the old 200-name read limit) and a 4,100-character URL.
    const exports = Array.from(
      { length: 260 },
      (_, i) => `+export const name${i} = ${i};`,
    );
    const longUrl = `+// see https://example.com/${"a".repeat(4_100)}`;
    const big = {
      ...scenario,
      files: [
        ...scenario.files,
        {
          filename: "src/many.ts",
          status: "added",
          additions: exports.length + 1,
          deletions: 0,
          changes: exports.length + 1,
          patch: [
            `@@ -0,0 +1,${exports.length + 1} @@`,
            ...exports,
            longUrl,
          ].join("\n"),
        },
      ],
    };
    const alice = await addReviewer("alice");
    const seeded = await seed(pool, big);
    await grant(alice, seeded.repositoryId);
    const { rows } = await pool.query<{
      ctx: { relatedTerms: string[]; knownLinks: string[] };
    }>("SELECT validation_context AS ctx FROM patch_proposals WHERE id = $1", [
      seeded.proposalId,
    ]);
    expect(rows[0]!.ctx.relatedTerms.length).toBeGreaterThan(200);
    expect(rows[0]!.ctx.knownLinks.every((l) => l.length <= 2_000)).toBe(true);
    const edited = renderEdits(DOC_PATH, scenario.docs[DOC_PATH]!, [
      {
        find: "| `API_TOKEN` | Token for the upstream API |",
        replace: "| `API_KEY` | Key for the upstream API |",
      },
    ]);
    expect(
      await decide(pool, alice, seeded.proposalId, {
        decision: "edited",
        editedPatch: edited.ok ? edited.patch : "",
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("app role limits", () => {
  it("lets the database refuse a second decision even if the app check is bypassed", async () => {
    const alice = await addReviewer("alice");
    const seeded = await seedAnalysis();
    await grant(alice, seeded.repositoryId);
    await decide(pool, alice, seeded.proposalId, { decision: "accepted" });
    await expect(
      pool.query(
        `INSERT INTO review_decisions (proposal_id, reviewer_id, decision, repository_id,
                                       head_sha, base_blob_sha, patch_sha256)
         SELECT proposal_id, reviewer_id, 'rejected', repository_id, head_sha, base_blob_sha, patch_sha256
           FROM review_decisions`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps the audit trail append-only and accounts operator-only", async () => {
    const alice = await addReviewer("alice");
    const seeded = await seedAnalysis();
    await grant(alice, seeded.repositoryId);
    await decide(pool, alice, seeded.proposalId, { decision: "accepted" });
    for (const sql of [
      "UPDATE review_decisions SET decision = 'rejected'",
      "DELETE FROM review_decisions",
      "TRUNCATE review_decisions",
      `INSERT INTO reviewers (username, display_name, password_hash) VALUES ('eve', 'Eve', 'scrypt$x')`,
      `UPDATE reviewers SET disabled_at = NULL`,
      `INSERT INTO repository_reviewers (repository_id, reviewer_id) VALUES ('${seeded.repositoryId}', '${alice}')`,
      "DELETE FROM repository_reviewers",
      "UPDATE repository_reviewers SET granted_at = now()",
      "TRUNCATE reviewers CASCADE",
      "TRUNCATE repository_reviewers",
      "TRUNCATE sessions",
      "TRUNCATE login_failures",
      // Stored proposals can't change after display or approval (security L-A).
      "UPDATE patch_proposals SET patch_text = patch_text",
      "DELETE FROM patch_proposals",
      "UPDATE impact_candidates SET reason = reason",
      "DELETE FROM impact_candidates",
      // Sessions can only be revoked: not extended, un-revoked or deleted (L-C).
      "UPDATE sessions SET expires_at = now() + interval '1 year'",
      "UPDATE sessions SET revoked_at = NULL, reviewer_id = reviewer_id",
      "DELETE FROM sessions",
    ]) {
      await expect(pool.query(sql), sql).rejects.toMatchObject({
        code: "42501",
      });
    }
  });
});
