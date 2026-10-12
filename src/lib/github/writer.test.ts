import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FakeGitHub, randomSha } from "@/test/fake-github";
import {
  fetchAllowed,
  guardedRepoClient,
  guardedTokenClient,
  hookAllows,
  openGitHubWriter,
  type WriteBinding,
  type WriterOptions,
} from "./writer";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const ON = { GITHUB_WRITES_ENABLED: "true" };
const DOC = "docs/configuration.md";

function setup() {
  const gh = new FakeGitHub({
    owner: "acme",
    repo: "widgets",
    repoId: 42,
    installationId: 7,
    files: { [DOC]: "# Config\n\nSet `API_TOKEN`.\n", "src/a.ts": "x" },
    pullNumber: 5,
    headRef: "feature/rename",
    baseRef: "main",
    appSlug: "docusync-test",
  });
  const binding: WriteBinding = {
    installationId: 7,
    githubRepoId: 42,
    owner: "acme",
    repo: "widgets",
    pullNumber: 5,
    headSha: gh.headSha,
    baseBlobSha: gh.commits.get(gh.headSha)!.files.get(DOC)!,
    targetPath: DOC,
    branch: "docusync/pr-5-0123456789ab",
    docsPrBaseRef: "feature/rename",
  };
  const opts = (over: Partial<WriterOptions> = {}): WriterOptions => ({
    appId: "1",
    privateKey,
    binding,
    signal: AbortSignal.timeout(30_000),
    fetch: gh.fetch,
    env: ON,
    ...over,
  });
  return { gh, binding, opts };
}

describe("openGitHubWriter", () => {
  it("refuses to mint a token or call GitHub while writes are disabled", async () => {
    const { gh, opts } = setup();
    for (const env of [
      {},
      { GITHUB_WRITES_ENABLED: "1" },
      { GITHUB_WRITES_ENABLED: "TRUE" },
    ]) {
      await expect(openGitHubWriter(opts({ env }))).rejects.toMatchObject({
        code: "WRITES_DISABLED",
      });
    }
    expect(gh.requests).toEqual([]);
  });

  it("mints a fresh token per operation, scoped to one repository, and revokes it", async () => {
    const { gh, opts } = setup();
    const tokenCalls = () =>
      gh.requests.filter((r) => r.includes("access_tokens"));
    const w1 = await openGitHubWriter(opts());
    await w1.close();
    const w2 = await openGitHubWriter(opts());
    await w2.close();
    expect(tokenCalls()).toEqual([
      "POST /app/installations/7/access_tokens",
      "POST /app/installations/7/access_tokens",
    ]);
    expect(gh.revoked).toBe(2);
  });

  it.each([
    ["an extra repository", { repositories: [{ id: 42 }, { id: 43 }] }],
    [
      "the whole installation",
      { repositories: undefined, repository_selection: "all" },
    ],
    [
      "an extra permission",
      {
        permissions: {
          contents: "write",
          pull_requests: "write",
          administration: "write",
        },
      },
    ],
    ["a missing permission", { permissions: { contents: "write" } }],
  ])("refuses a token with %s, and revokes it", async (_label, over) => {
    const { gh, opts } = setup();
    gh.tokenResponse = {
      token: "ghs_x",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: "write", pull_requests: "write" },
      repository_selection: "selected",
      repositories: [{ id: 42 }],
      ...over,
    };
    await expect(openGitHubWriter(opts())).rejects.toMatchObject({
      code: "GITHUB_TOKEN_SCOPE",
    });
    expect(gh.revoked).toBe(1);
  });

  it("maps a 422 on createBranch and createPull to 'exists', and a 409 on the PUT to a conflict", async () => {
    const { gh, binding, opts } = setup();
    const w = await openGitHubWriter(opts());
    expect(await w.createBranch()).toBe(true);
    expect(await w.createBranch()).toBe(false);
    gh.pushCommit(binding.branch, { [DOC]: "changed by someone" });
    await expect(w.putTarget("new", "msg")).rejects.toMatchObject({
      code: "GITHUB_CONFLICT",
    });
    gh.failNext((m, p) => m === "POST" && p.endsWith("/pulls"), {
      status: 422,
    });
    expect(await w.createPull("t", "b")).toBeUndefined();
  });

  it("walks the tree one directory at a time and reports truncation", async () => {
    const { gh, opts } = setup();
    const w = await openGitHubWriter(opts());
    expect(await w.findTarget()).toMatchObject({
      type: "blob",
      mode: "100644",
    });
    gh.truncateTrees = true;
    expect(await w.findTarget()).toBe("truncated");
    expect(gh.requests.some((r) => r.includes("recursive"))).toBe(false);
  });

  it("refuses a mutating call if writes are turned off after the token was minted", async () => {
    const { gh, opts } = setup();
    const env: Record<string, string> = { ...ON };
    const w = await openGitHubWriter(opts({ env }));
    env.GITHUB_WRITES_ENABLED = "false";
    await expect(w.createBranch()).rejects.toMatchObject({
      code: "WRITES_DISABLED",
    });
    expect(gh.writes).toEqual(["POST /app/installations/7/access_tokens"]);
  });

  it("treats a redirect as a failure and never follows it", async () => {
    const { gh, opts } = setup();
    const w = await openGitHubWriter(opts());
    gh.failNext((m) => m === "GET", { redirect: "https://evil.example/x" });
    await expect(w.getPull()).rejects.toMatchObject({
      code: "GITHUB_REDIRECT",
    });
    expect(gh.requests.some((r) => r.includes("evil"))).toBe(false);
  });
});

