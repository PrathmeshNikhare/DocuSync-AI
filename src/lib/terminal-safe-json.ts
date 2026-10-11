// JSON.stringify escapes C0 controls but leaves C1 controls (U+0080-U+009F, which
// some terminals interpret as escape sequences), bidi/zero-width format characters
// (Trojan Source) and line/paragraph separators as raw characters.
const UNSAFE_FOR_TERMINAL = /[\u0080-\u009f\p{Cf}\u2028\u2029]/gu;

/**
 * Pretty JSON for printing untrusted content to a terminal. The output is still
 * valid JSON that parses to the same value; risky characters become \uXXXX escapes.
 */
export function toTerminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    UNSAFE_FOR_TERMINAL,
    // One escape per UTF-16 unit: an astral character (e.g. a Unicode tag character)
    // becomes a surrogate pair, which JSON reads back as the same character.
    (c) =>
      [...Array(c.length).keys()]
        .map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`)
        .join(""),
  );
}
