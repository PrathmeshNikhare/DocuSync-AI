import "server-only";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { writesEnabled } from "@/lib/env";
import { logEvent } from "@/lib/log";
import {
  mapGitHubError,
  REQUEST_TIMEOUT_MS,
  SILENT_LOG,
} from "./octokit-reader";
import { GitHubReadError } from "./reader";

/** Writer tokens ask for exactly these permissions, for exactly one repository. */
export const WRITE_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
} as const;
const API = "https://api.github.com";
const SHA1 = /^[0-9a-f]{40}$/;

/** Everything one write operation may touch. The guard allows nothing else. */
export interface WriteBinding {
  installationId: number;
  githubRepoId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseBlobSha: string;
  targetPath: string;
  branch: string;
  docsPrBaseRef: string;
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
}

/**
 * The only way this codebase writes to GitHub. One instance serves one write
 * operation with its own token. There is no merge, delete or generic request.
 * Results are untrusted (`unknown`); the caller validates them.
 */
export interface GitHubWriter {
  getPull(): Promise<unknown>;
  /** The target path's entry at `headSha`, walking one directory tree at a time. */
  findTarget(): Promise<TreeEntry | "missing" | "truncated">;
  getBaseBlob(): Promise<unknown>;
  /** The docs branch tip, or undefined if the branch does not exist. */
  branchSha(): Promise<string | undefined>;
  /** False if the branch already exists. */
  createBranch(): Promise<boolean>;
  compare(tip: string): Promise<unknown>;
  /** Throws GITHUB_CONFLICT when GitHub refuses the conditional write. */
  putTarget(content: string, message: string): Promise<unknown>;
  listBranchPulls(): Promise<unknown[]>;
  /** Undefined when GitHub says a PR for the branch already exists. */
  createPull(title: string, body: string): Promise<unknown>;
  /** Revokes the token. Never throws. */
  close(): Promise<void>;
}

export interface WriterOptions {
  appId: string;
  privateKey: string;
  binding: WriteBinding;
  /** The whole operation's deadline; each request also has its own timeout. */
  signal: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

const ANY_STRING = Symbol("any string");
type Expected = Record<string, unknown>;

function matches(actual: Record<string, unknown>, expected: Expected) {
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every(
      (k) =>
        Object.hasOwn(expected, k) &&
        (expected[k] === ANY_STRING
          ? typeof actual[k] === "string"
          : JSON.stringify(actual[k]) === JSON.stringify(expected[k])),
    )
  );
}

/** Exact parameters for each allowed (method, route template); undefined refuses. */
function expectedParams(
  b: WriteBinding,
  trees: ReadonlySet<string>,
  route: string,
  p: Record<string, unknown>,
): Expected | undefined {
  const repo = { owner: b.owner, repo: b.repo };
  switch (route) {
    case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
      return { ...repo, pull_number: b.pullNumber };
    case "GET /repos/{owner}/{repo}/git/trees/{tree_sha}":
      return typeof p.tree_sha === "string" && trees.has(p.tree_sha)
        ? { ...repo, tree_sha: p.tree_sha }
        : undefined;
    case "GET /repos/{owner}/{repo}/git/blobs/{file_sha}":
      return { ...repo, file_sha: b.baseBlobSha };
    case "GET /repos/{owner}/{repo}/git/ref/{ref}":
      return { ...repo, ref: `heads/${b.branch}` };
    case "POST /repos/{owner}/{repo}/git/refs":
      return { ...repo, ref: `refs/heads/${b.branch}`, sha: b.headSha };
    case "GET /repos/{owner}/{repo}/compare/{basehead}": {
      const tip = String(p.basehead).split(`${b.headSha}...`);
      return tip.length === 2 && tip[0] === "" && SHA1.test(tip[1]!)
        ? { ...repo, basehead: p.basehead }
        : undefined;
    }
    case "PUT /repos/{owner}/{repo}/contents/{path}":
      // `branch` is required: without it GitHub writes to the default branch.
      return {
        ...repo,
        path: b.targetPath,
        message: ANY_STRING,
        content: ANY_STRING,
        sha: b.baseBlobSha,
        branch: b.branch,
      };
    case "GET /repos/{owner}/{repo}/pulls":
      return { ...repo, head: `${b.owner}:${b.branch}`, state: "all" };
    case "POST /repos/{owner}/{repo}/pulls":
      return {
        ...repo,
        title: ANY_STRING,
        body: ANY_STRING,
        head: b.branch,
        base: b.docsPrBaseRef,
        maintainer_can_modify: false,
      };
    case "DELETE /installation/token":
      return {};
  }
  return undefined;
}

