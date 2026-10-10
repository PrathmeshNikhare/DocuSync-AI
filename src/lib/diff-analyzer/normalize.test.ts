import { describe, expect, it } from "vitest";
import { DIFF_LIMITS } from "@/lib/schemas";
import { normalizeFiles, parseHunks } from "./normalize";

const file = (overrides: Record<string, unknown> = {}) => ({
  filename: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
  ...overrides,
});

describe("parseHunks", () => {
  it("parses headers, implicit counts and section headings", () => {
    expect(
      parseHunks(
        "@@ -1,2 +1,3 @@ function f() {\n a\n-b\n+c\n+d\n@@ -10 +11 @@\n-x\n+y",
      ),
    ).toEqual([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [" a", "-b", "+c", "+d"],
      },
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 11,
        newLines: 1,
        lines: ["-x", "+y"],
      },
    ]);
  });

  it("handles new files, deleted files and no-newline markers", () => {
    expect(
      parseHunks("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file"),
    ).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: ["+a", "+b", "\\ No newline at end of file"],
      },
    ]);
    expect(parseHunks("@@ -1,1 +0,0 @@\n-gone")?.[0]?.newLines).toBe(0);
  });

  it("tolerates a trailing newline and returns [] for an empty patch", () => {
    expect(parseHunks("@@ -1 +1 @@\n-a\n+b\n")).toHaveLength(1);
    expect(parseHunks("")).toEqual([]);
  });

  it.each([
    ["text before the first header", "hello\n@@ -1 +1 @@\n-a\n+b"],
    ["unknown line prefix", "@@ -1 +1 @@\n-a\n*b"],
    ["too few lines for the header", "@@ -1,2 +1,2 @@\n-only one"],
    ["too many lines for the header", "@@ -1 +1 @@\n-x\n+y\n+extra"],
    ["blank line inside a hunk", "@@ -1,2 +1,2 @@\n a\n\n b"],
    ["short previous hunk", "@@ -1,2 +1,2 @@\n a\n@@ -5 +5 @@\n-x\n+y"],
  ])("returns null for %s", (_label, patch) => {
    expect(parseHunks(patch)).toBeNull();
  });
});

describe("normalizeFiles", () => {
  it("keeps valid files with parsed hunks", () => {
    const { files, rejectedFiles } = normalizeFiles([
      file(),
      file({
        filename: "src/b.ts",
        status: "renamed",
        previous_filename: "src/old.ts",
      }),
    ]);
    expect(rejectedFiles).toEqual([]);
    expect(files.map((f) => [f.path, f.previousPath, f.patchState])).toEqual([
      ["src/a.ts", undefined, "included"],
      ["src/b.ts", "src/old.ts", "included"],
    ]);
  });

  it("rejects unsafe paths by index without echoing them", () => {
    const { files, rejectedFiles } = normalizeFiles([
      file({ filename: "../../etc/passwd" }),
      file({ filename: "/abs.md" }),
      file({ filename: "docs/‮gnp.md" }),
      file({ filename: "ok.md", previous_filename: "../x.md" }),
      file({ filename: "fine.md" }),
    ]);
    expect(rejectedFiles).toEqual([
      { index: 0, reason: "invalid_path" },
      { index: 1, reason: "invalid_path" },
      { index: 2, reason: "invalid_path" },
      { index: 3, reason: "invalid_previous_path" },
    ]);
    expect(files.map((f) => f.path)).toEqual(["fine.md"]);
    expect(JSON.stringify(rejectedFiles)).not.toContain("passwd");
  });

  it("rejects malformed entries and unknown statuses", () => {
    const { files, rejectedFiles } = normalizeFiles([
      null,
      { filename: "a.md" },
      file({ status: "exploded" }),
      file({ additions: -1 }),
    ]);
    expect(files).toEqual([]);
    expect(rejectedFiles.map((r) => r.reason)).toEqual([
      "invalid_entry",
      "invalid_entry",
      "invalid_entry",
      "invalid_entry",
    ]);
  });

  it.each([
    ["NUL byte", "@@ -1 +1 @@\n-a\n+b\u0000"],
    ["lone surrogate", "@@ -1 +1 @@\n-a\n+b\uD800"],
    [
      "hunk number beyond the safe-integer range",
      "@@ -99999999999999999999,1 +1,1 @@\n-a\n+b",
    ],
  ])(
    "keeps the file but drops hunks when the patch has a %s",
    (_label, patch) => {
      const { files, rejectedFiles } = normalizeFiles([file({ patch })]);
      expect(rejectedFiles).toEqual([]);
      expect(files).toEqual([
        expect.objectContaining({
          path: "src/a.ts",
          patchState: "malformed",
          hunks: [],
        }),
      ]);
    },
  );

  it("does not charge dropped patches against the total budget", () => {
    // A NUL patch near the per-file limit must not use up budget for later files.
    const body = "+" + "x".repeat(DIFF_LIMITS.maxPatchCharsPerFile - 40);
    const nulPatch = `@@ -0,0 +1 @@\n${body}\u0000`;
    const filler = Array.from(
      { length: Math.floor(DIFF_LIMITS.maxTotalPatchChars / nulPatch.length) },
      (_, i) => file({ filename: `bad${i}.ts`, patch: nulPatch }),
    );
    const { files } = normalizeFiles([
      ...filler,
      file({ filename: "last.ts" }),
    ]);
    expect(files.at(-1)).toMatchObject({
      path: "last.ts",
      patchState: "included",
    });
  });

  it("marks missing patches as omitted and bad ones as malformed", () => {
    const { files } = normalizeFiles([
      file({ filename: "logo.png", patch: undefined }),
      file({ filename: "b.ts", patch: "not a diff" }),
    ]);
    expect(files.map((f) => [f.patchState, f.hunks.length])).toEqual([
      ["omitted", 0],
      ["malformed", 0],
    ]);
  });

  it("drops oversized patches per file and once the total budget is used", () => {
    const line = "+" + "x".repeat(99);
    const patchOf = (n: number) =>
      `@@ -0,0 +1,${n} @@\n` + Array(n).fill(line).join("\n");
    const big = patchOf(Math.ceil(DIFF_LIMITS.maxPatchCharsPerFile / 100) + 1);
    expect(big.length).toBeGreaterThan(DIFF_LIMITS.maxPatchCharsPerFile);

    const nearMax = patchOf(
      Math.floor((DIFF_LIMITS.maxPatchCharsPerFile - 20) / 101),
    );
    const count =
      Math.ceil(DIFF_LIMITS.maxTotalPatchChars / nearMax.length) + 1;
    const many = Array.from({ length: count }, (_, i) =>
      file({ filename: `f${i}.ts`, patch: nearMax }),
    );

    expect(normalizeFiles([file({ patch: big })]).files[0]?.patchState).toBe(
      "too_large",
    );
    const states = normalizeFiles(many).files.map((f) => f.patchState);
    expect(states[0]).toBe("included");
    expect(states.at(-1)).toBe("too_large");
    const included = states.filter((s) => s === "included").length;
    expect(included * nearMax.length).toBeLessThanOrEqual(
      DIFF_LIMITS.maxTotalPatchChars,
    );
  });

  it("treats more hunks than the limit as too large", () => {
    const hunks = Array.from(
      { length: DIFF_LIMITS.maxHunksPerFile + 1 },
      (_, i) => `@@ -${i * 10 + 1} +${i * 10 + 1} @@\n-a\n+b`,
    ).join("\n");
    expect(normalizeFiles([file({ patch: hunks })]).files[0]?.patchState).toBe(
      "too_large",
    );
  });
});