describe("request guard (hook layer)", () => {
  const blockedCases: [
    string,
    (
      o: ReturnType<typeof guardedRepoClient>,
      b: WriteBinding,
    ) => Promise<unknown>,
  ][] = [
    [
      "a merge",
      (o, b) =>
        o.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
          owner: b.owner,
          repo: b.repo,
          pull_number: 5,
        }),
    ],
    [
      "a ref delete",
      (o, b) =>
        o.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
          owner: b.owner,
          repo: b.repo,
          ref: `heads/${b.branch}`,
        }),
    ],
    [
      "GraphQL",
      (o) => o.request("POST /graphql", { query: "{ viewer { login } }" }),
    ],
    [
      "a literal URL",
      (o, b) => o.request(`GET /repos/${b.owner}/${b.repo}/pulls/5`),
    ],
    [
      "another repository",
      (o) =>
        o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: "acme",
          repo: "other",
          pull_number: 5,
        }),
    ],
    [
      "another pull request",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: b.owner,
          repo: b.repo,
          pull_number: 6,
        }),
    ],
    [
      "a PUT without branch",
      (o, b) =>
        o.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: b.owner,
          repo: b.repo,
          path: b.targetPath,
          message: "m",
          content: "eA==",
          sha: b.baseBlobSha,
        }),
    ],
    [
      "a PUT to another path",
      (o, b) =>
        o.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: b.owner,
          repo: b.repo,
          path: "src/a.ts",
          message: "m",
          content: "eA==",
          sha: b.baseBlobSha,
          branch: b.branch,
        }),
    ],
    [
      "a PUT to a near-miss branch",
      (o, b) =>
        o.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: b.owner,
          repo: b.repo,
          path: b.targetPath,
          message: "m",
          content: "eA==",
          sha: b.baseBlobSha,
          branch: `${b.branch}x`,
        }),
    ],
    [
      "a PUT with a committer",
      (o, b) =>
        o.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: b.owner,
          repo: b.repo,
          path: b.targetPath,
          message: "m",
          content: "eA==",
          sha: b.baseBlobSha,
          branch: b.branch,
          committer: { name: "x", email: "x@example.com" },
        }),
    ],
    [
      "a branch at another commit",
      (o, b) =>
        o.request("POST /repos/{owner}/{repo}/git/refs", {
          owner: b.owner,
          repo: b.repo,
          ref: `refs/heads/${b.branch}`,
          sha: randomSha(),
        }),
    ],
    [
      "a branch outside docusync/",
      (o, b) =>
        o.request("POST /repos/{owner}/{repo}/git/refs", {
          owner: b.owner,
          repo: b.repo,
          ref: "refs/heads/main",
          sha: b.headSha,
        }),
    ],
    [
      "a PR that converts an issue",
      (o, b) =>
        o.request("POST /repos/{owner}/{repo}/pulls", {
          owner: b.owner,
          repo: b.repo,
          head: b.branch,
          base: b.docsPrBaseRef,
          issue: 1,
          maintainer_can_modify: false,
        }),
    ],
    [
      "a PR into another base",
      (o, b) =>
        o.request("POST /repos/{owner}/{repo}/pulls", {
          owner: b.owner,
          repo: b.repo,
          title: "t",
          body: "b",
          head: b.branch,
          base: "main",
          maintainer_can_modify: false,
        }),
    ],
    [
      "a PR maintainers can modify",
      (o, b) =>
        o.request("POST /repos/{owner}/{repo}/pulls", {
          owner: b.owner,
          repo: b.repo,
          title: "t",
          body: "b",
          head: b.branch,
          base: b.docsPrBaseRef,
          maintainer_can_modify: true,
        }),
    ],
    [
      "a PR list without the head filter",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/pulls", {
          owner: b.owner,
          repo: b.repo,
          state: "all",
        }),
    ],
    [
      "a tree that was not reached by walking",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
          owner: b.owner,
          repo: b.repo,
          tree_sha: randomSha(),
        }),
    ],
    [
      "another blob",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner: b.owner,
          repo: b.repo,
          file_sha: randomSha(),
        }),
    ],
    [
      "a compare from another base",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner: b.owner,
          repo: b.repo,
          basehead: `${randomSha()}...${randomSha()}`,
        }),
    ],
    [
      "a baseUrl override",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: b.owner,
          repo: b.repo,
          pull_number: 5,
          baseUrl: "https://evil.example",
        }),
    ],
    [
      "a header override",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: b.owner,
          repo: b.repo,
          pull_number: 5,
          headers: {
            "x-github-api-version": "1",
            authorization: "token other",
          },
        }),
    ],
    [
      "a fetch override",
      (o, b) =>
        o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: b.owner,
          repo: b.repo,
          pull_number: 5,
          request: { fetch: globalThis.fetch },
        }),
    ],
  ];

  it.each(blockedCases)(
    "refuses %s before anything is sent",
    async (_label, run) => {
      const { gh, binding, opts } = setup();
      const octokit = guardedRepoClient(
        opts(),
        "ghs_test",
        new Set([binding.headSha]),
      );
      await expect(run(octokit, binding)).rejects.toMatchObject({
        code: "GITHUB_WRITE_BLOCKED",
      });
      expect(gh.requests).toEqual([]);
    },
  );

  it("lets the exact allowed calls through", async () => {
    const { gh, binding, opts } = setup();
    const octokit = guardedRepoClient(
      opts(),
      "ghs_test",
      new Set([binding.headSha]),
    );
    await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: binding.owner,
      repo: binding.repo,
      pull_number: 5,
    });
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: binding.owner,
      repo: binding.repo,
      ref: `refs/heads/${binding.branch}`,
      sha: binding.headSha,
    });
    expect(gh.requests).toEqual([
      "GET /repos/acme/widgets/pulls/5",
      "POST /repos/acme/widgets/git/refs",
    ]);
  });
});

