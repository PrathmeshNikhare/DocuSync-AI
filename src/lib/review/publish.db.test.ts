import { createHash, generateKeyPairSync } from "node:crypto";
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
import { assistImpact } from "@/lib/assist/assist";
import { enqueueAnalysis } from "@/lib/db/analyses";
import { migrate } from "@/lib/db/migrate";
import { openGitHubWriter } from "@/lib/github/writer";
import { snapshotFor } from "@/lib/impact-engine/evaluate";
import type { ChatResponse, LlmProvider } from "@/lib/llm/provider";
import { appPool, requireTestDbUrls, withOwner } from "@/test/db";
import { FakeGitHub, randomSha } from "@/test/fake-github";
import {
  DOC_PATH,
  PASSWORD,
  addReviewer as addReviewerAs,
  grant as grantAs,
  scenario,
  seedAnalysis,
} from "@/test/review-seed";
import { decide } from "./decisions";
import { hashPassword } from "./password";
import { createDocsPr, MAX_ATTEMPTS, type PublishDeps } from "./publish";
import { saveAnalysis } from "./store";

const { appUrl, ownerUrl } = requireTestDbUrls();
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const ON = { GITHUB_WRITES_ENABLED: "true" };
const SLUG = "docusync-test";
let pool: Pool;
let passwordHash: string;

const owner = <T extends object = object>(
  sql: string,
  params: unknown[] = [],
) =>
  withOwner(ownerUrl, (c) => c.query<T & Record<string, unknown>>(sql, params));

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
  await owner(
    "TRUNCATE repositories, reviewers, sessions, login_failures CASCADE",
  );
});

function scripted(): LlmProvider {
  const replies: unknown[] = [
    { verdict: "needs_update", explanation: "Renamed.", citedEvidence: [0] },
    {
      edits: [{ find: "`API_TOKEN`", replace: "`API_KEY`" }],
      rationale: "Rename @org/team see #1.",
    },
  ];
  return {
    provider: "mock",
    modelId: "mock-1",
    async chat(): Promise<ChatResponse> {
      return { ok: true, content: JSON.stringify(replies.shift()) };
    },
  };
}

const docs = Object.entries(scenario.docs).map(([p, content]) => ({
  path: p,
  content,
}));

