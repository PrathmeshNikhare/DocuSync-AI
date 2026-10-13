import { proseIssues } from "@/lib/patches/content";
import type { EvidenceReference, ModelMeta } from "@/lib/schemas";
import { segmentText } from "./visible-text";

// The docs PR is authored by the App's bot, so nothing from the source PR, the
// model or an operator may become Markdown, HTML, a link or a mention in it
// (docs/13). Untrusted values only ever appear inside code spans or fenced
// blocks; links are autolinks built from server values.

export const PR_BODY_MAX = 60_000;
const MAX_EVIDENCE = 20;

export interface PrContent {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The source PR's head ref, which is the docs PR's base. */
  headRef: string;
  targetPath: string;
  decision: "accepted" | "edited";
  /** The deciding reviewer's display name; usernames are never published. */
  reviewerName: string;
  patchSha256: string;
  headSha: string;
  baseBlobSha: string;
  evidence: readonly EvidenceReference[];
  model: ModelMeta | null;
  rationale: string;
}

const longestRun = (s: string) =>
  Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));

/**
 * Invisible and bidi characters become `[U+XXXX]` markers, as in the review UI,
 * so the bot's PR text can't read differently from its bytes.
 */
export const markHidden = (value: string): string =>
  segmentText(value)
    .map((s) => (s.kind === "text" ? s.text : `[${s.code}]`))
    .join("");

/** An inline code span that renders `value` literally (CommonMark code spans). */
export function codeSpan(value: string): string {
  const flat = markHidden(value).replace(/[\r\n]+/g, " ");
  const fence = "`".repeat(longestRun(flat) + 1);
  // A space each side is stripped again; it lets a value start or end with a backtick.
  const pad = /^[` ]|[` ]$/.test(flat) || flat === "" ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A fenced block no line of `value` can close early. */
export function codeBlock(value: string): string {
  const marked = markHidden(value);
  const fence = "`".repeat(Math.max(3, longestRun(marked) + 1));
  return `${fence}text\n${marked.replace(/\r\n?/g, "\n")}\n${fence}`;
}

/** For the title and commit message, which are not rendered as code. */
const inert = (value: string) =>
  // Marked first: the zero-width joiner added after @ and # is ours.
  markHidden(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/[@#]/g, "$&\u200d");

const encodePath = (p: string) =>
  p.split("/").map(encodeURIComponent).join("/");

export const prTitle = (c: PrContent) =>
  `docs: update ${inert(c.targetPath)} for #${c.pullNumber}`;

export const commitMessage = (c: PrContent) =>
  `docs: update ${inert(c.targetPath)} (DocuSync AI)`;

function evidenceLine(c: PrContent, e: EvidenceReference): string {
  const range = e.lineRange
    ? `:${e.lineRange.start}${e.lineRange.end > e.lineRange.start ? `-${e.lineRange.end}` : ""}`
    : "";
  let line = `- ${codeSpan(`${e.sourcePath}${range}`)} (${e.signal})`;
  // Line numbers on the base side don't exist at the head commit.
  if (e.side !== "base") {
    const anchor = e.lineRange ? `#L${e.lineRange.start}` : "";
    line += ` <https://github.com/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/blob/${c.headSha}/${encodePath(e.sourcePath)}${anchor}>`;
  } else {
    line += " (base revision)";
  }
  if (e.excerpt) line += `\n\n${indent(codeBlock(e.excerpt))}`;
  return line;
}

const indent = (block: string) =>
  block
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

export function prBody(c: PrContent & { commitSha: string }): string {
  const model = c.model
    ? `${codeSpan(c.model.modelId)} via ${codeSpan(c.model.provider)}, prompt ${codeSpan(c.model.promptVersion)}`
    : "none";
  const head = [
    `DocuSync AI proposes this documentation change for #${c.pullNumber}. A reviewer approved it in DocuSync. Review it here before merging: it is never merged automatically.`,
    [
      `- **File:** ${codeSpan(c.targetPath)}`,
      `- **Source pull request:** #${c.pullNumber}, head branch ${codeSpan(c.headRef)}`,
      `- **Approved by:** ${codeSpan(c.reviewerName)} (${c.decision === "edited" ? "edited the proposal" : "accepted the proposal"})`,
      `- **DocuSync commit:** ${codeSpan(c.commitSha)}. This pull request should contain exactly this one commit; any other commit was not reviewed in DocuSync.`,
      `- **Head commit:** ${codeSpan(c.headSha)}`,
      `- **Document blob:** ${codeSpan(c.baseBlobSha)}`,
      `- **Approved patch SHA-256:** ${codeSpan(c.patchSha256)}`,
      "- **Validation:** the approved patch passed DocuSync's patch checks again just before this commit.",
      `- **Model:** ${model}`,
    ].join("\n"),
    "### Rationale" +
      (c.decision === "edited" ? " (for the original proposal)" : "") +
      "\n\n" +
      (proseIssues(c.rationale).length === 0
        ? codeBlock(c.rationale)
        : "Withheld: the model's rationale did not pass DocuSync's plain-text checks."),
    "### Evidence",
  ];
  const tail = [
    `This pull request targets the source PR's head branch ${codeSpan(c.headRef)}. If that branch is force-pushed later, this pull request may show or reintroduce old commits.`,
    "---\nGenerated by DocuSync AI. Review before merging; it is never merged automatically.",
  ];

  // Whole blocks only, so the cap never cuts through a code block.
  const out = [...head];
  const size = (parts: string[]) => parts.join("\n\n").length;
  const items = c.evidence
    .slice(0, MAX_EVIDENCE)
    .map((e) => evidenceLine(c, e));
  let shown = 0;
  for (const item of items) {
    if (size([...out, item, "x".repeat(200), ...tail]) > PR_BODY_MAX) break;
    out.push(item);
    shown++;
  }
  if (shown === 0) out.push("No evidence items.");
  if (shown < c.evidence.length)
    out.push(`${c.evidence.length - shown} more evidence item(s) not shown.`);
  return [...out, ...tail].join("\n\n");
}