describe("request guard (fetch layer)", () => {
  const { binding } = setup();
  const trees = new Set([binding.headSha]);
  const r = "https://api.github.com/repos/acme/widgets";
  const allowed = (method: string, url: string, body?: unknown) =>
    fetchAllowed(binding, trees, method, new URL(url), body);

  it("checks host, method, decoded path, query and body on the real request", () => {
    expect(allowed("GET", `${r}/pulls/5`)).toBe(true);
    expect(
      allowed("GET", `${r}/git/ref/heads%2Fdocusync%2Fpr-5-0123456789ab`),
    ).toBe(true);
    expect(
      allowed(
        "PUT",
        `${r}/contents/docs%2Fconfiguration.md`,
        JSON.stringify({
          message: "m",
          content: "eA==",
          sha: binding.baseBlobSha,
          branch: binding.branch,
        }),
      ),
    ).toBe(true);

    expect(
      allowed("GET", "https://evil.example/repos/acme/widgets/pulls/5"),
    ).toBe(false);
    expect(
      allowed("GET", "http://api.github.com/repos/acme/widgets/pulls/5"),
    ).toBe(false);
    expect(allowed("GET", `${r}/pulls/5?per_page=100`)).toBe(false);
    expect(allowed("DELETE", `${r}/git/refs/heads%2Fmain`)).toBe(false);
    expect(allowed("PUT", `${r}/pulls/5/merge`, "{}")).toBe(false);
    expect(
      allowed(
        "PUT",
        `${r}/contents/docs%2Fconfiguration.md`,
        JSON.stringify({
          message: "m",
          content: "eA==",
          sha: binding.baseBlobSha,
        }),
      ),
    ).toBe(false);
    expect(
      allowed("PUT", `${r}/contents/docs%2Fconfiguration.md`, "not json"),
    ).toBe(false);
    expect(
      allowed(
        "GET",
        `${r}/pulls?head=acme%3Adocusync%2Fpr-5-0123456789ab&state=all`,
      ),
    ).toBe(true);
    expect(allowed("GET", `${r}/pulls?state=all`)).toBe(false);
    expect(
      allowed("GET", `${r}/compare/${binding.headSha}...${randomSha()}`),
    ).toBe(true);
    expect(allowed("GET", `${r}/compare/${binding.headSha}...main`)).toBe(
      false,
    );
    expect(allowed("GET", `${r}/%E0%A4%A`)).toBe(false);
  });
});

