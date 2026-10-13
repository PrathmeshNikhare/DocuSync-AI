import { z } from "zod";
import type { PullRequestRef } from "@/lib/schemas";

// GitHub REST responses are external input. These schemas keep only the fields we
// use and ignore the rest (GitHub adds fields over time). Values are re-validated
// against the stricter snapshot contracts during normalization.

export const rawPullRequestSchema = z.object({
  number: z.int().min(1),
  title: z.string(),
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
});
export type RawPullRequest = z.infer<typeof rawPullRequestSchema>;

/** The fields the live path and the writer need beyond the snapshot. */
export const livePullSchema = z.object({
  state: z.string(),
  head: z.object({
    sha: z.string(),
    ref: z.string().min(1).max(255),
    // Null when the fork was deleted.
    repo: z.object({ id: z.int().min(1) }).nullable(),
  }),
  base: z.object({
    ref: z.string().min(1).max(255),
    repo: z.object({
      id: z.int().min(1),
      // GitHub's canonical names, which the live path stores (not CLI input).
      name: z.string().optional(),
      owner: z.object({ login: z.string() }).optional(),
    }),
  }),
});

export const rawPullFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.int().min(0),
  deletions: z.int().min(0),
  patch: z.string().optional(),
});
export type RawPullFile = z.infer<typeof rawPullFileSchema>;

export const GITHUB_ERROR_CODES = [
  "GITHUB_UNAUTHORIZED",
  "GITHUB_FORBIDDEN",
  "GITHUB_NOT_FOUND",
  "GITHUB_RATE_LIMITED",
  "GITHUB_TIMEOUT",
  "GITHUB_NETWORK_ERROR",
  "GITHUB_UPSTREAM_ERROR",
  /** The PR head or base moved during ingestion, or differs from the expected head. */
  "GITHUB_STALE_HEAD",
  "INVALID_PULL_REQUEST_REF",
  "GITHUB_INVALID_RESPONSE",
  "GITHUB_WRITE_BLOCKED",
  /** A 3xx from GitHub: never followed (docs/13). */
  "GITHUB_REDIRECT",
  /** The installation token does not have exactly the requested scope. */
  "GITHUB_TOKEN_SCOPE",
  /** GitHub refused to mint the token (e.g. the App lacks a permission). */
  "GITHUB_TOKEN_REFUSED",
  /** A conditional write was refused because the target changed (409/422). */
  "GITHUB_CONFLICT",
  /** GITHUB_WRITES_ENABLED is not "true". */
  "WRITES_DISABLED",
  "GITHUB_REQUEST_FAILED",
  "FIXTURE_NOT_FOUND",
] as const;
export type GitHubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

/** Carries a safe error code only; upstream messages and URLs are never attached. */
export class GitHubReadError extends Error {
  constructor(readonly code: GitHubErrorCode) {
    super(code);
    this.name = "GitHubReadError";
  }
}

/**
 * Read-only by construction: there is no method that writes to GitHub.
 * Results are untrusted (`unknown`); callers validate them.
 */
export interface GitHubReader {
  getPullRequest(ref: PullRequestRef): Promise<unknown>;
  /** Returns at most `maxFiles` entries; `truncated` is true if GitHub had more. */
  listFiles(
    ref: PullRequestRef,
    maxFiles: number,
  ): Promise<{ files: unknown[]; truncated: boolean }>;
}

/** Repository contents at a commit, for the live CLI path (contents: read). */
export interface GitHubTreeReader {
  /** The recursive tree of `sha`. */
  getTree(ref: PullRequestRef, sha: string): Promise<unknown>;
  getBlob(ref: PullRequestRef, sha: string): Promise<unknown>;
}
