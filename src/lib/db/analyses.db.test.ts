import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PullRequestWork } from "@/lib/analysis-work";
import { idempotencyKey } from "@/lib/github/webhook";
import { appPool, requireTestDbUrls, withOwner } from "@/test/db";
import { enqueueAnalysis } from "./analyses";
import { migrate } from "./migrate";

const { appUrl, ownerUrl } = requireTestDbUrls();
let pool: Pool;

const work: PullRequestWork = {
  githubRepoId: 123456789,
  owner: "example-org",
  repo: "example-repo",
  installationId: 987654,
  prNumber: 42,
  headSha: "1".repeat(40),
  baseSha: "2".repeat(40),
};

beforeAll(async () => {
  await withOwner(ownerUrl, (c) =>
    migrate(c, path.join(process.cwd(), "migrations")),
  );
  pool = appPool(appUrl);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await withOwner(ownerUrl, (c) => c.query("TRUNCATE repositories CASCADE"));
});

const count = async (table: string) =>
  Number(
    (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))
      .rows[0]!.n,
  );

describe("enqueueAnalysis", () => {
  it("creates one queued analysis with its repository and PR", async () => {
    const deliveryId = randomUUID();
    const r = await enqueueAnalysis(
      pool,
      work,
      idempotencyKey(work),
      deliveryId,
    );
    expect(r.created).toBe(true);
    const { rows } = await pool.query(
      `SELECT a.status, a.delivery_id, a.started_at, p.head_sha, p.github_pr_number, r.owner, r.installation_id
         FROM analyses a JOIN pull_requests p ON p.id = a.pull_request_id
         JOIN repositories r ON r.id = p.repository_id WHERE a.id = $1`,
      [r.analysisId],
    );
    expect(rows[0]).toMatchObject({
      status: "queued",
      delivery_id: deliveryId,
      started_at: null,
      head_sha: work.headSha,
      github_pr_number: 42,
      owner: "example-org",
      installation_id: "987654",
    });
  });

  it("returns the existing analysis for a redelivery or another delivery of the same head", async () => {
    const key = idempotencyKey(work);
    const first = await enqueueAnalysis(pool, work, key, randomUUID());
    const again = await enqueueAnalysis(pool, work, key, randomUUID());
    expect(again).toEqual({ analysisId: first.analysisId, created: false });
    expect(await count("analyses")).toBe(1);
    expect(await count("pull_requests")).toBe(1);
    expect(await count("repositories")).toBe(1);
  });

  it("creates exactly one analysis under concurrent duplicate deliveries", async () => {
    const key = idempotencyKey(work);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueueAnalysis(pool, work, key, randomUUID()),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.analysisId)).size).toBe(1);
    expect(await count("analyses")).toBe(1);
  });

  it("creates a new analysis for a new head commit on the same PR", async () => {
    const next = { ...work, headSha: "3".repeat(40) };
    const a = await enqueueAnalysis(
      pool,
      work,
      idempotencyKey(work),
      randomUUID(),
    );
    const b = await enqueueAnalysis(
      pool,
      next,
      idempotencyKey(next),
      randomUUID(),
    );
    expect(b.created).toBe(true);
    expect(b.analysisId).not.toBe(a.analysisId);
    expect(await count("pull_requests")).toBe(2);
    expect(await count("repositories")).toBe(1);
  });

  it("does not rewrite repository or PR rows when a delivery is replayed", async () => {
    // xmin changes whenever Postgres writes a new row version.
    const versions = async () =>
      (
        await pool.query<{ r: string; p: string }>(
          `SELECT r.xmin::text AS r, p.xmin::text AS p
             FROM repositories r JOIN pull_requests p ON p.repository_id = r.id`,
        )
      ).rows;
    const key = idempotencyKey(work);
    await enqueueAnalysis(pool, work, key, randomUUID());
    const before = await versions();
    for (let i = 0; i < 3; i++) {
      await expect(
        enqueueAnalysis(pool, work, key, randomUUID()),
      ).resolves.toMatchObject({
        created: false,
      });
    }
    expect(await versions()).toEqual(before);
  });

  it("updates repository identity on rename and leaves nothing behind on failure", async () => {
    await enqueueAnalysis(pool, work, idempotencyKey(work), randomUUID());
    const renamed = { ...work, owner: "new-org", headSha: "4".repeat(40) };
    await enqueueAnalysis(pool, renamed, idempotencyKey(renamed), randomUUID());
    const { rows } = await pool.query("SELECT owner FROM repositories");
    expect(rows).toEqual([{ owner: "new-org" }]);

    // An invalid sha violates a CHECK constraint after the repo upsert; the transaction must roll back.
    const bad = { ...work, githubRepoId: 555, headSha: "not-a-sha" };
    await expect(
      enqueueAnalysis(pool, bad, "github:pr:555:42:bad", randomUUID()),
    ).rejects.toMatchObject({
      code: "23514",
    });
    expect(await count("repositories")).toBe(1);
  });
});

describe("analyses constraints", () => {
  it.each([
    ["running without started_at", "status = 'running'"],
    ["failed without error_code", "status = 'failed', completed_at = now()"],
    [
      "completed without completed_at",
      "status = 'completed', started_at = now()",
    ],
    ["queued with started_at", "started_at = now()"],
    [
      "completed before started",
      "status = 'completed', started_at = now(), completed_at = now() - interval '1 hour'",
    ],
    [
      "raw error text as error_code",
      "status = 'failed', completed_at = now(), error_code = 'connect ECONNREFUSED'",
    ],
    ["unknown status", "status = 'paused'"],
  ])("rejects %s", async (_label, set) => {
    const r = await enqueueAnalysis(
      pool,
      work,
      idempotencyKey(work),
      randomUUID(),
    );
    await expect(
      pool.query(`UPDATE analyses SET ${set} WHERE id = $1`, [r.analysisId]),
    ).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("accepts a valid queued → running → completed sequence", async () => {
    const r = await enqueueAnalysis(
      pool,
      work,
      idempotencyKey(work),
      randomUUID(),
    );
    await pool.query(
      "UPDATE analyses SET status = 'running', started_at = now() WHERE id = $1",
      [r.analysisId],
    );
    await pool.query(
      "UPDATE analyses SET status = 'completed', completed_at = now() WHERE id = $1",
      [r.analysisId],
    );
    const { rows } = await pool.query(
      "SELECT status FROM analyses WHERE id = $1",
      [r.analysisId],
    );
    expect(rows).toEqual([{ status: "completed" }]);
  });
});
