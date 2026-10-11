import path from "node:path";

/** A doc line that mentions something, with a bounded excerpt. */
export interface Mention {
  line: number;
  excerpt: string;
}

/**
 * Tests one doc line (0-based index `i`) and returns the column of the match, or
 * -1. Matchers are compiled once per signal, then reused for every doc.
 */
export type LineTest = (line: string, i: number) => number;

const MAX_MENTIONS = 3;
const EXCERPT = 300;
export const escapeRegExp = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * Cuts `s` to at most `max` UTF-16 units without leaving half of a surrogate
 * pair (which would make the text malformed and fail schema validation).
 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The quoted doc text for a match: the trimmed line when it fits, otherwise a
 * window that starts shortly before the match so the match is always visible.
 * Text is quoted as-is (never rewritten); only its length is bounded.
 */
export function excerptAt(line: string, column: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= EXCERPT) return trimmed;
  const offset = line.length - line.trimStart().length;
  let start = Math.max(0, column - offset - 100);
  if (/[\uDC00-\uDFFF]/.test(trimmed[start] ?? "")) start++; // don't start mid-pair
  return clip(trimmed.slice(start), EXCERPT);
}

/** First mentions (1-based line numbers) of a pre-split doc. */
export function scanLines(lines: readonly string[], test: LineTest): Mention[] {
  const out: Mention[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_MENTIONS; i++) {
    const line = lines[i]!;
    const column = test(line, i);
    if (column >= 0)
      out.push({ line: i + 1, excerpt: excerptAt(line, column) });
  }
  return out;
}

const matchColumn = (re: RegExp) => (line: string) =>
  re.exec(line)?.index ?? -1;

/**
 * Whole-word mention of an identifier, env var, script or key (case-sensitive).
 * `extraWordChars` widens the word: npm script names contain ":" and "-", so
 * `fix` must not match inside `lint:fix`.
 */
export function symbolMatcher(symbol: string, extraWordChars = ""): LineTest {
  const w = `\\w$${escapeRegExp(extraWordChars)}`;
  return matchColumn(
    new RegExp(`(?<![${w}])${escapeRegExp(symbol)}(?![${w}])`),
  );
}

// Route parameters are written differently in code and docs: [id], [...slug],
// [[...slug]], {id}, :id. Any of them matches any other. The alternatives are
// mutually exclusive (no class contains "[", "]", "{", "}" or "."), so a doc
// segment can match in only one way: no exponential backtracking.
const DYNAMIC_SEGMENT =
  /^(?:\[\[\.\.\.[^[\]/\s.]+\]\]|\[(?:\.\.\.)?[^[\]/\s.]+\]|\{[^{}/\s]+\}|:[A-Za-z_]\w*)$/;
const ANY_DYNAMIC = String.raw`(?:\[\[\.\.\.[^[\]/\s.]+\]\]|\[(?:\.\.\.)?[^[\]/\s.]+\]|\{[^{}/\s]+\}|:[A-Za-z_]\w*)`;

/**
 * Mention of an HTTP route such as `/api/users` (not `/api/users-v2`, and not
 * the path part of an external URL). The root route `/` is not matchable: it
 * would match every URL and path in a doc.
 */
export function routeMatcher(route: string): LineTest | undefined {
  const segments = route.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  const body = segments
    .map((s) => (DYNAMIC_SEGMENT.test(s) ? ANY_DYNAMIC : escapeRegExp(s)))
    .join("/");
  return matchColumn(new RegExp(`(?<![\\w/.:-])/${body}(?![\\w-])`));
}

// Link targets exclude brackets and parentheses, which keeps matching linear
// on hostile lines such as "](" repeated thousands of times.
const MD_LINK = /\]\(\s*<?([^()[\]\s<>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Repository path a Markdown link in `docPath` points to, or undefined for URLs/anchors. */
export function resolveDocLink(
  docPath: string,
  target: string,
): string | undefined {
  const bare = target.split(/[?#]/)[0] ?? "";
  if (bare === "" || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return undefined;
  const joined = bare.startsWith("/")
    ? bare.slice(1)
    : path.posix.join(path.posix.dirname(docPath), bare);
  const normalized = path.posix.normalize(joined);
  return normalized.startsWith("../") ? undefined : normalized;
}

/**
 * Every repository path a doc links to, with the 0-based line and column of the
 * first link to it on each line. Built once per doc, then shared by all path signals.
 */
export function indexDocLinks(
  docPath: string,
  lines: readonly string[],
): Map<string, Map<number, number>> {
  const index = new Map<string, Map<number, number>>();
  lines.forEach((line, i) => {
    if (!line.includes("](")) return;
    for (const m of line.matchAll(MD_LINK)) {
      const target = resolveDocLink(docPath, m[1]!);
      if (!target) continue;
      const atLine = index.get(target) ?? new Map<number, number>();
      if (!atLine.has(i)) atLine.set(i, m.index);
      index.set(target, atLine);
    }
  });
  return index;
}

/** Lines of a doc that link to `targetPath` (via its link index) or name it literally. */
export function pathMatcher(
  targetPath: string,
): (links: Map<string, Map<number, number>>) => LineTest {
  const literal = matchColumn(
    new RegExp(`(?<![\\w./-])${escapeRegExp(targetPath)}(?![\\w/-])`),
  );
  return (links) => {
    const linked = links.get(targetPath);
    return (line, i) => {
      const column = literal(line);
      return column >= 0 ? column : (linked?.get(i) ?? -1);
    };
  };
}

// Convenience wrappers over a whole doc (used by tests and simple callers).
export const findSymbolMentions = (
  content: string,
  symbol: string,
  extra = "",
) => scanLines(content.split("\n"), symbolMatcher(symbol, extra));
export const findRouteMentions = (content: string, route: string) => {
  const test = routeMatcher(route);
  return test ? scanLines(content.split("\n"), test) : [];
};
export const findPathMentions = (
  docPath: string,
  content: string,
  targetPath: string,
) => {
  const lines = content.split("\n");
  return scanLines(
    lines,
    pathMatcher(targetPath)(indexDocLinks(docPath, lines)),
  );
};
