import { parseHunks } from "@/lib/diff-analyzer/normalize";
import { splitLines } from "@/lib/patches/diff";

export interface DiffCell {
  /** 1-based line number on this side. */
  n: number;
  text: string;
  /** Removed (left) or added (right) by the patch. */
  changed: boolean;
}

export type DiffRow =
  | { kind: "line"; left?: DiffCell; right?: DiffCell }
  | { kind: "gap"; lines: number };

/**
 * Rows for a side-by-side view of `patch` applied to `original`: context lines on
 * both sides, removed lines paired with added ones, and unchanged stretches between
 * hunks collapsed to a count. Undefined when the patch can't be read (the caller
 * shows the raw patch instead).
 */
export function sideBySideRows(
  path: string,
  original: string,
  patch: string,
): DiffRow[] | undefined {
  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (!patch.startsWith(header)) return undefined;
  const hunks = parseHunks(patch.slice(header.length));
  if (!hunks || hunks.length === 0) return undefined;

  const total = splitLines(original).lines.length;
  const rows: DiffRow[] = [];
  let oldN = 0; // lines of the original already shown or skipped
  let newN = 0;
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < oldN) return undefined;
    if (start > oldN) {
      rows.push({ kind: "gap", lines: start - oldN });
      newN += start - oldN;
      oldN = start;
    }
    let removed: string[] = [];
    let added: string[] = [];
    const flush = () => {
      for (let i = 0; i < Math.max(removed.length, added.length); i++) {
        rows.push({
          kind: "line",
          ...(i < removed.length
            ? { left: { n: oldN + 1 + i, text: removed[i]!, changed: true } }
            : {}),
          ...(i < added.length
            ? { right: { n: newN + 1 + i, text: added[i]!, changed: true } }
            : {}),
        });
      }
      oldN += removed.length;
      newN += added.length;
      removed = [];
      added = [];
    };
    for (const line of h.lines) {
      const tag = line[0];
      if (tag === "-") removed.push(line.slice(1));
      else if (tag === "+") added.push(line.slice(1));
      else if (tag === " ") {
        flush();
        oldN++;
        newN++;
        rows.push({
          kind: "line",
          left: { n: oldN, text: line.slice(1), changed: false },
          right: { n: newN, text: line.slice(1), changed: false },
        });
      }
    }
    flush();
  }
  if (total > oldN) rows.push({ kind: "gap", lines: total - oldN });
  return rows;
}