/** A live analysis of PR acme/widgets#5 whose GitHub state is `gh`, decided by alice. */
async function setup(decision: "accepted" | "rejected" | "none" = "accepted") {
  const gh = new FakeGitHub({
    owner: "acme",
    repo: "widgets",
    repoId: 42,
    installationId: 7,
    files: { ...scenario.docs, "src/config.ts": "export {}" },
    pullNumber: 5,
    headRef: "feature/rename",
    baseRef: "main",
    appSlug: SLUG,
  });
  const snapshot = {
    ...snapshotFor(scenario),
    ref: { owner: "acme", repo: "widgets", number: 5 },
    headSha: gh.headSha,
  };
  const result = await assistImpact(snapshot, docs, scripted());
  expect(result.proposals).toHaveLength(1);
  const analysisId = await saveAnalysis(
    pool,
    {
      kind: "github",
      githubRepoId: 42,
      installationId: 7,
      headRef: "feature/rename",
      baseRef: "main",
      notes: [],
    },
    snapshot,
    docs,
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
  const { repository_id: repositoryId, proposal_id: proposalId } = rows[0]!;
  const alice = await addReviewerAs(ownerUrl, "alice", passwordHash);
  const bob = await addReviewerAs(ownerUrl, "bob", passwordHash);
  await grantAs(ownerUrl, alice, repositoryId);
  await grantAs(ownerUrl, bob, repositoryId);
  let echo = { headSha: gh.headSha, patchSha256: "0".repeat(64) };
  if (decision !== "none") {
    const d = await decide(pool, alice, proposalId, { decision });
    if (!d.ok) throw new Error(`setup: ${d.code}`);
    echo = { headSha: d.record.headSha, patchSha256: d.record.patchSha256 };
  }
  const deps = (over: Partial<PublishDeps> = {}): PublishDeps => ({
    pool,
    env: ON,
    allowedInstallationIds: () => new Set([7]),
    appSlug: () => SLUG,
    openWriter: (binding, signal) =>
      openGitHubWriter({
        appId: "1",
        privateKey,
        binding,
        signal,
        fetch: gh.fetch,
        env: ON,
      }),
    ...over,
  });
  const publish = (who = bob, body: unknown = echo, d = deps()) =>
    createDocsPr(d, who, proposalId, body);
  return { gh, alice, bob, proposalId, repositoryId, echo, deps, publish };
}

const expected = scenario.docs[DOC_PATH]!.replace("`API_TOKEN`", "`API_KEY`");
const docsPrs = (gh: FakeGitHub) => gh.pulls.filter((p) => p.number !== 5);
const allowRetry = () =>
  owner("UPDATE github_outputs SET updated_at = now() - interval '1 minute'");
const outputRow = async () =>
  (
    await owner<{
      step: string;
      error_code: string | null;
      attempts: number;
      commit_sha: string | null;
    }>("SELECT step, error_code, attempts, commit_sha FROM github_outputs")
  ).rows[0];

describe("createDocsPr", () => {
  it("opens one branch, one commit of the approved change and one PR, then revokes the token", async () => {
    const { gh, publish, bob } = await setup();
    const r = await publish();
    expect(r).toMatchObject({
      ok: true,
      prNumber: 101,
      created: true,
      prUrl: "https://github.com/acme/widgets/pull/101",
    });
    const branch = [...gh.branches.keys()].find((b) =>
      b.startsWith("docusync/"),
    )!;
    expect(branch).toMatch(/^docusync\/pr-5-[0-9a-f]{12}$/);
    const tip = gh.branches.get(branch)!;
    expect(gh.commits.get(tip)!.parent).toBe(gh.headSha);
    expect(gh.fileAt(tip, DOC_PATH)).toBe(expected);
    expect(gh.fileAt(tip, "src/config.ts")).toBe("export {}");
    const [pr] = docsPrs(gh) as ((typeof gh.pulls)[number] & {
      body: string;
      title: string;
      maintainer_can_modify: unknown;
    })[];
    expect(pr).toMatchObject({
      base: { ref: "feature/rename" },
      head: { ref: branch, sha: tip },
      maintainer_can_modify: false,
      title: `docs: update ${DOC_PATH} for #5`,
    });
    expect(pr!.body).toContain("`ALICE`"); // the decider's display name
    expect(pr!.body).not.toContain("alice"); // never the username
    // Model text only inside a fenced block, where GitHub links nothing.
    expect(pr!.body).toContain("```text\nRename @org/team see #1.\n```");
    expect(gh.revoked).toBe(1);
    expect(await outputRow()).toMatchObject({
      step: "pr_opened",
      error_code: null,
      attempts: 1,
    });
    const attempts = await owner<{ reviewer_id: string }>(
      "SELECT reviewer_id FROM github_output_attempts",
    );
    expect(attempts.rows).toEqual([{ reviewer_id: bob }]);
  });

  it("answers a repeated request with the same PR and no GitHub call", async () => {
    const { gh, publish } = await setup();
    const first = await publish();
    const before = gh.requests.length;
    const again = await publish();
    expect(again).toMatchObject({
      ok: true,
      created: false,
      prUrl: first.ok ? first.prUrl : "",
    });
    expect(gh.requests.length).toBe(before);
    expect(docsPrs(gh)).toHaveLength(1);
  });

  it("lets only one of concurrent requests write", async () => {
    const { gh, publish } = await setup();
    const results = await Promise.all([publish(), publish(), publish()]);
    expect(docsPrs(gh)).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    for (const r of results.filter((r) => !(r.ok && r.created)))
      expect(r.ok ? "same" : r.code).toMatch(/^(same|IN_PROGRESS)$/);
    expect(gh.writes.filter((w) => w.startsWith("PUT"))).toHaveLength(1);
  });
});

describe("no GitHub write without a valid approval", () => {
  const cases: [
    string,
    (s: Awaited<ReturnType<typeof setup>>) => Promise<unknown>,
    string,
    ("accepted" | "rejected" | "none")?,
  ][] = [
    [
      "writes disabled",
      (s) => createDocsPr(s.deps({ env: {} }), s.bob, s.proposalId, s.echo),
      "WRITES_DISABLED",
    ],
    ["no decision", (s) => s.publish(), "NOT_DECIDED", "none"],
    [
      "a rejected proposal",
      (s) => s.publish(),
      "PROPOSAL_REJECTED",
      "rejected",
    ],
    [
      "a requester without the grant",
      async (s) => {
        await owner("DELETE FROM repository_reviewers WHERE reviewer_id = $1", [
          s.bob,
        ]);
        return s.publish();
      },
      "NOT_FOUND",
    ],
    [
      "a decider who was disabled",
      async (s) => {
        await owner("UPDATE reviewers SET disabled_at = now() WHERE id = $1", [
          s.alice,
        ]);
        return s.publish();
      },
      "DECISION_REVOKED",
    ],
    [
      "a decider whose grant was revoked",
      async (s) => {
        await owner("DELETE FROM repository_reviewers WHERE reviewer_id = $1", [
          s.alice,
        ]);
        return s.publish();
      },
      "DECISION_REVOKED",
    ],
    [
      "an echo of another head",
      (s) => s.publish(s.bob, { ...s.echo, headSha: randomSha() }),
      "APPROVAL_MISMATCH",
    ],
    [
      "an echo of another patch",
      (s) => s.publish(s.bob, { ...s.echo, patchSha256: "1".repeat(64) }),
      "APPROVAL_MISMATCH",
    ],
    [
      "extra fields in the body",
      (s) => s.publish(s.bob, { ...s.echo, branch: "main" }),
      "INVALID_INPUT",
    ],
    [
      "a recorded patch hash that doesn't match the patch",
      async (s) => {
        await owner("UPDATE review_decisions SET patch_sha256 = $1", [
          "2".repeat(64),
        ]);
        return s.publish(s.bob, { ...s.echo, patchSha256: "2".repeat(64) });
      },
      "APPROVAL_TAMPERED",
    ],
    [
      "a decision bound to another head than its proposal",
      async (s) => {
        const other = randomSha();
        await owner("UPDATE review_decisions SET head_sha = $1", [other]);
        return s.publish(s.bob, { ...s.echo, headSha: other });
      },
      "APPROVAL_TAMPERED",
    ],
    [
      "a forged stored base document",
      async (s) => {
        await owner("UPDATE patch_proposals SET base_content = $1", ["forged"]);
        return s.publish();
      },
      "PATCH_INVALID",
    ],
    [
      "an approved patch that no longer validates",
      async (s) => {
        const bad = `--- a/${DOC_PATH}\n+++ b/${DOC_PATH}\n@@ -1 +1 @@\n-nope\n+<script>x</script>\n`;
        const hash = createHash("sha256").update(bad).digest("hex");
        await owner("UPDATE patch_proposals SET patch_text = $1", [bad]);
        await owner("UPDATE review_decisions SET patch_sha256 = $1", [hash]);
        return s.publish(s.bob, { ...s.echo, patchSha256: hash });
      },
      "PATCH_INVALID",
    ],
    [
      "an installation that is not allowed",
      (s) =>
        createDocsPr(
          s.deps({ allowedInstallationIds: () => new Set([8]) }),
          s.bob,
          s.proposalId,
          s.echo,
        ),
      "INSTALLATION_NOT_ALLOWED",
    ],
    [
      "an analysis without branch names",
      async (s) => {
        await owner("UPDATE pull_requests SET head_ref = NULL");
        return s.publish();
      },
      "ANALYSIS_TOO_OLD",
    ],
  ];

  it.each(cases)(
    "refuses %s",
    async (_label, run, code, decision = "accepted") => {
      const s = await setup(decision);
      expect(await run(s)).toMatchObject({ ok: false, code });
      expect(s.gh.requests).toEqual([]);
      expect((await owner("SELECT 1 FROM github_outputs")).rows).toEqual([]);
    },
  );

  it("refuses fixture data", async () => {
    const s = await setup();
    const fixture = await seedAnalysis(pool);
    await grantAs(ownerUrl, s.alice, fixture.repositoryId);
    const d = await decide(pool, s.alice, fixture.proposalId, {
      decision: "accepted",
    });
    if (!d.ok) throw new Error(d.code);
    const r = await createDocsPr(s.deps(), s.alice, fixture.proposalId, {
      headSha: d.record.headSha,
      patchSha256: d.record.patchSha256,
    });
    expect(r).toMatchObject({ ok: false, code: "FIXTURE_NOT_WRITABLE" });
    expect(s.gh.requests).toEqual([]);
  });
});

describe("stale or changed GitHub state", () => {
  const cases: [string, (gh: FakeGitHub) => void, string][] = [
    ["a closed PR", (gh) => (gh.sourcePull.state = "closed"), "PR_NOT_OPEN"],
    [
      "a moved head",
      (gh) => (gh.sourcePull.head.sha = randomSha()),
      "STALE_HEAD",
    ],
    [
      "a retargeted base",
      (gh) => (gh.sourcePull.base.ref = "release"),
      "PR_RETARGETED",
    ],
    [
      "a fork",
      (gh) => (gh.sourcePull.head.repo = { id: 99 }),
      "FORK_NOT_SUPPORTED",
    ],
    [
      "a deleted fork",
      (gh) => (gh.sourcePull.head.repo = null),
      "FORK_NOT_SUPPORTED",
    ],
    [
      "another repository",
      (gh) => (gh.sourcePull.base.repo = { id: 43 }),
      "REPOSITORY_MISMATCH",
    ],
    [
      "a changed document blob",
      (gh) =>
        gh.commits
          .get(gh.headSha)!
          .files.set(DOC_PATH, gh.addBlob("changed\n")),
      "STALE_BLOB",
    ],
    [
      "a symlink at the target",
      (gh) => gh.modes.set(DOC_PATH, "120000"),
      "STALE_BLOB",
    ],
    [
      "a target directory that is not a tree",
      (gh) => {
        const files = gh.commits.get(gh.headSha)!.files;
        const blob = files.get(DOC_PATH)!;
        files.clear();
        files.set("docs", blob);
      },
      "STALE_BLOB",
    ],
    ["a truncated tree", (gh) => (gh.truncateTrees = true), "TREE_TRUNCATED"],
    [
      "blob bytes that don't hash to the blob id",
      (gh) => {
        const sha = gh.commits.get(gh.headSha)!.files.get(DOC_PATH)!;
        gh.blobs.set(sha, scenario.docs[DOC_PATH]! + "\nInjected line.\n");
      },
      "APPROVAL_TAMPERED",
    ],
    [
      "blob bytes with a BOM",
      (gh) => {
        const sha = gh.commits.get(gh.headSha)!.files.get(DOC_PATH)!;
        gh.blobs.set(sha, "﻿" + scenario.docs[DOC_PATH]!);
      },
      "APPROVAL_TAMPERED",
    ],
    [
      "a conflicting write (409 on the PUT)",
      (gh) => gh.failNext((m) => m === "PUT", { status: 409 }),
      "STALE_BLOB",
    ],
  ];

  it.each(cases)(
    "stops on %s without writing the document",
    async (_label, change, code) => {
      const s = await setup();
      change(s.gh);
      expect(await s.publish()).toMatchObject({ ok: false, code });
      expect(s.gh.requests.some((r) => r.startsWith("PUT"))).toBe(
        code === "STALE_BLOB" && _label.includes("409"),
      );
      expect(docsPrs(s.gh)).toEqual([]);
      expect(s.gh.revoked).toBe(1);
      // Not retryable: a later request gets the same code without calling GitHub.
      await allowRetry();
      const before = s.gh.requests.length;
      expect(await s.publish()).toMatchObject({ ok: false, code });
      expect(s.gh.requests.length).toBe(before);
    },
  );
});

describe("partial failures resume without duplicates", () => {
  it("resumes after the commit times out before being made", async () => {
    const s = await setup();
    s.gh.failNext((m) => m === "PUT", "timeout");
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "GITHUB_TIMEOUT",
    });
    expect(await outputRow()).toMatchObject({
      step: "branch_created",
      error_code: "GITHUB_TIMEOUT",
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "RETRY_TOO_SOON",
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({ ok: true, created: true });
    // The timed-out PUT made no commit; the retry made exactly one.
    const tip = docsPrs(s.gh)[0]!.head.sha;
    expect(s.gh.commits.get(tip)!.parent).toBe(s.gh.headSha);
    expect(docsPrs(s.gh)).toHaveLength(1);
  });

  it("adopts a commit whose response was lost, after checking it is exactly ours", async () => {
    const s = await setup();
    s.gh.failNext((m) => m === "PUT", "lost");
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "GITHUB_NETWORK_ERROR",
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({ ok: true, created: true });
    expect(s.gh.writes.filter((w) => w.startsWith("PUT"))).toHaveLength(1);
    expect(s.gh.requests.some((r) => r.includes("/compare/"))).toBe(true);
    expect(docsPrs(s.gh)).toHaveLength(1);
  });

  it("opens the PR once after PR creation failed", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      status: 502,
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "GITHUB_UPSTREAM_ERROR",
    });
    expect(await outputRow()).toMatchObject({ step: "committed" });
    await allowRetry();
    expect(await s.publish()).toMatchObject({ ok: true, created: true });
    expect(docsPrs(s.gh)).toHaveLength(1);
    expect(s.gh.writes.filter((w) => w.startsWith("PUT"))).toHaveLength(1);
  });

  it("finds the bot's PR when the create response was lost", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), "lost");
    expect(await s.publish()).toMatchObject({ ok: false });
    await allowRetry();
    // Adopted, not created by this request.
    expect(await s.publish()).toMatchObject({ ok: true, created: false });
    expect(docsPrs(s.gh)).toHaveLength(1);
  });

  it("refuses a docs branch with someone else's extra commit", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      status: 502,
    });
    await s.publish();
    const branch = [...s.gh.branches.keys()].find((b) =>
      b.startsWith("docusync/"),
    )!;
    s.gh.pushCommit(branch, { ".github/workflows/x.yml": "on: push" });
    await allowRetry();
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "BRANCH_CONFLICT",
    });
    expect(docsPrs(s.gh)).toEqual([]);
  });

  it("refuses to adopt a lost commit that changes more than the target", async () => {
    const s = await setup();
    s.gh.failNext((m) => m === "PUT", "timeout");
    await s.publish();
    const branch = [...s.gh.branches.keys()].find((b) =>
      b.startsWith("docusync/"),
    )!;
    s.gh.pushCommit(branch, {
      [DOC_PATH]: expected,
      "src/config.ts": "evil()",
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "BRANCH_CONFLICT",
    });
    expect(docsPrs(s.gh)).toEqual([]);
  });

  it("doesn't adopt a PR on our branch opened by someone else", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      status: 502,
    });
    await s.publish();
    const branch = [...s.gh.branches.keys()].find((b) =>
      b.startsWith("docusync/"),
    )!;
    s.gh.pulls.push({
      number: 200,
      state: "open",
      user: { login: "mallory" },
      head: { sha: s.gh.branches.get(branch)!, ref: branch, repo: { id: 42 } },
      base: { ref: "feature/rename", repo: { id: 42 } },
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "BRANCH_CONFLICT",
    });
  });

  it("stops when its lease was lost, before writing the document", async () => {
    const s = await setup();
    const r = await createDocsPr(
      s.deps({
        openWriter: async (binding, signal) => {
          await owner(
            "UPDATE github_outputs SET lease_until = now() - interval '1 second'",
          );
          return openGitHubWriter({
            appId: "1",
            privateKey,
            binding,
            signal,
            fetch: s.gh.fetch,
            env: ON,
          });
        },
      }),
      s.bob,
      s.proposalId,
      s.echo,
    );
    expect(r).toMatchObject({ ok: false, code: "LEASE_LOST" });
    expect(s.gh.requests.some((x) => x.startsWith("PUT"))).toBe(false);
  });

  it("refuses while another attempt holds the lease, even when a retry is otherwise due", async () => {
    const s = await setup();
    s.gh.failNext((m) => m === "GET", { status: 503 });
    await s.publish();
    // Another process holds a live lease; the retry interval alone would allow this attempt.
    await owner(
      `UPDATE github_outputs SET lease_token = gen_random_uuid(),
         lease_until = now() + interval '60 seconds', updated_at = now() - interval '1 minute'`,
    );
    const before = s.gh.requests.length;
    expect(await s.publish()).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect(s.gh.requests.length).toBe(before);
  });

  it("gives up after the attempt limit", async () => {
    const s = await setup();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      s.gh.failNext((m) => m === "GET", { status: 503 });
      expect(await s.publish()).toMatchObject({
        ok: false,
        code: "GITHUB_UPSTREAM_ERROR",
      });
      await allowRetry();
    }
    const before = s.gh.requests.length;
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "ATTEMPT_LIMIT",
    });
    expect(s.gh.requests.length).toBe(before);
  });
});

