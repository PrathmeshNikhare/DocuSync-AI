import { rawPullFileSchema } from "@/lib/github/reader";
import {
  DIFF_LIMITS,
  changedFileSchema,
  changedFileStatusSchema,
  repoPathSchema,
  type ChangedFile,
  type Hunk,
  type RejectedFile,
} from "@/lib/schemas";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses the body of a GitHub file patch (unified-diff hunks, no file headers).
 * Returns null if the text is not well-formed: content before the first header,
 * unknown line prefixes, or line counts that disagree with the hunk header.
 */
export function parseHunks(patch: string): Hunk[] | null {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldSeen = 0;
  let newSeen = 0;

  const closeCurrent = () =>
    !current || (oldSeen === current.oldLines && newSeen === current.newLines);

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (!closeCurrent()) return null;
      const [oldStart, oldLines, newStart, newLines] = [
        Number(header[1]),
        header[2] === undefined ? 1 : Number(header[2]),
        Number(header[3]),
        header[4] === undefined ? 1 : Number(header[4]),
      ];
      if (
        ![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger)
      ) {
        return null;
      }
      current = { oldStart, oldLines, newStart, newLines, lines: [] };
      hunks.push(current);
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    if (!current) {
      if (line === "") continue;
      return null;
    }
    const prefix = line[0];
    if (prefix === " ") {
      oldSeen++;
      newSeen++;
    } else if (prefix === "-") {
      oldSeen++;
    } else if (prefix === "+") {
      newSeen++;
    } else if (prefix === "\\") {
      // "\ No newline at end of file": metadata, not a counted line.
    } else if (line === "" && closeCurrent()) {
      continue; // trailing newline at the end of the patch
    } else {
      return null;
    }
    current.lines.push(line);
  }
  return closeCurrent() ? hunks : null;
}

export interface NormalizedFiles {
  files: ChangedFile[];
  rejectedFiles: RejectedFile[];
}

/**
 * Turns GitHub file entries (untrusted) into validated, bounded ChangedFiles.
 * Entries with unsafe paths are rejected by index; oversized or malformed
 * patches keep the file but drop its hunks.
 */
export function normalizeFiles(rawFiles: readonly unknown[]): NormalizedFiles {
  const files: ChangedFile[] = [];
  const rejectedFiles: RejectedFile[] = [];
  let totalPatchChars = 0;

  rawFiles.forEach((raw, index) => {
    const entry = rawPullFileSchema.safeParse(raw);
    const status = changedFileStatusSchema.safeParse(entry.data?.status);
    if (!entry.success || !status.success) {
      rejectedFiles.push({ index, reason: "invalid_entry" });
      return;
    }
    const f = entry.data;
    if (!repoPathSchema.safeParse(f.filename).success) {
      rejectedFiles.push({ index, reason: "invalid_path" });
      return;
    }
    if (
      f.previous_filename !== undefined &&
      !repoPathSchema.safeParse(f.previous_filename).success
    ) {
      rejectedFiles.push({ index, reason: "invalid_previous_path" });
      return;
    }

    let patchState: ChangedFile["patchState"] = "omitted";
    let hunks: Hunk[] = [];
    if (f.patch !== undefined) {
      if (
        f.patch.length > DIFF_LIMITS.maxPatchCharsPerFile ||
        totalPatchChars + f.patch.length > DIFF_LIMITS.maxTotalPatchChars
      ) {
        patchState = "too_large";
      } else {
        const parsed = parseHunks(f.patch);
        if (parsed && parsed.length <= DIFF_LIMITS.maxHunksPerFile) {
          patchState = "included";
          hunks = parsed;
        } else {
          patchState = parsed ? "too_large" : "malformed";
        }
      }
    }

    const build = (state: ChangedFile["patchState"], h: Hunk[]) =>
      changedFileSchema.safeParse({
        path: f.filename,
        previousPath: f.previous_filename,
        status: status.data,
        additions: f.additions,
        deletions: f.deletions,
        patchState: state,
        hunks: h,
      });
    let file = build(patchState, hunks);
    if (!file.success && patchState === "included") {
      // Patch text Postgres can't store (NUL, malformed Unicode): keep the file and
      // its path signal, drop the hunks.
      file = build("malformed", []);
    }
    if (!file.success) {
      rejectedFiles.push({ index, reason: "invalid_entry" });
      return;
    }
    if (file.data.patchState === "included") {
      totalPatchChars += f.patch?.length ?? 0;
    }
    files.push(file.data);
  });

  return { files, rejectedFiles };
}
