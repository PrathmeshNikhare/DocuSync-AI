import { gitBlobSha } from "./blob-sha";
import {
  UNSAFE_CHAR,
  UNSAFE_PROTOCOLS,
  hasScriptScheme,
  htmlFragments,
  linkTargets,
  resolveLink,
} from "./content";
import { applyUnifiedDiff, splitLines } from "./diff";
import { docPathIssues } from "./policy";

export const PATCH_LIMITS = {
  maxPatchChars: 8_000,
  maxHunks: 5,
  /** Added plus removed lines. */
  maxChangedLines: 40,
  /** A patch may remove at most this share of the doc's lines (but always 2). */
  maxRemovedShare: 0.3,
  /** A hunk counts as related within this many lines of doc evidence. */
  relatedWindow: 20,
} as const;

export interface PatchCheck {
  targetPath: string;
  patch: string;
  baseBlobSha: string;
  /** The doc as it is now. Its blob id must equal `baseBlobSha`. */
  doc: { path: string; content: string };
  /** 1-based doc lines that deterministic evidence points at. */
  relatedLines: readonly number[];
  /** Names from the PR (env vars, routes, ...) that make a hunk related. */
  relatedTerms: readonly string[];
  /** Resolved links a new link must match (`knownLinksIn` of the doc and PR diff). */
  knownLinks: ReadonlySet<string>;
}

export type PatchValidation =
  { ok: true; content: string } | { ok: false; issues: string[] };

const FENCE = /^ {0,3}(?:```|~~~)/;

const countFences = (content: string) =>
  splitLines(content).lines.filter((l) => FENCE.test(l)).length;

/**
 * Validates a single-file documentation patch before it is shown or stored. Used
 * for model proposals now and reviewer-edited patches later. Every failure is a
 * reason code; nothing is repaired.
 */
export function validatePatch(input: PatchCheck): PatchValidation {
  const issues = new Set<string>(docPathIssues(input.targetPath));
  if (input.doc.path !== input.targetPath) issues.add("PATCH_TARGET_MISMATCH");
  if (gitBlobSha(input.doc.content) !== input.baseBlobSha) {
    issues.add("PATCH_STALE_BASE");
  }
  if (input.patch.length > PATCH_LIMITS.maxPatchChars) {
    issues.add("PATCH_TOO_LARGE");
  }
  if (issues.size > 0) return { ok: false, issues: [...issues] };

  const applied = applyUnifiedDiff(
    input.targetPath,
    input.doc.content,
    input.patch,
  );
  if (!applied.ok) return { ok: false, issues: [applied.issue] };
  if (applied.content === input.doc.content) {
    return { ok: false, issues: ["PATCH_EMPTY"] };
  }

  const added = applied.hunks.flatMap((h) => h.added);
  const removed = applied.hunks.flatMap((h) => h.removed);
  const docLines = splitLines(input.doc.content).lines.length;
  if (
    applied.hunks.length > PATCH_LIMITS.maxHunks ||
    added.length + removed.length > PATCH_LIMITS.maxChangedLines
  ) {
    issues.add("PATCH_TOO_BROAD");
  }
  if (
    removed.length >
    Math.max(2, Math.floor(docLines * PATCH_LIMITS.maxRemovedShare))
  ) {
    issues.add("PATCH_REMOVES_TOO_MUCH");
  }

  // Heuristic: each hunk must sit near doc evidence or mention a PR name.
  const terms = input.relatedTerms.filter((t) => t.length >= 3);
  const related = (h: (typeof applied.hunks)[number]) =>
    h.changedOldLines.some((l) =>
      input.relatedLines.some(
        (r) => Math.abs(r - l) <= PATCH_LIMITS.relatedWindow,
      ),
    ) ||
    [...h.added, ...h.removed].some((l) => terms.some((t) => l.includes(t)));
  if (!applied.hunks.every(related)) issues.add("PATCH_UNRELATED_HUNK");

  for (const line of added) {
    if (UNSAFE_CHAR.test(line)) issues.add("PATCH_UNSAFE_CHARACTERS");
  }
  // Checked on all added lines together, so a tag or link split across lines is caught.
  const addedText = added.join("\n");
  // Raw HTML (tags, comments) must already exist byte-for-byte in the doc: a
  // denylist of tags and attributes misses too much.
  const docHtml = new Set(htmlFragments(input.doc.content));
  if (htmlFragments(addedText).some((f) => !docHtml.has(f))) {
    issues.add("PATCH_UNSAFE_HTML");
  }
  if (hasScriptScheme(addedText)) issues.add("PATCH_UNSAFE_LINK");
  // Every link is resolved as a browser would; an external one must exactly match
  // a link already in the doc or the PR diff.
  for (const raw of linkTargets(addedText)) {
    const link = resolveLink(raw);
    if (link && UNSAFE_PROTOCOLS.has(link.protocol)) {
      issues.add("PATCH_UNSAFE_LINK");
    } else if (!link || (link.external && !input.knownLinks.has(link.href))) {
      issues.add("PATCH_NEW_URL");
    }
  }
  if (
    countFences(input.doc.content) % 2 === 0 &&
    countFences(applied.content) % 2 === 1
  ) {
    issues.add("PATCH_BREAKS_MARKDOWN");
  }
  return issues.size > 0
    ? { ok: false, issues: [...issues] }
    : { ok: true, content: applied.content };
}