describe("migration 0005 grants", () => {
  it("keep repository identity and output bindings fixed for the app role", async () => {
    const s = await setup();
    await s.publish();
    const denied = async (sql: string) =>
      expect(pool.query(sql)).rejects.toMatchObject({ code: "42501" });
    await denied("UPDATE repositories SET github_repo_id = 43");
    await denied("UPDATE repositories SET source = 'fixture'");
    await denied(
      "UPDATE github_outputs SET branch = 'docusync/pr-1-000000000000'",
    );
    await denied("UPDATE github_outputs SET head_sha = repeat('a', 40)");
    await denied("DELETE FROM github_outputs");
    await denied("UPDATE github_output_attempts SET reviewer_id = reviewer_id");
    await denied("DELETE FROM github_output_attempts");
    // What the webhook upsert needs still works.
    await pool.query(
      "UPDATE repositories SET owner = 'acme', name = 'widgets', installation_id = 7, updated_at = now()",
    );
  });

  it("let a live run fill branch names on a PR row the webhook created first", async () => {
    const gh = new FakeGitHub({
      owner: "acme",
      repo: "widgets",
      repoId: 42,
      installationId: 7,
      files: scenario.docs,
      pullNumber: 5,
      headRef: "feature/rename",
      baseRef: "main",
      appSlug: SLUG,
    });
    await enqueueAnalysis(
      pool,
      {
        githubRepoId: 42,
        owner: "acme",
        repo: "widgets",
        installationId: 7,
        prNumber: 5,
        headSha: gh.headSha,
        baseSha: randomSha(),
      },
      `k-${gh.headSha}`,
      "00000000-0000-4000-8000-0000000000aa",
    );
    const snapshot = {
      ...snapshotFor(scenario),
      ref: { owner: "acme", repo: "widgets", number: 5 },
      headSha: gh.headSha,
    };
    await saveAnalysis(
      pool,
      {
        kind: "github",
        githubRepoId: 42,
        installationId: 7,
        headRef: "feature/rename",
        baseRef: "main",
        notes: ["note"],
      },
      snapshot,
      docs,
      await assistImpact(snapshot, docs, undefined),
    );
    const { rows } = await pool.query(
      "SELECT head_ref, base_ref FROM pull_requests",
    );
    expect(rows).toEqual([{ head_ref: "feature/rename", base_ref: "main" }]);
  });
});

