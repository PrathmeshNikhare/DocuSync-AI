// Untrusted text (docs, patches, model output) is shown as plain text with every
// invisible or look-alike-space character replaced by a visible marker, so a bidi
// override or zero-width character can't hide or reorder what a reviewer reads.

// Controls other than tab, newline and CR; format characters (bidi, zero-width,
// tag characters); line/paragraph separators; spaces other than U+0020.
// Plus default-ignorable code points (Hangul fillers, variation selectors, the
// combining grapheme joiner) and the braille blank, which also render as nothing.
const INVISIBLE =
  /[^\P{Cc}\t\n\r]|[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Zs} ]|[\p{Default_Ignorable_Code_Point}\u{2800}]/u;
const INVISIBLE_GLOBAL = new RegExp(INVISIBLE.source, "gu");

const NAMES: Record<number, string> = {
  0x00a0: "NO-BREAK SPACE",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE",
};

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "hidden"; code: string; name: string };

const code = (cp: number) =>
  `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

export const hasInvisible = (text: string) => INVISIBLE.test(text);

export function segmentText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INVISIBLE_GLOBAL)) {
    if (m.index > last)
      out.push({ kind: "text", text: text.slice(last, m.index) });
    const cp = m[0].codePointAt(0)!;
    out.push({
      kind: "hidden",
      code: code(cp),
      name: NAMES[cp] ?? "invisible character",
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
