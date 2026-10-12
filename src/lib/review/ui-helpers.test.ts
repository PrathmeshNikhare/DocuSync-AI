import { describe, expect, it } from "vitest";
import { renderEdits } from "@/lib/patches/diff";
import { sideBySideRows } from "./diff-rows";
import { hasInvisible, segmentText } from "./visible-text";

const ch = (cp: number) => String.fromCodePoint(cp);

describe("segmentText", () => {
  it("replaces bidi, zero-width, tag and odd-space characters with markers", () => {
    const text = `a${ch(0x202e)}b${ch(0x200b)}c${ch(0xe0041)}d${ch(0xa0)}e${ch(0x1b)}f`;
    expect(segmentText(text)).toEqual([
      { kind: "text", text: "a" },
      { kind: "hidden", code: "U+202E", name: "RIGHT-TO-LEFT OVERRIDE" },
      { kind: "text", text: "b" },
      { kind: "hidden", code: "U+200B", name: "ZERO WIDTH SPACE" },
      { kind: "text", text: "c" },
      { kind: "hidden", code: "U+E0041", name: "invisible character" },
      { kind: "text", text: "d" },
      { kind: "hidden", code: "U+00A0", name: "NO-BREAK SPACE" },
      { kind: "text", text: "e" },
      { kind: "hidden", code: "U+001B", name: "invisible character" },
      { kind: "text", text: "f" },
    ]);
    expect(hasInvisible(text)).toBe(true);
  });

  it.each([0x3164, 0x115f, 0xffa0, 0x2800, 0x034f, 0xfe0f, 0xe0100, 0x180b])(
    "marks blank-rendering character U+%s",
    (cp) => {
      const text = `a${ch(cp)}b`;
      expect(hasInvisible(text)).toBe(true);
      expect(segmentText(text)[1]).toMatchObject({ kind: "hidden" });
    },
  );

  it("leaves ordinary text, tabs, newlines and other scripts alone", () => {
    const text = "Set `API_KEY`\tnow.\nПривет, 世界 — ok\r\n";
    expect(segmentText(text)).toEqual([{ kind: "text", text }]);
    expect(hasInvisible(text)).toBe(false);
  });
});

const DOC =
  Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const rows = (edits: { find: string; replace: string }[]) => {
  const r = renderEdits("docs/a.md", DOC, edits);
  if (!r.ok) throw new Error(r.issues.join());
  return sideBySideRows("docs/a.md", DOC, r.patch)!;
};

describe("sideBySideRows", () => {
  it("pairs removed and added lines and numbers both sides", () => {
    const r = rows([{ find: "line 10\n", replace: "LINE TEN\nextra\n" }]);
    expect(r[0]).toEqual({ kind: "gap", lines: 6 });
    expect(r.find((x) => x.kind === "line" && x.left?.changed)).toEqual({
      kind: "line",
      left: { n: 10, text: "line 10", changed: true },
      right: { n: 10, text: "LINE TEN", changed: true },
    });
    // The extra added line has no left counterpart.
    expect(r.find((x) => x.kind === "line" && !x.left && x.right)).toEqual({
      kind: "line",
      right: { n: 11, text: "extra", changed: true },
    });
    // After the hunk, the rest of the doc collapses to a gap; numbers stay aligned.
    expect(r.at(-1)).toEqual({ kind: "gap", lines: 17 });
    const lastContext = r.filter((x) => x.kind === "line").at(-1);
    expect(lastContext).toMatchObject({ left: { n: 13 }, right: { n: 14 } });
  });

  it("shows separate hunks with a gap between them", () => {
    const r = rows([
      { find: "line 2\n", replace: "LINE 2\n" },
      { find: "line 25\n", replace: "LINE 25\n" },
    ]);
    expect(r.filter((x) => x.kind === "gap")).toEqual([
      { kind: "gap", lines: 16 }, // lines 6-21
      { kind: "gap", lines: 2 },
    ]);
  });

  it("lays out insertion-only and deletion-only hunks", () => {
    const doc = "a\nb\nc\n";
    const head = "--- a/docs/a.md\n+++ b/docs/a.md\n";
    expect(
      sideBySideRows("docs/a.md", doc, `${head}@@ -1,0 +2,1 @@\n+new\n`),
    ).toEqual([
      { kind: "gap", lines: 1 },
      { kind: "line", right: { n: 2, text: "new", changed: true } },
      { kind: "gap", lines: 2 },
    ]);
    expect(
      sideBySideRows("docs/a.md", doc, `${head}@@ -2,1 +1,0 @@\n-b\n`),
    ).toEqual([
      { kind: "gap", lines: 1 },
      { kind: "line", left: { n: 2, text: "b", changed: true } },
      { kind: "gap", lines: 1 },
    ]);
  });

  it("returns undefined for a patch it can't read", () => {
    expect(sideBySideRows("docs/a.md", DOC, "not a patch")).toBeUndefined();
    expect(
      sideBySideRows(
        "docs/a.md",
        DOC,
        "--- a/docs/b.md\n+++ b/docs/b.md\n@@ -1 +1 @@\n-x\n+y\n",
      ),
    ).toBeUndefined();
  });
});
