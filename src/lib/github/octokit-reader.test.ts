import { generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import {
  READ_ONLY_PERMISSIONS,
  addRequestGuards,
  createOctokitReader,
  mapGitHubError,
} from "./octokit-reader";
import { GitHubReadError } from "./reader";

// Octokit core binds console.warn/error once, when it is first imported, so the
// spies must exist before any import runs to observe its default logger.
const consoleSpies = vi.hoisted(() =>
  (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  ),
);

// Generated per run: no real or committed key is ever used.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const REF = { owner: "example-org", repo: "example-repo", number: 7 };
const TOKEN = "ghs_testinstallationtoken000000000000";

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

type Route = (call: Call) => Response | Promise<Response> | undefined;

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

function mockFetch(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    if (
      call.method === "POST" &&
      /\/app\/installations\/\d+\/access_tokens$/.test(url)
    ) {
      return json(
        {
          token: TOKEN,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: call.body,
        },
        { status: 201 },
      );
    }
    return (
      (await route(call)) ?? json({ message: "Not Found" }, { status: 404 })
    );
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

const reader = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  createOctokitReader({
    appId: "12345",
    privateKey,
    installationId: 99,
    fetch: fetchImpl,
    timeoutMs,
  });

const fileEntry = (i: number) => ({
  sha: "x",
  filename: `docs/f${i}.md`,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  blob_url: "https://example.invalid",
  patch: "@@ -1 +1,2 @@\n a\n+b",
});

describe("createOctokitReader", () => {
  it("requests a read-only installation token and uses it for GET calls", async () => {
    const { fetch, calls } = mockFetch(({ url }) =>
      url.endsWith("/repos/example-org/example-repo/pulls/7")
        ? json({ number: 7, title: "t" })
        : undefined,
    );
    await expect(reader(fetch).getPullRequest(REF)).resolves.toMatchObject({
      number: 7,
    });

    const tokenCall = calls.find((c) => c.method === "POST");
    expect(tokenCall?.url).toMatch(/\/app\/installations\/99\/access_tokens$/);
    expect(tokenCall?.body).toEqual({ permissions: READ_ONLY_PERMISSIONS });
    expect(tokenCall?.auth).toMatch(/^bearer /i); // app JWT, not the installation token

    const repoCalls = calls.filter((c) => c.url.includes("/repos/"));
    expect(repoCalls.every((c) => c.method === "GET")).toBe(true);
    expect(repoCalls[0]?.auth).toBe(`token ${TOKEN}`);
  });

  it("paginates files and stops at the limit with truncation", async () => {
    const { fetch, calls } = mockFetch(({ url }) => {
      const m = /\/pulls\/7\/files\?per_page=100(?:&page=(\d+))?$/.exec(url);
      if (!m) return undefined;
      const page = Number(m[1] ?? 1);
      const items = Array.from({ length: 100 }, (_, i) =>
        fileEntry((page - 1) * 100 + i),
      );
      return json(items, {
        headers:
          page < 3
            ? {
                link: `<https://api.github.com/repos/example-org/example-repo/pulls/7/files?per_page=100&page=${page + 1}>; rel="next"`,
              }
            : {},
      });
    });
    const out = await reader(fetch).listFiles(REF, 150);
    expect(out.truncated).toBe(true);
    expect(out.files).toHaveLength(150);
    expect(out.files[0]).toEqual({
      filename: "docs/f0.md",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n a\n+b",
    });
    expect(calls.filter((c) => c.url.includes("/files")).length).toBe(2); // page 3 never fetched

    const all = await reader(fetch).listFiles(REF, 1000);
    expect(all).toMatchObject({ truncated: false });
    expect(all.files).toHaveLength(300);
  });

  /** Serves `total` files in pages of 100 with GitHub-style Link headers. */
  const pagedFiles = (total: number) =>
    mockFetch(({ url }) => {
      const m = /\/pulls\/7\/files\?per_page=100(?:&page=(\d+))?$/.exec(url);
      if (!m) return undefined;
      const page = Number(m[1] ?? 1);
      const start = (page - 1) * 100;
      const items = Array.from(
        { length: Math.max(0, Math.min(100, total - start)) },
        (_, i) => fileEntry(start + i),
      );
      const next = start + 100 < total;
      return json(items, {
        headers: next
          ? {
              link: `<https://api.github.com/repos/example-org/example-repo/pulls/7/files?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : {},
      });
    });

  it.each([
    ["limit equals the total (300 of 300)", 300, 300, 300, false],
    ["limit equals a single full page", 100, 100, 100, false],
    ["limit lands on a page edge with more pages", 200, 100, 100, true],
    ["one file over the limit", 101, 100, 100, true],
    ["fewer files than the limit", 42, 300, 42, false],
    ["no files", 0, 300, 0, false],
  ])("pagination: %s", async (_label, total, max, expected, truncated) => {
    const { fetch } = pagedFiles(total);
    const out = await reader(fetch).listFiles(REF, max);
    expect(out.files).toHaveLength(expected);
    expect(out.truncated).toBe(truncated);
  });

  it("maps a malformed file entry to null so normalization rejects it", async () => {
    const { fetch } = mockFetch(({ url }) =>
      url.includes("/files")
        ? json([{ filename: 42 }, fileEntry(1)])
        : undefined,
    );
    const out = await reader(fetch).listFiles(REF, 10);
    expect(out.files[0]).toBeNull();
    expect(out.files[1]).toMatchObject({ filename: "docs/f1.md" });
  });

  it.each([
    [404, {}, "GITHUB_NOT_FOUND"],
    [401, {}, "GITHUB_UNAUTHORIZED"],
    [403, {}, "GITHUB_FORBIDDEN"],
    [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED"],
    [429, {}, "GITHUB_RATE_LIMITED"],
    [
      403,
      { "retry-after": "60", "x-ratelimit-remaining": "4000" },
      "GITHUB_RATE_LIMITED",
    ],
    [500, {}, "GITHUB_UPSTREAM_ERROR"],
    [502, {}, "GITHUB_UPSTREAM_ERROR"],
  ])("maps HTTP %i to a safe code", async (status, headers, code) => {
    const { fetch } = mockFetch(({ url }) =>
      url.includes("/pulls/7")
        ? json(
            { message: `secret upstream detail ${TOKEN}` },
            { status, headers },
          )
        : undefined,
    );
    for (const spy of consoleSpies) spy.mockClear();
    const err = await reader(fetch)
      .getPullRequest(REF)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubReadError);
    expect(err).toMatchObject({ code, message: code });
    // Octokit's own request logging must not print paths or statuses.
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("times out a hanging request", async () => {
    const { fetch } = mockFetch(({ url }) =>
      url.includes("/pulls/7")
        ? new Promise<Response>(() => {
            /* never resolves; relies on the abort signal */
          })
        : undefined,
    );
    const hanging: typeof globalThis.fetch = (input, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
        void fetch(input, init).then(resolve, reject);
      });
    await expect(reader(hanging, 50).getPullRequest(REF)).rejects.toMatchObject(
      {
        code: "GITHUB_TIMEOUT",
      },
    );
  });

  it("maps a network failure (no HTTP response) to GITHUB_NETWORK_ERROR", async () => {
    const { fetch } = mockFetch(({ url }) => {
      if (!url.includes("/pulls/7")) return undefined;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
        }),
      });
    });
    await expect(reader(fetch).getPullRequest(REF)).rejects.toMatchObject({
      code: "GITHUB_NETWORK_ERROR",
    });
  });

  it("maps a failed token exchange without leaking details", async () => {
    const failing: typeof fetch = async () =>
      json(
        { message: "A JSON web token could not be decoded" },
        { status: 401 },
      );
    await expect(reader(failing).getPullRequest(REF)).rejects.toMatchObject({
      code: "GITHUB_UNAUTHORIZED",
    });
  });
});

describe("addRequestGuards", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "blocks %s before any network call",
    async (method) => {
      const { fetch, calls } = mockFetch(() => json({}));
      const octokit = new Octokit({ request: { fetch } });
      addRequestGuards(octokit, 1000, true);
      await expect(
        octokit.request(`${method} /repos/{owner}/{repo}/pulls`, {
          owner: "o",
          repo: "r",
        }),
      ).rejects.toMatchObject({ code: "GITHUB_WRITE_BLOCKED" });
      expect(calls).toHaveLength(0);
    },
  );

  it("allows GET", async () => {
    const { fetch, calls } = mockFetch(() => json({ ok: true }));
    const octokit = new Octokit({ request: { fetch } });
    addRequestGuards(octokit, 1000, true);
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "o",
      repo: "r",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("mapGitHubError", () => {
  it("never carries the original message", () => {
    const mapped = mapGitHubError(new Error(`boom ${TOKEN}`));
    expect(mapped.code).toBe("GITHUB_REQUEST_FAILED");
    expect(mapped.message).not.toContain(TOKEN);
  });
});

describe("live reader token scope (security-check L-1)", () => {
  it("asks for contents read on one named repository and reports the repository ids GitHub granted", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(
        JSON.stringify({
          token: TOKEN,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: {
            pull_requests: "read",
            contents: "read",
            metadata: "read",
          },
          repositories: [{ id: 42, name: "widgets" }],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const live = createOctokitReader({
      appId: "12345",
      privateKey,
      installationId: 99,
      repositoryName: "widgets",
      fetch: fetchImpl,
    });
    expect(await live.tokenRepositoryIds()).toEqual([42]);
    expect(bodies[0]).toEqual({
      repositories: ["widgets"],
      permissions: { pull_requests: "read", contents: "read" },
    });
  });
});
