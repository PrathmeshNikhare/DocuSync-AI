import { z } from "zod";
import { gitBlobSha } from "@/lib/patches/blob-sha";
import { docPathIssues } from "@/lib/patches/policy";
import { DOC_LIMITS, type DocFile, type PullRequestRef } from "@/lib/schemas";
import { decodeDocBytes } from "./doc-bytes";
import { GitHubReadError, type GitHubTreeReader } from "./reader";

const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().optional(),
    }),
  ),
});
const blobSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});

/** Stop fetching past the engine's own total budget (impact-engine config). */
const MAX_TOTAL_BYTES = 10_000_000;

export interface FetchedDocs {
  docs: DocFile[];
  /** Plain-language notes for the analysis's missing context. */
  notes: string[];
}

/**
 * Reads the allowed documentation files at exactly `headSha`, through git trees
 * and blobs, so each doc's blob id is GitHub's own (docs/13). Symlinks and
 * submodules are refused, and so is any blob that would not hash back to its id
 * once decoded (a BOM, NUL or invalid UTF-8).
 */
export async function fetchDocsAtHead(
  reader: GitHubTreeReader,
  ref: PullRequestRef,
  headSha: string,
): Promise<FetchedDocs> {
  const parsed = treeSchema.safeParse(await reader.getTree(ref, headSha));
  if (!parsed.success) throw new GitHubReadError("GITHUB_INVALID_RESPONSE");
  const notes: string[] = [];
  if (parsed.data.truncated)
    notes.push(
      "GitHub truncated the repository tree, so some documentation may be missing from this analysis.",
    );
  const candidates = parsed.data.tree
    .filter((e) => e.type !== "tree" && docPathIssues(e.path).length === 0)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const skipped = { link: 0, size: 0, limit: 0, encoding: 0, mismatch: 0 };
  const docs: DocFile[] = [];
  let total = 0;
  for (const e of candidates) {
    // Refuses symlinks (120000) and submodules (160000 / type "commit").
    if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) {
      skipped.link++;
      continue;
    }
    if ((e.size ?? 0) > DOC_LIMITS.maxDocChars) {
      skipped.size++;
      continue;
    }
    if (
      docs.length >= DOC_LIMITS.maxDocs ||
      total + (e.size ?? 0) > MAX_TOTAL_BYTES
    ) {
      skipped.limit++;
      continue;
    }
    const blob = blobSchema.safeParse(await reader.getBlob(ref, e.sha));
    if (!blob.success) throw new GitHubReadError("GITHUB_INVALID_RESPONSE");
    const bytes = Buffer.from(blob.data.content, "base64");
    const decoded = decodeDocBytes(bytes);
    if (!decoded.ok || decoded.text.length > DOC_LIMITS.maxDocChars) {
      skipped.encoding++;
      continue;
    }
    if (gitBlobSha(decoded.text) !== e.sha) {
      skipped.mismatch++;
      continue;
    }
    total += bytes.byteLength;
    docs.push({ path: e.path, content: decoded.text });
  }

  const say = (n: number, why: string) => {
    if (n > 0) notes.push(`${n} doc file(s) were skipped: ${why}.`);
  };
  say(skipped.link, "symbolic links, submodules or unusual file modes");
  say(skipped.size, `larger than ${DOC_LIMITS.maxDocChars} bytes`);
  say(skipped.limit, "past the documentation count or size limit");
  say(
    skipped.encoding,
    "not plain UTF-8 text (a BOM, NUL bytes or invalid UTF-8)",
  );
  say(skipped.mismatch, "their content did not match GitHub's blob id");
  return { docs, notes };
}
