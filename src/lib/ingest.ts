import { normalizeFiles } from "@/lib/diff-analyzer/normalize";
import {
  GitHubReadError,
  rawPullRequestSchema,
  type GitHubReader,
  type RawPullRequest,
} from "@/lib/github/reader";
import {
  DIFF_LIMITS,
  pullRequestRefSchema,
  pullRequestSnapshotSchema,
  type PullRequestRef,
  type PullRequestSnapshot,
} from "@/lib/schemas";

export interface IngestOptions {
  /** Fail with GITHUB_STALE_HEAD unless the PR head is exactly this commit. */
  expectedHeadSha?: string;
}

async function fetchPull(
  reader: GitHubReader,
  ref: PullRequestRef,
): Promise<RawPullRequest> {
  const pull = rawPullRequestSchema.safeParse(await reader.getPullRequest(ref));
  if (!pull.success || pull.data.number !== ref.number) {
    throw new GitHubReadError("GITHUB_INVALID_RESPONSE");
  }
  return pull.data;
}

/**
 * Fetches PR metadata and changed files through a read-only reader and returns a
 * validated, bounded snapshot. Never checks out or executes repository code.
 *
 * GitHub's file list always reflects the PR's current head, so the metadata is
 * read again afterwards: if the head or base moved in between, the files may not
 * belong to the reported commit and ingestion fails with GITHUB_STALE_HEAD.
 */
export async function ingestPullRequest(
  reader: GitHubReader,
  ref: PullRequestRef,
  options: IngestOptions = {},
): Promise<PullRequestSnapshot> {
  const parsedRef = pullRequestRefSchema.safeParse(ref);
  if (!parsedRef.success) throw new GitHubReadError("INVALID_PULL_REQUEST_REF");
  const safeRef = parsedRef.data;

  const before = await fetchPull(reader, safeRef);
  if (
    options.expectedHeadSha !== undefined &&
    before.head.sha !== options.expectedHeadSha
  ) {
    throw new GitHubReadError("GITHUB_STALE_HEAD");
  }
  const { files: rawFiles, truncated } = await reader.listFiles(
    safeRef,
    DIFF_LIMITS.maxFiles,
  );
  const after = await fetchPull(reader, safeRef);
  if (
    after.head.sha !== before.head.sha ||
    after.base.sha !== before.base.sha
  ) {
    throw new GitHubReadError("GITHUB_STALE_HEAD");
  }

  const { files, rejectedFiles } = normalizeFiles(
    rawFiles.slice(0, DIFF_LIMITS.maxFiles),
  );
  const snapshot = pullRequestSnapshotSchema.safeParse({
    ref: safeRef,
    title: before.title,
    headSha: before.head.sha,
    baseSha: before.base.sha,
    files,
    rejectedFiles,
    filesTruncated: truncated || rawFiles.length > DIFF_LIMITS.maxFiles,
  });
  if (!snapshot.success) throw new GitHubReadError("GITHUB_INVALID_RESPONSE");
  return snapshot.data;
}