describe("review fixes", () => {
  it("publishes after a retargeted PR is analysed again at the same head (M2)", async () => {
    const s = await setup();
    s.gh.sourcePull.base.ref = "release";
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "PR_RETARGETED",
    });

    // A new live analysis of the same commit records the new base and yields a
    // new proposal, decided again.
    const snapshot = {
      ...snapshotFor(scenario),
      ref: { owner: "acme", repo: "widgets", number: 5 },
      headSha: s.gh.headSha,
    };
    const analysisId = await saveAnalysis(
      pool,
      {
        kind: "github",
        githubRepoId: 42,
        installationId: 7,
        headRef: "feature/rename",
        baseRef: "release",
        notes: [],
      },
      snapshot,
      docs,
      await assistImpact(snapshot, docs, scripted()),
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT pp.id FROM patch_proposals pp JOIN impact_candidates c ON c.id = pp.candidate_id
        WHERE c.analysis_id = $1`,
      [analysisId],
    );
    const d = await decide(pool, s.alice, rows[0]!.id, {
      decision: "accepted",
    });
    if (!d.ok) throw new Error(d.code);
    const refs = await pool.query(
      "SELECT head_ref, base_ref FROM pull_requests",
    );
    expect(refs.rows).toEqual([
      { head_ref: "feature/rename", base_ref: "release" },
    ]);
    expect(
      await createDocsPr(s.deps(), s.bob, rows[0]!.id, {
        headSha: d.record.headSha,
        patchSha256: d.record.patchSha256,
      }),
    ).toMatchObject({ ok: true, created: true });
    // The first decision's output keeps its terminal code.
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "PR_RETARGETED",
    });
  });

  it("retries a commit whose response was unusable and adopts it after the compare check (M3)", async () => {
    const s = await setup();
    s.gh.failNext((m) => m === "PUT", {
      respond: {
        content: { sha: "0".repeat(40) },
        commit: { sha: "1".repeat(40) },
      },
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "GITHUB_AMBIGUOUS",
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({ ok: true, created: true });
    expect(s.gh.writes.filter((w) => w.startsWith("PUT"))).toHaveLength(1);
    expect(docsPrs(s.gh)).toHaveLength(1);
  });

  it("retries after an unusable PR response and adopts the bot's PR (M3)", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      respond: { nope: true },
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "GITHUB_AMBIGUOUS",
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({ ok: true, created: false });
    expect(docsPrs(s.gh)).toHaveLength(1);
  });

  it("names a refused PR creation and doesn't retry it (M3)", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      status: 422,
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "PR_CREATE_REFUSED",
    });
    await allowRetry();
    const before = s.gh.requests.length;
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "PR_CREATE_REFUSED",
    });
    expect(s.gh.requests.length).toBe(before);
  });

  it("lets a refused token request be retried once the App is fixed (M3)", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/access_tokens"), {
      status: 422,
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "GITHUB_TOKEN_REFUSED",
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({ ok: true, created: true });
  });

  it("doesn't record a branch that was never created (L2)", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/git/refs"), {
      status: 422,
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "BRANCH_CONFLICT",
    });
    expect(await outputRow()).toMatchObject({ step: "pending" });
  });

  it("returns an opened PR even after the approving reviewer was disabled (L4)", async () => {
    const s = await setup();
    const first = await s.publish();
    await owner("UPDATE reviewers SET disabled_at = now() WHERE id = $1", [
      s.alice,
    ]);
    const again = await s.publish();
    expect(again).toMatchObject({
      ok: true,
      created: false,
      prUrl: first.ok ? first.prUrl : "",
    });
  });

  it("fails on missing configuration before claiming an attempt or minting a token (L5)", async () => {
    const s = await setup();
    const r = createDocsPr(
      s.deps({
        appSlug: () => {
          throw new Error("Invalid server environment: GITHUB_APP_SLUG");
        },
      }),
      s.bob,
      s.proposalId,
      s.echo,
    );
    await expect(r).rejects.toThrow("GITHUB_APP_SLUG");
    expect((await owner("SELECT 1 FROM github_outputs")).rows).toEqual([]);
    expect(s.gh.requests).toEqual([]);
  });

  it("releases the lease and records a retryable code on an unexpected error (L1)", async () => {
    const s = await setup();
    await expect(
      createDocsPr(
        s.deps({
          openWriter: async () => {
            throw new Error("boom");
          },
        }),
        s.bob,
        s.proposalId,
        s.echo,
      ),
    ).rejects.toThrow("boom");
    const row = (
      await owner<{
        error_code: string;
        lease_token: string | null;
        attempts: number;
      }>("SELECT error_code, lease_token, attempts FROM github_outputs")
    ).rows[0];
    expect(row).toEqual({
      error_code: "INTERNAL_ERROR",
      lease_token: null,
      attempts: 1,
    });
    await allowRetry();
    expect(await s.publish()).toMatchObject({ ok: true });
  });

  it("reports a terminal code ahead of the attempt limit (L10)", async () => {
    const s = await setup();
    s.gh.sourcePull.state = "closed";
    expect(await s.publish()).toMatchObject({ ok: false, code: "PR_NOT_OPEN" });
    await owner(
      "UPDATE github_outputs SET attempts = 5, updated_at = now() - interval '1 minute'",
    );
    expect(await s.publish()).toMatchObject({ ok: false, code: "PR_NOT_OPEN" });
  });

  it("refuses to resume a commit whose branch was deleted (L10)", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      status: 502,
    });
    await s.publish();
    expect(await outputRow()).toMatchObject({ step: "committed" });
    const branch = [...s.gh.branches.keys()].find((b) =>
      b.startsWith("docusync/"),
    )!;
    s.gh.branches.delete(branch);
    await allowRetry();
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "BRANCH_CONFLICT",
    });
    expect(docsPrs(s.gh)).toEqual([]);
  });
});

describe("security-check M-1: the PR carries only DocuSync's commit", () => {
  const docsBranch = (gh: FakeGitHub) =>
    [...gh.branches.keys()].find((b) => b.startsWith("docusync/"))!;

  it("refuses its own commit when someone pushed to the branch just before it", async () => {
    const s = await setup();
    s.gh.failNext((m) => m === "PUT", {
      before: () =>
        s.gh.pushCommit(docsBranch(s.gh), { "src/config.ts": "evil()" }),
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "BRANCH_CONFLICT",
    });
    expect(docsPrs(s.gh)).toEqual([]);
    expect(await outputRow()).toMatchObject({
      step: "branch_created",
      commit_sha: null,
    });
  });

  it("doesn't record a PR whose branch moved between the last check and its creation", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      before: () =>
        s.gh.pushCommit(docsBranch(s.gh), { "src/config.ts": "evil()" }),
    });
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "PR_HEAD_MISMATCH",
    });
    expect(await outputRow()).toMatchObject({
      step: "committed",
      error_code: "PR_HEAD_MISMATCH",
    });
    // Terminal: an operator closes that PR by hand (docs/13 incident response).
    await allowRetry();
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "PR_HEAD_MISMATCH",
    });
  });

  it("checks a recorded commit with compare before opening the PR", async () => {
    const s = await setup();
    s.gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      status: 502,
    });
    await s.publish();
    const evil = s.gh.pushCommit(docsBranch(s.gh), {
      "src/config.ts": "evil()",
    });
    // A recorded commit that is not exactly ours (only the app role could write this).
    await owner("UPDATE github_outputs SET commit_sha = $1", [evil]);
    await allowRetry();
    expect(await s.publish()).toMatchObject({
      ok: false,
      code: "BRANCH_CONFLICT",
    });
    expect(docsPrs(s.gh)).toEqual([]);
  });

  it("names its one commit in the PR body", async () => {
    const s = await setup();
    await s.publish();
    const [pr] = docsPrs(s.gh) as (FakeGitHub["pulls"][number] & {
      body: string;
    })[];
    expect(pr!.body).toContain(
      "`" +
        pr!.head.sha +
        "`. This pull request should contain exactly this one commit",
    );
  });
});
