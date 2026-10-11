import { describe, expect, it } from "vitest";
import { toTerminalSafeJson } from "./terminal-safe-json";

describe("toTerminalSafeJson", () => {
  const risky = {
    title: "fix\u009b31mred\u202Egnp.exe",
    line: "+a\u200Bb\u2028c\u2029d\u0085e",
    nested: ["\u001b[2Jclear"],
  };

  it("escapes C1, format, separator and C0 control characters", () => {
    const out = toTerminalSafeJson(risky);
    expect(out).not.toMatch(/[\u0080-\u009f\p{Cf}\u2028\u2029\u001b]/u);
    for (const code of [
      "009b",
      "202e",
      "200b",
      "2028",
      "2029",
      "0085",
      "001b",
    ]) {
      expect(out).toContain("\\u" + code);
    }
  });

  it("round-trips to the same value", () => {
    expect(JSON.parse(toTerminalSafeJson(risky))).toEqual(risky);
  });

  it("escapes astral format characters as surrogate pairs that round-trip", () => {
    // U+E0041 TAG LATIN CAPITAL LETTER A: invisible, used to smuggle hidden ASCII.
    const tag = String.fromCodePoint(0xe0041);
    const out = toTerminalSafeJson({ t: `a${tag}b` });
    expect(out).not.toContain(tag);
    expect(out).toContain("\\udb40\\udc41");
    expect(JSON.parse(out)).toEqual({ t: `a${tag}b` });
  });

  it("leaves ordinary text, including non-ASCII letters, unchanged", () => {
    const value = { a: "na\u00efve caf\u00e9 \u65e5\u672c", n: 1 };
    expect(toTerminalSafeJson(value)).toBe(JSON.stringify(value, null, 2));
  });
});
