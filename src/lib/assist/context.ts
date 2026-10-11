import { clip } from "@/lib/impact-engine/match";
import type {
  ChangedFile,
  DocFile,
  ImpactCandidate,
  PullRequestSnapshot,
} from "@/lib/schemas";

// Sized so the whole prompt fits the default 8,192-token context with room for the
// reply; generateStructured also refuses prompts over the provider's input limit.
export const CONTEXT_LIMITS = {
  /** Docs up to this size are sent whole. */
  docFullChars: 6_000,
  /** Larger docs: this many lines either side of each evidence line. */
  docWindowLines: 20,
  docBudgetChars: 6_000,
  diffBudgetChars: 4_000,
  hunkChars: 2_000,
  /** Evidence excerpts in total; each is also cut to `evidenceExcerptChars`. */
  evidenceBudgetChars: 2_500,
  evidenceExcerptChars: 300,
  titleChars: 200,
} as const;

/** The JSON data object the model sees. All of it is untrusted repository data. */
export interface ModelContext {
  pullRequest: { title: string };
  candidate: {
    docPath: string;
    deterministicStatus: string;
    deterministicReason: string;
    rules: string[];
  };
  evidence: {
    index: number;
    signal: string;
    sourcePath: string;
    side?: string;
    lines?: string;
    excerpt?: string;
  }[];
  changes: {
    path: string;
    previousPath?: string;
    status: string;
    patchState: string;
    hunks: string[];
  }[];
  doc: {
    path: string;
    totalLines: number;
    complete: boolean;
    excerpts: { startLine: number; text: string }[];
  };
  notes: string[];
}

const hunkText = (h: ChangedFile["hunks"][number]) =>
  clip(
    `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`,
    CONTEXT_LIMITS.hunkChars,
  );

/** Builds a bounded context: the evidence, the hunks it points at, and the doc. */
export function buildContext(
  snapshot: PullRequestSnapshot,
  doc: DocFile,
  candidate: ImpactCandidate,
): ModelContext {
  const notes = [...candidate.missingContext];

  // Diff hunks that contain source-side evidence, within a character budget.
  const changes = new Map<ChangedFile, Set<string>>();
  let diffChars = 0;
  let diffCut = false;
  for (const e of candidate.evidence) {
    if (e.sourcePath === doc.path) continue;
    const file = snapshot.files.find(
      (f) => f.path === e.sourcePath || f.previousPath === e.sourcePath,
    );
    if (!file) continue;
    const hunks = changes.get(file) ?? new Set<string>();
    changes.set(file, hunks);
    // Evidence without a line (e.g. a route derived from the file path) gets the
    // file's hunks; line evidence gets the hunk that contains it.
    const line = e.lineRange?.start;
    const base = e.side === "base";
    const wanted =
      line === undefined
        ? file.hunks
        : file.hunks.filter((h) =>
            base
              ? line >= h.oldStart && line < h.oldStart + h.oldLines
              : line >= h.newStart && line < h.newStart + h.newLines,
          );
    for (const hunk of wanted) {
      const text = hunkText(hunk);
      if (hunks.has(text)) continue;
      if (diffChars + text.length > CONTEXT_LIMITS.diffBudgetChars) {
        diffCut = true;
        continue;
      }
      hunks.add(text);
      diffChars += text.length;
    }
  }
  if (diffCut)
    notes.push("Some diff hunks were left out to fit the context budget.");

  // The doc: whole when small, otherwise windows around its evidence lines.
  const lines = doc.content.split("\n");
  let excerpts: ModelContext["doc"]["excerpts"];
  let complete = true;
  if (doc.content.length <= CONTEXT_LIMITS.docFullChars) {
    excerpts = [{ startLine: 1, text: doc.content }];
  } else {
    complete = false;
    const w = CONTEXT_LIMITS.docWindowLines;
    const ranges = candidate.evidence
      .filter((e) => e.sourcePath === doc.path && e.lineRange)
      .map((e) => [
        Math.max(1, e.lineRange!.start - w),
        Math.min(lines.length, e.lineRange!.end + w),
      ])
      .sort((a, b) => a[0]! - b[0]!);
    if (ranges.length === 0) ranges.push([1, Math.min(lines.length, 2 * w)]);
    const merged: number[][] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0]! <= last[1]! + 1) last[1] = Math.max(last[1]!, r[1]!);
      else merged.push([...r]);
    }
    excerpts = [];
    let used = 0;
    for (const [start, end] of merged) {
      const text = clip(
        lines.slice(start! - 1, end).join("\n"),
        CONTEXT_LIMITS.docBudgetChars - used,
      );
      if (text === "") break;
      excerpts.push({ startLine: start!, text });
      used += text.length;
    }
    notes.push(
      "The doc is large: only the parts around the evidence are included. Copy `find` text from these parts only.",
    );
  }

  // Every evidence item keeps its index, signal and path (citations refer to
  // them); excerpts are cut, then dropped once the budget is spent.
  let evidenceChars = 0;
  let evidenceCut = false;
  const evidence = candidate.evidence.map((e, index) => {
    const excerpt =
      e.excerpt && clip(e.excerpt, CONTEXT_LIMITS.evidenceExcerptChars);
    const fits =
      excerpt !== undefined &&
      evidenceChars + excerpt.length <= CONTEXT_LIMITS.evidenceBudgetChars;
    if (excerpt !== undefined && !fits) evidenceCut = true;
    if (fits) evidenceChars += excerpt.length;
    return {
      index,
      signal: e.signal,
      sourcePath: e.sourcePath,
      ...(e.side ? { side: e.side } : {}),
      ...(e.lineRange
        ? { lines: `${e.lineRange.start}-${e.lineRange.end}` }
        : {}),
      ...(fits ? { excerpt } : {}),
    };
  });
  if (evidenceCut) {
    notes.push(
      "Some evidence excerpts were left out to fit the context budget.",
    );
  }

  return {
    pullRequest: { title: clip(snapshot.title, CONTEXT_LIMITS.titleChars) },
    candidate: {
      docPath: candidate.docPath,
      deterministicStatus: candidate.status,
      deterministicReason: candidate.reason,
      rules: candidate.rules,
    },
    evidence,
    changes: [...changes].map(([f, hunks]) => ({
      path: f.path,
      ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      status: f.status,
      patchState: f.patchState,
      hunks: [...hunks],
    })),
    doc: { path: doc.path, totalLines: lines.length, complete, excerpts },
    notes,
  };
}
