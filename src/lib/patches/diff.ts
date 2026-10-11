import { parseHunks } from "@/lib/diff-analyzer/normalize";

/** A model-proposed edit: `find` must occur exactly once in the doc. */
export interface Edit {
  find: string;
  replace: string;
}

export interface Lines {
  lines: string[];
  finalNewline: boolean;
}

/** Splits on "\n" only, so a "\r" stays part of its line and round-trips. */
export function splitLines(content: string): Lines {
  if (content === "") return { lines: [], finalNewline: false };
  const lines = content.split("\n");
  const finalNewline = content.endsWith("\n");
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

const joinLines = ({ lines, finalNewline }: Lines) =>
  lines.join("\n") + (finalNewline && lines.length > 0 ? "\n" : "");

interface Located {
  start: number;
  end: number;
  replace: string;
}

function locate(
  content: string,
  edits: readonly Edit[],
): { ok: true; edits: Located[] } | { ok: false; issues: string[] } {
  const issues = new Set<string>();
  const located: Located[] = [];
  for (const e of edits) {
    if (e.find === "") {
      issues.add("EDIT_EMPTY_FIND");
      continue;
    }
    const at = content.indexOf(e.find);
    if (at === -1) issues.add("EDIT_FIND_NOT_FOUND");
    else if (content.indexOf(e.find, at + 1) !== -1)
      issues.add("EDIT_FIND_AMBIGUOUS");
    else
      located.push({ start: at, end: at + e.find.length, replace: e.replace });
  }
  located.sort((a, b) => a.start - b.start);
  if (located.some((e, i) => i > 0 && located[i - 1]!.end > e.start)) {
    issues.add("EDIT_OVERLAP");
  }
  return issues.size > 0
    ? { ok: false, issues: [...issues] }
    : { ok: true, edits: located };
}

/**
 * Keeps only edits that can be placed: not a no-op, `find` occurs exactly once,
 * and among overlapping edits the one with the longest `find` wins (earlier on ties). The
 * rest cannot change the doc unambiguously, so they are dropped and reported, and
 * the kept edits still go through full validation.
 */
export function placeableEdits(
  content: string,
  edits: readonly Edit[],
): { kept: Edit[]; dropped: string[] } {
  const dropped: string[] = [];
  const candidates: (Located & { edit: Edit; order: number })[] = [];
  edits.forEach((edit, order) => {
    // A no-op edit changes nothing but could still win an overlap below.
    if (edit.find === edit.replace) {
      dropped.push("EDIT_NO_OP");
      return;
    }
    const found = locate(content, [edit]);
    if (!found.ok) dropped.push(...found.issues);
    else candidates.push({ ...found.edits[0]!, edit, order });
  });
  const kept: typeof candidates = [];
  for (const c of [...candidates].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.order - b.order,
  )) {
    if (kept.some((k) => k.start < c.end && c.start < k.end)) {
      dropped.push("EDIT_OVERLAP");
    } else kept.push(c);
  }
  return {
    kept: kept.sort((a, b) => a.order - b.order).map((k) => k.edit),
    dropped,
  };
}

const splice = (text: string, edits: readonly Located[], offset = 0) => {
  let out = "";
  let pos = 0;
  for (const e of edits) {
    out += text.slice(pos, e.start - offset) + e.replace;
    pos = e.end - offset;
  }
  return out + text.slice(pos);
};

interface Change {
  /** 0-based index of the first replaced old line. */
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

const CONTEXT = 3;
const NO_NEWLINE = "\\ No newline at end of file";

/**
 * Applies edits and renders the result as a unified diff with a/ and b/ headers.
 * Each edit is widened to the whole lines it touches, so hunks stay as narrow as
 * the edits themselves.
 */
export function renderEdits(
  path: string,
  content: string,
  edits: readonly Edit[],
):
  | { ok: true; patch: string; content: string }
  | { ok: false; issues: string[] } {
  const found = locate(content, edits);
  if (!found.ok) return found;
  const newContent = splice(content, found.edits);
  if (newContent === content) return { ok: false, issues: ["PATCH_EMPTY"] };

  const old = splitLines(content);
  const starts = [0];
  for (let i = 0; i < old.lines.length - 1; i++) {
    starts.push(starts[i]! + old.lines[i]!.length + 1);
  }
  const lineOf = (offset: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1]! <= offset) i++;
    return i;
  };
  const lineEnd = (i: number) =>
    i + 1 < starts.length ? starts[i + 1]! : content.length;

  // Group edits that share a line, then widen a group while its replacement no
  // longer ends with the newline its last old line had (the next line joins it).
  const changes: Change[] = [];
  let i = 0;
  while (i < found.edits.length) {
    const first = lineOf(found.edits[i]!.start);
    let last = lineOf(found.edits[i]!.end - 1);
    let j = i + 1;
    for (;;) {
      while (j < found.edits.length && lineOf(found.edits[j]!.start) <= last) {
        last = Math.max(last, lineOf(found.edits[j]!.end - 1));
        j++;
      }
      const from = starts[first]!;
      const oldText = content.slice(from, lineEnd(last));
      const newText = splice(oldText, found.edits.slice(i, j), from);
      if (
        last + 1 < old.lines.length &&
        oldText.endsWith("\n") &&
        !newText.endsWith("\n")
      ) {
        last++;
        continue;
      }
      changes.push({
        oldStart: first,
        oldLines: splitLines(oldText).lines,
        newLines: splitLines(newText).lines,
      });
      break;
    }
    i = j;
  }

  const neu = splitLines(newContent);
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let delta = 0; // new line index minus old line index before the current change
  let c = 0;
  while (c < changes.length) {
    let g = c + 1;
    while (
      g < changes.length &&
      changes[g]!.oldStart -
        (changes[g - 1]!.oldStart + changes[g - 1]!.oldLines.length) <=
        2 * CONTEXT
    ) {
      g++;
    }
    const group = changes.slice(c, g);
    const hunkOld = Math.max(0, group[0]!.oldStart - CONTEXT);
    const lastChange = group[group.length - 1]!;
    const hunkOldEnd = Math.min(
      old.lines.length,
      lastChange.oldStart + lastChange.oldLines.length + CONTEXT,
    );
    const hunkNew = hunkOld + delta;
    const body: string[] = [];
    // The last line of either side gets a marker when that side has no final newline.
    const emit = (
      prefix: string,
      text: string,
      oldIdx: number,
      newIdx: number,
    ) => {
      body.push(prefix + text);
      const oldLast =
        prefix !== "+" && oldIdx === old.lines.length - 1 && !old.finalNewline;
      const newLast =
        prefix !== "-" && newIdx === neu.lines.length - 1 && !neu.finalNewline;
      if (oldLast || newLast) body.push(NO_NEWLINE);
    };
    let oldIdx = hunkOld;
    let newIdx = hunkNew;
    for (const ch of group) {
      for (; oldIdx < ch.oldStart; oldIdx++, newIdx++) {
        emit(" ", old.lines[oldIdx]!, oldIdx, newIdx);
      }
      for (const l of ch.oldLines) emit("-", l, oldIdx++, -1);
      for (const l of ch.newLines) emit("+", l, -1, newIdx++);
      delta += ch.newLines.length - ch.oldLines.length;
    }
    for (; oldIdx < hunkOldEnd; oldIdx++, newIdx++) {
      emit(" ", old.lines[oldIdx]!, oldIdx, newIdx);
    }
    const oldCount = hunkOldEnd - hunkOld;
    const newCount = newIdx - hunkNew;
    const at = (start: number, count: number) =>
      `${count === 0 ? start : start + 1},${count}`;
    out.push(
      `@@ -${at(hunkOld, oldCount)} +${at(hunkNew, newCount)} @@`,
      ...body,
    );
    c = g;
  }
  return { ok: true, patch: out.join("\n") + "\n", content: newContent };
}