describe("logging", () => {
  it("never logs the token or GitHub's messages when revocation fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { gh, opts } = setup();
    const w = await openGitHubWriter(opts());
    gh.failNext((m) => m === "DELETE", { status: 500 });
    await w.close();
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.join("\n")).not.toMatch(/ghs_|fault/);
    expect(lines.some((l) => l.includes("github_token_revoke"))).toBe(true);
    log.mockRestore();
  });
});

describe("request guard (hook layer, on its own)", () => {
  const { binding: b } = setup();
  const trees = new Set([b.headSha]);
  const repo = { owner: b.owner, repo: b.repo };
  const put = {
    ...repo,
    path: b.targetPath,
    message: "m",
    content: "eA==",
    sha: b.baseBlobSha,
    branch: b.branch,
  };
  const pull = {
    ...repo,
    title: "t",
    body: "b",
    head: b.branch,
    base: b.docsPrBaseRef,
    maintainer_can_modify: false,
  };
  const allows = (route: string, params: Record<string, unknown>) =>
    hookAllows(b, trees, route, params);
  const PUT = "PUT /repos/{owner}/{repo}/contents/{path}";
  const PULLS = "POST /repos/{owner}/{repo}/pulls";

  it("allows exactly the bound parameters and nothing near them", () => {
    expect(allows(PUT, put)).toBe(true);
    expect(allows(PULLS, pull)).toBe(true);
    const noBranch: Record<string, unknown> = { ...put };
    delete noBranch.branch;
    expect(allows(PUT, noBranch)).toBe(false);
    expect(allows(PUT, { ...put, branch: `${b.branch}x` })).toBe(false);
    expect(allows(PUT, { ...put, committer: { name: "x" } })).toBe(false);
    expect(allows(PUT, { ...put, message: 1 })).toBe(false);
    expect(allows(PULLS, { ...pull, maintainer_can_modify: true })).toBe(false);
    expect(allows(PULLS, { ...pull, issue: 1 })).toBe(false);
    expect(
      allows(`PUT /repos/${b.owner}/${b.repo}/contents/${b.targetPath}`, put),
    ).toBe(false);
    expect(
      allows("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
        ...repo,
        pull_number: 5,
      }),
    ).toBe(false);
    expect(
      allows("POST /repos/{owner}/{repo}/git/refs", {
        ...repo,
        ref: `refs/heads/${b.branch}`,
        sha: randomSha(),
      }),
    ).toBe(false);
    expect(
      allows("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        ...repo,
        tree_sha: randomSha(),
      }),
    ).toBe(false);
    expect(
      allows("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: "x",
        repo: b.repo,
        pull_number: 5,
      }),
    ).toBe(false);
  });
});

