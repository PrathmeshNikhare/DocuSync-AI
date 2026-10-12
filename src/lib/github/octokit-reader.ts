import "server-only";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import {
  GitHubReadError,
  rawPullFileSchema,
  type GitHubErrorCode,
  type GitHubReader,
  type GitHubTreeReader,
} from "./reader";

/** Installation tokens are requested with these permissions only. */
export const READ_ONLY_PERMISSIONS = { pull_requests: "read" } as const;
/** The live CLI path also reads documentation at the PR head. */
export const LIVE_READ_PERMISSIONS = {
  pull_requests: "read",
  contents: "read",
} as const;
export const REQUEST_TIMEOUT_MS = 10_000;

// Octokit's request-log plugin would print method, repository path and status on
// every error, outside our structured logging. Failures surface as GitHubReadError codes.
const noop = () => {};
export const SILENT_LOG = { debug: noop, info: noop, warn: noop, error: noop };

export interface OctokitReaderOptions {
  appId: string;
  privateKey: string;
  installationId: number;
  /**
   * For the live CLI path: the token also gets `contents: read`, scoped to this
   * one repository of the installation.
   */
  repositoryName?: string;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function mapGitHubError(err: unknown): GitHubReadError {
  if (err instanceof GitHubReadError) return err;
  // A guard inside fetch throws our own code; Octokit wraps it as a status-500 cause.
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof GitHubReadError) return cause;
  const e = err as {
    name?: string;
    status?: number;
    cause?: { name?: string };
    response?: { headers?: Record<string, string | undefined> };
  };
  // Octokit wraps a fetch abort in a status-500 RequestError, keeping it as `cause`.
  const isAbort = (name?: string) =>
    name === "TimeoutError" || name === "AbortError";
  if (isAbort(e?.name) || isAbort(e?.cause?.name)) {
    return new GitHubReadError("GITHUB_TIMEOUT");
  }
  if (typeof e?.status === "number") {
    // Octokit reports fetch failures (DNS, reset, refused) as status 500 with no
    // HTTP response; a real 5xx from GitHub always has one.
    if (!e.response) return new GitHubReadError("GITHUB_NETWORK_ERROR");
    const s = e.status;
    const headers = e.response.headers ?? {};
    // Primary limit: remaining is "0". Secondary limit: 403 with retry-after.
    const rateLimited =
      s === 429 ||
      (s === 403 &&
        (headers["x-ratelimit-remaining"] === "0" ||
          headers["retry-after"] !== undefined));
    let code: GitHubErrorCode = "GITHUB_REQUEST_FAILED";
    if (s === 401) code = "GITHUB_UNAUTHORIZED";
    else if (rateLimited) code = "GITHUB_RATE_LIMITED";
    else if (s === 403) code = "GITHUB_FORBIDDEN";
    else if (s === 404) code = "GITHUB_NOT_FOUND";
    else if (s >= 500) code = "GITHUB_UPSTREAM_ERROR";
    return new GitHubReadError(code);
  }
  return new GitHubReadError("GITHUB_REQUEST_FAILED");
}

/**
 * Gives every request its own timeout. With `readOnly`, anything other than GET is
 * refused before it is sent.
 */
export function addRequestGuards(
  octokit: Octokit,
  timeoutMs: number,
  readOnly: boolean,
): void {
  octokit.hook.wrap("request", async (request, options) => {
    if (readOnly && options.method !== "GET") {
      throw new GitHubReadError("GITHUB_WRITE_BLOCKED");
    }
    // Mutate in place: inner hook layers (e.g. auth) are bound to this same
    // options object and ignore any copy passed to request().
    options.request = {
      ...options.request,
      signal: AbortSignal.timeout(timeoutMs),
    };
    return request(options);
  });
}

/**
 * Live GitHub App reader. The only non-GET call is the installation-token
 * exchange done by @octokit/auth-app, on a separate client that never touches
 * repository endpoints.
 */
export function createOctokitReader(
  opts: OctokitReaderOptions,
): GitHubReader & GitHubTreeReader {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const requestOptions = opts.fetch ? { fetch: opts.fetch } : {};
  const tokenClient = new Octokit({ request: requestOptions, log: SILENT_LOG });
  addRequestGuards(tokenClient, timeoutMs, false);
  const auth = createAppAuth({
    appId: opts.appId,
    privateKey: opts.privateKey,
    request: tokenClient.request,
    log: SILENT_LOG,
  });

  let client: Promise<Octokit> | undefined;
  const getClient = () =>
    (client ??= auth({
      type: "installation",
      installationId: opts.installationId,
      ...(opts.repositoryName
        ? {
            permissions: LIVE_READ_PERMISSIONS,
            repositoryNames: [opts.repositoryName],
          }
        : { permissions: READ_ONLY_PERMISSIONS }),
    })
      .then(({ token }) => {
        const octokit = new Octokit({
          auth: token,
          request: requestOptions,
          log: SILENT_LOG,
        });
        addRequestGuards(octokit, timeoutMs, true);
        return octokit;
      })
      .catch((err: unknown) => {
        client = undefined; // allow a later retry with a fresh token
        throw mapGitHubError(err);
      }));

  return {
    async getPullRequest(ref) {
      try {
        const octokit = await getClient();
        // Paths and names are passed as parameters; Octokit encodes them.
        const { data } = await octokit.rest.pulls.get({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
        });
        return data;
      } catch (err) {
        throw mapGitHubError(err);
      }
    },

    async getTree(ref, sha) {
      try {
        const octokit = await getClient();
        const { data } = await octokit.rest.git.getTree({
          owner: ref.owner,
          repo: ref.repo,
          tree_sha: sha,
          recursive: "1",
        });
        return data;
      } catch (err) {
        throw mapGitHubError(err);
      }
    },

    async getBlob(ref, sha) {
      try {
        const octokit = await getClient();
        const { data } = await octokit.rest.git.getBlob({
          owner: ref.owner,
          repo: ref.repo,
          file_sha: sha,
        });
        return data;
      } catch (err) {
        throw mapGitHubError(err);
      }
    },

    async listFiles(ref, maxFiles) {
      try {
        const octokit = await getClient();
        const files: unknown[] = [];
        for await (const page of octokit.paginate.iterator(
          octokit.rest.pulls.listFiles,
          {
            owner: ref.owner,
            repo: ref.repo,
            pull_number: ref.number,
            per_page: 100,
          },
        )) {
          for (const f of page.data) {
            if (files.length === maxFiles) return { files, truncated: true };
            // Keep only the fields we use so large unrelated fields are dropped early.
            const parsed = rawPullFileSchema.safeParse(f);
            files.push(parsed.success ? parsed.data : null);
          }
        }
        return { files, truncated: false };
      } catch (err) {
        throw mapGitHubError(err);
      }
    },
  };
}