export interface AppliedHunk {
  /** 1-based old line numbers of removed lines; for a pure insertion, the line before it. */
  changedOldLines: number[];
  added: string[];
  removed: string[];
}

export type ApplyResult =
  | { ok: true; content: string; hunks: AppliedHunk[] }
  | { ok: false; issue: string };

/**
 * Strictly applies a single-file unified diff: the headers must name `path`, hunks
 * must be in order, and every context and removed line must match exactly. No fuzz,
 * no offsets, no file system.
 */
export function applyUnifiedDiff(
  path: string,
  content: string,
  patch: string,
): ApplyResult {
  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (!patch.startsWith(header))
    return { ok: false, issue: "PATCH_HEADER_MISMATCH" };
  const hunks = parseHunks(patch.slice(header.length));
  if (!hunks || hunks.length === 0)
    return { ok: false, issue: "PATCH_MALFORMED" };

  const old = splitLines(content);
  const out: string[] = [];
  const applied: AppliedHunk[] = [];
  let pos = 0;
  let oldMarker = false;
  let newMarkerAt = -1;
  const fail = (issue: string): ApplyResult => ({ ok: false, issue });

  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < pos || start > old.lines.length || newMarkerAt !== -1) {
      return fail("PATCH_DOES_NOT_APPLY");
    }
    for (; pos < start; pos++) out.push(old.lines[pos]!);
    const newStart = h.newLines === 0 ? h.newStart : h.newStart - 1;
    if (newStart !== out.length) return fail("PATCH_MALFORMED");

    const hunk: AppliedHunk = { changedOldLines: [], added: [], removed: [] };
    let prev = "";
    for (const line of h.lines) {
      const tag = line[0]!;
      const text = line.slice(1);
      if (tag === "\\") {
        if (prev === "-" || prev === " ") {
          if (pos !== old.lines.length || old.finalNewline) {
            return fail("PATCH_DOES_NOT_APPLY");
          }
          oldMarker = true;
        }
        if (prev === "+" || prev === " ") newMarkerAt = out.length;
        if (prev === "") return fail("PATCH_MALFORMED");
        continue;
      }
      if (newMarkerAt !== -1) return fail("PATCH_MALFORMED");
      if (tag === "+") {
        out.push(text);
        hunk.added.push(text);
        if (hunk.changedOldLines.length === 0) hunk.changedOldLines.push(pos);
      } else {
        if (old.lines[pos] !== text) return fail("PATCH_DOES_NOT_APPLY");
        if (tag === " ") out.push(text);
        else {
          hunk.removed.push(text);
          hunk.changedOldLines.push(pos + 1);
        }
        pos++;
      }
      prev = tag;
    }
    applied.push(hunk);
  }
  // The diff produced the new file's last line if it ended at the old end of file.
  const touchesEnd = pos === old.lines.length;
  // ...and if the old file had no final newline there, the diff must say so.
  if (touchesEnd && old.lines.length > 0 && !old.finalNewline && !oldMarker) {
    return fail("PATCH_DOES_NOT_APPLY");
  }
  for (; pos < old.lines.length; pos++) out.push(old.lines[pos]!);
  if (newMarkerAt !== -1 && newMarkerAt !== out.length) {
    return fail("PATCH_MALFORMED");
  }
  const finalNewline =
    newMarkerAt !== -1 ? false : touchesEnd ? true : old.finalNewline;
  return {
    ok: true,
    content: joinLines({ lines: out, finalNewline }),
    hunks: applied,
  };
}