/** The first layer: exact route template and parameters, as Octokit sees them. */
export function hookAllows(
  b: WriteBinding,
  trees: ReadonlySet<string>,
  route: string,
  params: Record<string, unknown>,
): boolean {
  const want = expectedParams(b, trees, route, params);
  return want !== undefined && matches(params, want);
}

/** The second layer: the real URL, method and body, independent of Octokit. */
export function fetchAllowed(
  b: WriteBinding,
  trees: ReadonlySet<string>,
  method: string,
  url: URL,
  body: unknown,
): boolean {
  if (url.origin !== API || url.username || url.password || url.hash)
    return false;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  const r = `/repos/${b.owner}/${b.repo}`;
  const query = [...url.searchParams.keys()];
  if (method === "GET" && path === `${r}/pulls`) {
    return (
      query.length === 2 &&
      url.searchParams.get("head") === `${b.owner}:${b.branch}` &&
      url.searchParams.get("state") === "all"
    );
  }
  if (query.length > 0) return false;
  const compare = `${r}/compare/${b.headSha}...`;
  switch (method) {
    case "GET":
      return (
        body === undefined &&
        (path === `${r}/pulls/${b.pullNumber}` ||
          [...trees].some((t) => path === `${r}/git/trees/${t}`) ||
          path === `${r}/git/blobs/${b.baseBlobSha}` ||
          path === `${r}/git/ref/heads/${b.branch}` ||
          (path.startsWith(compare) && SHA1.test(path.slice(compare.length))))
      );
    case "POST":
      return (
        (path === `${r}/git/refs` &&
          isBody(body, { ref: `refs/heads/${b.branch}`, sha: b.headSha })) ||
        (path === `${r}/pulls` &&
          isBody(body, {
            title: ANY_STRING,
            body: ANY_STRING,
            head: b.branch,
            base: b.docsPrBaseRef,
            maintainer_can_modify: false,
          }))
      );
    case "PUT":
      return (
        path === `${r}/contents/${b.targetPath}` &&
        isBody(body, {
          message: ANY_STRING,
          content: ANY_STRING,
          sha: b.baseBlobSha,
          branch: b.branch,
        })
      );
    case "DELETE":
      return path === "/installation/token" && body === undefined;
  }
  return false;
}

function isBody(body: unknown, expected: Expected): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      matches(parsed as Record<string, unknown>, expected)
    );
  } catch {
    return false;
  }
}

const blocked = () => new GitHubReadError("GITHUB_WRITE_BLOCKED");
const OPTION_KEYS = new Set([
  "method",
  "url",
  "baseUrl",
  "headers",
  "mediaType",
  "request",
]);

/**
 * Hook layer: exact route templates and parameters, no per-request base URL,
 * header or fetch overrides, no redirects, and a timeout plus the deadline on
 * every request.
 */
function guard(
  octokit: Octokit,
  ownFetch: typeof fetch,
  allowedHeaders: ReadonlySet<string>,
  allows: (route: string, params: Record<string, unknown>) => boolean,
  opts: WriterOptions,
) {
  octokit.hook.wrap("request", async (request, options) => {
    const o = options as unknown as Record<string, unknown> & {
      method: string;
      url: string;
      headers: Record<string, unknown>;
      request?: Record<string, unknown>;
    };
    const params = Object.fromEntries(
      Object.entries(o).filter(([k]) => !OPTION_KEYS.has(k)),
    );
    const route = `${o.method} ${o.url}`;
    if (
      !allows(route, params) ||
      o.baseUrl !== API ||
      !Object.keys(o.headers ?? {}).every((h) =>
        allowedHeaders.has(h.toLowerCase()),
      ) ||
      o.request?.fetch !== ownFetch
    ) {
      throw blocked();
    }
    if (
      route !== "DELETE /installation/token" &&
      o.method !== "GET" &&
      !writesEnabled(opts.env)
    ) {
      throw new GitHubReadError("WRITES_DISABLED");
    }
    // Mutate in place: inner hook layers (auth) are bound to this object.
    // The token revocation gets its own timeout only: it must still run after
    // the operation's deadline has fired.
    const own = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    o.request = {
      ...o.request,
      redirect: "manual",
      signal:
        route === "DELETE /installation/token"
          ? own
          : AbortSignal.any([own, opts.signal]),
    };
    return request(options);
  });
}

