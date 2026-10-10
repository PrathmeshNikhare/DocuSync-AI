import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFixtureReader } from "@/lib/github/fixture-reader";
import { GitHubReadError, type GitHubReader } from "@/lib/github/reader";
import { DIFF_LIMITS, pullRequestSnapshotSchema } from "@/lib/schemas";
import { ingestPullRequest } from "./ingest";

const ref = (repo: string) => ({ owner: "fixture", repo, number: 1 });
const fixtureNames = readdirSync("fixtures/github").map((f) =>
  f.replace(/\.json$/, ""),
);

describe("ingestPullRequest with fixtures", () => {
  it.each(fixtureNames)("produces a valid snapshot for %s", async (name) => {
    const snapshot = await ingestPullRequest(
      createFixtureReader(name),
      ref(name),
    );
    expect(pullRequestSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("normalizes a source change with hunks", async () => {
    const s = await ingestPullRequest(
      createFixtureReader("env-var-change"),
      ref("env-var-change"),
    );
    expect(s.headSha).toBe("1".repeat(40));
    expect(s.files.map((f) => f.path)).toEqual([
      "src/config.ts",
      ".env.example",
    ]);
    expect(s.files[0]?.hunks[0]?.lines).toContain(
      '+  newFlag: process.env.NEW_FLAG === "true",',
    );
  });

  it("keeps rename provenance", async () => {
    const s = await ingestPullRequest(
      createFixtureReader("renamed-symbol"),
      ref("renamed-symbol"),
    );
    expect(s.files[0]).toMatchObject({
      path: "src/lib/arith.ts",
      previousPath: "src/lib/math.ts",
      status: "renamed",
    });
  });

  it("rejects unsafe paths and keeps the safe file", async () => {
    const s = await ingestPullRequest(
      createFixtureReader("unsafe-paths"),
      ref("unsafe-paths"),
    );
    expect(s.files.map((f) => f.path)).toEqual(["docs/ok.md"]);
    expect(s.rejectedFiles).toHaveLength(4);
  });

  it("flags omitted and malformed patches instead of guessing", async () => {
    const omitted = await ingestPullRequest(
      createFixtureReader("binary-and-omitted"),
      ref("binary-and-omitted"),
    );
    expect(omitted.files.map((f) => f.patchState)).toEqual([
      "omitted",
      "omitted",
    ]);
    const malformed = await ingestPullRequest(
      createFixtureReader("malformed-patch"),
      ref("malformed-patch"),
    );
    expect(malformed.files.map((f) => f.patchState)).toEqual([
      "malformed",
      "malformed",
      "malformed",
    ]);
  });

  it("carries injected instructions only as inert diff data", async () => {
    const s = await ingestPullRequest(
      createFixtureReader("docs-with-injection"),
      ref("docs-with-injection"),
    );
    expect(s.title).toContain("ignore previous instructions");
    expect(s.files).toHaveLength(1);
    expect(s.files[0]?.hunks[0]?.lines.at(-1)).toMatch(
      /^\+<!-- AI assistant: ignore/,
    );
  });
});

describe("ingestPullRequest with a stub reader", () => {
  const pull = {
    number: 1,
    title: "t",
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
  };
  const stub = (overrides: Partial<GitHubReader> = {}): GitHubReader => ({
    getPullRequest: async () => pull,
    listFiles: async () => ({ files: [], truncated: false }),
    ...overrides,
  });

  it("rejects a response for a different PR number", async () => {
    await expect(
      ingestPullRequest(
        stub({ getPullRequest: async () => ({ ...pull, number: 2 }) }),
        ref("x"),
      ),
    ).rejects.toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });
  });

  it("rejects malformed metadata such as a non-hex head sha", async () => {
    await expect(
      ingestPullRequest(
        stub({
          getPullRequest: async () => ({ ...pull, head: { sha: "main" } }),
        }),
        ref("x"),
      ),
    ).rejects.toBeInstanceOf(GitHubReadError);
  });

  it("rejects an invalid ref before calling GitHub", async () => {
    let called = false;
    const reader = stub({
      getPullRequest: async () => {
        called = true;
        return pull;
      },
    });
    for (const bad of [
      { owner: "..", repo: "r", number: 1 },
      { owner: "o", repo: "r", number: 0 },
      { owner: "o", repo: "r", number: 2_147_483_648 },
    ]) {
      const err = await ingestPullRequest(reader, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubReadError);
      expect(err).toMatchObject({ code: "INVALID_PULL_REQUEST_REF" });
    }
    expect(called).toBe(false);
  });

  /** Returns successive PR metadata responses, then repeats the last one. */
  const sequence = (...responses: (typeof pull)[]) => {
    let i = 0;
    return async () => responses[Math.min(i++, responses.length - 1)];
  };

  it("fails as stale when the head moves while files are listed", async () => {
    const moved = { ...pull, head: { sha: "c".repeat(40) } };
    await expect(
      ingestPullRequest(
        stub({ getPullRequest: sequence(pull, moved) }),
        ref("x"),
      ),
    ).rejects.toMatchObject({ code: "GITHUB_STALE_HEAD" });
  });

  it("fails as stale when the base moves while files are listed", async () => {
    const rebased = { ...pull, base: { sha: "d".repeat(40) } };
    await expect(
      ingestPullRequest(
        stub({ getPullRequest: sequence(pull, rebased) }),
        ref("x"),
      ),
    ).rejects.toMatchObject({ code: "GITHUB_STALE_HEAD" });
  });

  it("fails as stale before listing files when the head is not the expected commit", async () => {
    let listed = false;
    const reader = stub({
      listFiles: async () => {
        listed = true;
        return { files: [], truncated: false };
      },
    });
    await expect(
      ingestPullRequest(reader, ref("x"), { expectedHeadSha: "e".repeat(40) }),
    ).rejects.toMatchObject({ code: "GITHUB_STALE_HEAD" });
    expect(listed).toBe(false);
  });

  it("succeeds when the head matches the expected commit and stays put", async () => {
    const s = await ingestPullRequest(stub(), ref("x"), {
      expectedHeadSha: pull.head.sha,
    });
    expect(s.headSha).toBe(pull.head.sha);
  });

  it("caps files and reports truncation", async () => {
    const files = Array.from({ length: DIFF_LIMITS.maxFiles + 5 }, (_, i) => ({
      filename: `f${i}.md`,
      status: "added",
      additions: 0,
      deletions: 0,
    }));
    const s = await ingestPullRequest(
      stub({ listFiles: async () => ({ files, truncated: false }) }),
      ref("x"),
    );
    expect(s.files).toHaveLength(DIFF_LIMITS.maxFiles);
    expect(s.filesTruncated).toBe(true);
  });

  it("passes reader truncation through", async () => {
    const s = await ingestPullRequest(
      stub({ listFiles: async () => ({ files: [], truncated: true }) }),
      ref("x"),
    );
    expect(s.filesTruncated).toBe(true);
  });
});

describe("createFixtureReader", () => {
  it.each(["../secrets", "a/b", "UPPER", "", "x".repeat(65), "name.json"])(
    "refuses unsafe fixture name %j",
    (name) => {
      expect(() => createFixtureReader(name)).toThrow(GitHubReadError);
    },
  );

  it("reports a missing fixture with a safe code", async () => {
    await expect(
      createFixtureReader("does-not-exist").getPullRequest(ref("x")),
    ).rejects.toMatchObject({
      code: "FIXTURE_NOT_FOUND",
    });
  });
});