describe("token handling", () => {
  it("revokes the token even after the operation's deadline has fired", async () => {
    const { gh, opts } = setup();
    const deadline = new AbortController();
    const w = await openGitHubWriter(opts({ signal: deadline.signal }));
    deadline.abort(new DOMException("deadline", "TimeoutError"));
    await expect(w.getPull()).rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
    await w.close();
    expect(gh.revoked).toBe(1);
  });

  it("reports a refused token request with its own code", async () => {
    const { gh, opts } = setup();
    gh.failNext((m, p) => m === "POST" && p.endsWith("/access_tokens"), {
      status: 422,
    });
    await expect(openGitHubWriter(opts())).rejects.toMatchObject({
      code: "GITHUB_TOKEN_REFUSED",
    });
  });

  it.each([
    [
      "another endpoint",
      (o: ReturnType<typeof guardedTokenClient>) => o.request("GET /app"),
    ],
    [
      "another installation",
      (o: ReturnType<typeof guardedTokenClient>) =>
        o.request("POST /app/installations/{installation_id}/access_tokens", {
          installation_id: 8,
          repository_ids: [42],
          permissions: { contents: "write", pull_requests: "write" },
        }),
    ],
    [
      "more permissions",
      (o: ReturnType<typeof guardedTokenClient>) =>
        o.request("POST /app/installations/{installation_id}/access_tokens", {
          installation_id: 7,
          repository_ids: [42],
          permissions: {
            contents: "write",
            pull_requests: "write",
            administration: "write",
          },
        }),
    ],
    [
      "the whole installation",
      (o: ReturnType<typeof guardedTokenClient>) =>
        o.request("POST /app/installations/{installation_id}/access_tokens", {
          installation_id: 7,
          permissions: { contents: "write", pull_requests: "write" },
        }),
    ],
    [
      "a repository write",
      (o: ReturnType<typeof guardedTokenClient>) =>
        o.request("PUT /repos/{owner}/{repo}/contents/{path}", {
          owner: "acme",
          repo: "widgets",
          path: DOC,
          message: "m",
          content: "eA==",
        }),
    ],
  ])(
    "the token client refuses %s before anything is sent",
    async (_label, run) => {
      const { gh, opts } = setup();
      await expect(run(guardedTokenClient(opts()))).rejects.toMatchObject({
        code: "GITHUB_WRITE_BLOCKED",
      });
      expect(gh.requests).toEqual([]);
    },
  );

  it("offers no merge, delete or generic request method", async () => {
    const { opts } = setup();
    const w = await openGitHubWriter(opts());
    expect(Object.keys(w).sort()).toEqual([
      "branchSha",
      "close",
      "compare",
      "createBranch",
      "createPull",
      "findTarget",
      "getBaseBlob",
      "getPull",
      "listBranchPulls",
      "putTarget",
    ]);
    await w.close();
  });
});