/** Fetch layer: refuses anything off the allowlist and never follows a redirect. */
function guardedFetch(
  allowed: (method: string, url: URL, body: unknown) => boolean,
  inner: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    if (!allowed(method, url, init?.body ?? undefined)) throw blocked();
    const res = await inner(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      throw new GitHubReadError("GITHUB_REDIRECT");
    }
    return res;
  };
}

const statusOf = (err: unknown) => (err as { status?: unknown })?.status;

const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
    }),
  ),
});

/** GitHub always includes read access to metadata in installation tokens. */
function exactScope(
  permissions: Record<string, string> | undefined,
  repositoryIds: readonly (number | bigint)[] | undefined,
  repoId: number,
) {
  const { metadata, ...rest } = permissions ?? {};
  return (
    (metadata === undefined || metadata === "read") &&
    matches(rest, WRITE_PERMISSIONS) &&
    repositoryIds?.length === 1 &&
    Number(repositoryIds[0]) === repoId
  );
}

/**
 * An Octokit client that can make only the calls the binding allows, through
 * both guard layers. Exported for tests; `openGitHubWriter` is the only caller.
 */
export function guardedRepoClient(
  opts: WriterOptions,
  token: string,
  trees: ReadonlySet<string>,
): Octokit {
  const b = opts.binding;
  const repoFetch = guardedFetch(
    (method, url, body) => fetchAllowed(b, trees, method, url, body),
    opts.fetch ?? globalThis.fetch,
  );
  const octokit = new Octokit({
    auth: token,
    baseUrl: API,
    request: { fetch: repoFetch },
    log: SILENT_LOG,
  });
  guard(
    octokit,
    repoFetch,
    new Set(["accept", "user-agent"]),
    (route, params) => hookAllows(b, trees, route, params),
    opts,
  );
  return octokit;
}

/**
 * The client that mints installation tokens. It can make exactly one request:
 * a token for the binding's installation, scoped to its one repository with the
 * write permissions. Exported for tests; `openGitHubWriter` is the only caller.
 */
export function guardedTokenClient(opts: WriterOptions): Octokit {
  const b = opts.binding;
  const tokenUrl = `/app/installations/${b.installationId}/access_tokens`;
  const tokenBody = {
    repository_ids: [b.githubRepoId],
    permissions: WRITE_PERMISSIONS,
  };
  const tokenFetch = guardedFetch(
    (method, url, body) =>
      method === "POST" &&
      url.origin === API &&
      url.pathname === tokenUrl &&
      url.search === "" &&
      isBody(body, tokenBody),
    opts.fetch ?? globalThis.fetch,
  );
  const tokenClient = new Octokit({
    baseUrl: API,
    request: { fetch: tokenFetch },
    log: SILENT_LOG,
  });
  guard(
    tokenClient,
    tokenFetch,
    new Set(["accept", "user-agent", "authorization"]),
    (route, params) =>
      route === "POST /app/installations/{installation_id}/access_tokens" &&
      matches(params, { installation_id: b.installationId, ...tokenBody }),
    opts,
  );
  return tokenClient;
}

/**
 * Mints a fresh installation token scoped to one repository and returns a
 * writer limited to the binding. Refuses while writes are disabled.
 */
export async function openGitHubWriter(
  opts: WriterOptions,
): Promise<GitHubWriter> {
  if (!writesEnabled(opts.env)) throw new GitHubReadError("WRITES_DISABLED");
  const b = opts.binding;
  const trees = new Set<string>();

  const tokenClient = guardedTokenClient(opts);

  let minted;
  try {
    // A new auth instance per operation: @octokit/auth-app caches tokens otherwise.
    minted = await createAppAuth({
      appId: opts.appId,
      privateKey: opts.privateKey,
      request: tokenClient.request,
      log: SILENT_LOG,
    })({
      type: "installation",
      installationId: b.installationId,
      repositoryIds: [b.githubRepoId],
      permissions: WRITE_PERMISSIONS,
    });
  } catch (err) {
    const mapped = mapGitHubError(err);
    throw mapped.code === "GITHUB_REQUEST_FAILED"
      ? new GitHubReadError("GITHUB_TOKEN_REFUSED")
      : mapped;
  }

  const octokit = guardedRepoClient(opts, minted.token, trees);
  const repo = { owner: b.owner, repo: b.repo };
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw mapGitHubError(err);
    }
  };

  const writer: GitHubWriter = {
    getPull: () =>
      call(
        async () =>
          (await octokit.rest.pulls.get({ ...repo, pull_number: b.pullNumber }))
            .data,
      ),

    findTarget: () =>
      call(async () => {
        const segments = b.targetPath.split("/");
        let tree = b.headSha;
        for (const [i, name] of segments.entries()) {
          trees.add(tree);
          const { data } = await octokit.rest.git.getTree({
            ...repo,
            tree_sha: tree,
          });
          const parsed = treeSchema.safeParse(data);
          if (!parsed.success)
            throw new GitHubReadError("GITHUB_INVALID_RESPONSE");
          if (parsed.data.truncated) return "truncated";
          const entry = parsed.data.tree.find((e) => e.path === name);
          if (!entry) return "missing";
          if (i === segments.length - 1) return entry;
          if (entry.type !== "tree" || !SHA1.test(entry.sha)) return "missing";
          tree = entry.sha;
        }
        return "missing";
      }),

    getBaseBlob: () =>
      call(
        async () =>
          (await octokit.rest.git.getBlob({ ...repo, file_sha: b.baseBlobSha }))
            .data,
      ),

    branchSha: () =>
      call(async () => {
        try {
          const { data } = await octokit.rest.git.getRef({
            ...repo,
            ref: `heads/${b.branch}`,
          });
          const sha = (data as { object?: { sha?: unknown } }).object?.sha;
          if (typeof sha !== "string" || !SHA1.test(sha))
            throw new GitHubReadError("GITHUB_INVALID_RESPONSE");
          return sha;
        } catch (err) {
          if (statusOf(err) === 404) return undefined;
          throw err;
        }
      }),

    createBranch: () =>
      call(async () => {
        try {
          await octokit.rest.git.createRef({
            ...repo,
            ref: `refs/heads/${b.branch}`,
            sha: b.headSha,
          });
          return true;
        } catch (err) {
          if (statusOf(err) === 422) return false;
          throw err;
        }
      }),

    compare: (tip) =>
      call(
        async () =>
          (
            await octokit.rest.repos.compareCommitsWithBasehead({
              ...repo,
              basehead: `${b.headSha}...${tip}`,
            })
          ).data,
      ),

    putTarget: (content, message) =>
      call(async () => {
        try {
          return (
            await octokit.rest.repos.createOrUpdateFileContents({
              ...repo,
              path: b.targetPath,
              message,
              content: Buffer.from(content, "utf8").toString("base64"),
              sha: b.baseBlobSha,
              branch: b.branch,
            })
          ).data;
        } catch (err) {
          const s = statusOf(err);
          if (s === 409 || s === 422)
            throw new GitHubReadError("GITHUB_CONFLICT");
          throw err;
        }
      }),

    listBranchPulls: () =>
      call(async () => {
        const { data } = await octokit.rest.pulls.list({
          ...repo,
          head: `${b.owner}:${b.branch}`,
          state: "all",
        });
        return data as unknown[];
      }),

    createPull: (title, body) =>
      call(async () => {
        try {
          return (
            await octokit.rest.pulls.create({
              ...repo,
              title,
              body,
              head: b.branch,
              base: b.docsPrBaseRef,
              maintainer_can_modify: false,
            })
          ).data;
        } catch (err) {
          if (statusOf(err) === 422) return undefined;
          throw err;
        }
      }),

    async close() {
      try {
        await octokit.request("DELETE /installation/token");
      } catch (err) {
        logEvent("github_token_revoke", {
          outcome: "error",
          code: mapGitHubError(err).code,
        });
      }
    },
  };

  if (
    !exactScope(
      minted.permissions as Record<string, string> | undefined,
      minted.repositoryIds,
      b.githubRepoId,
    )
  ) {
    await writer.close();
    throw new GitHubReadError("GITHUB_TOKEN_SCOPE");
  }
  return writer;
}
