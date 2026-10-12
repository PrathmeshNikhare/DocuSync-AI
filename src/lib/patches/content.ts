// Reading untrusted Markdown the way a renderer would, for the patch validator and
// for model-written prose. Every pattern is linear or bounded per match start, so
// it is safe on a PR's whole diff.

/**
 * Control characters other than tab, a CR that does not end the line (CRLF docs
 * keep theirs), format characters (bidi overrides, zero-width) and line/paragraph
 * separators.
 */
export const UNSAFE_CHAR =
  /[^\P{Cc}\t\r]|\r(?!$)|[\p{Cf}\p{Zl}\p{Zp}]|[\p{Default_Ignorable_Code_Point}\u{2800}]/u;

// A raw-HTML fragment: "<" then a letter, "/", "!" or "?", up to the next ">"
// outside quotes. The alternation is decided by its first character (linear).
const HTML_FRAGMENT = /<[!/?a-z](?:"[^"]*"|'[^']*'|[^'">])*>?/gi;
const AUTOLINK = /^<(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>$/i;

/** Raw HTML (tags, comments, declarations) in `text`, excluding autolinks. */
export const htmlFragments = (text: string): string[] =>
  [...text.matchAll(HTML_FRAGMENT)]
    .map(([f]) => f)
    .filter((f) => !AUTOLINK.test(f));

const NAMED_REFERENCES: Record<string, string> = {
  colon: ":",
  sol: "/",
  bsol: "\\",
  period: ".",
  tab: "",
  newline: "",
  lpar: "(",
  rpar: ")",
  num: "#",
  quest: "?",
  commat: "@",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const codePoint = (n: number) =>
  String.fromCodePoint(
    n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? 0xfffd : n,
  );

/** Decodes numeric references (any number of leading zeros) and common named ones. */
export const decodeReferences = (text: string): string =>
  text
    .replace(/&#x0*([0-9a-f]{1,8});?/gi, (_, h: string) =>
      codePoint(parseInt(h, 16)),
    )
    .replace(/&#0*(\d{1,9});?/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (ref: string, name: string) =>
      Object.hasOwn(NAMED_REFERENCES, name.toLowerCase())
        ? NAMED_REFERENCES[name.toLowerCase()]!
        : ref,
    );

const unescapeMarkdown = (text: string) =>
  text.replace(/\\([!-/:-@[-`{-~])/g, "$1");

/** Text as a link target is read: escapes and references decoded, whitespace removed. */
export const asLinkTarget = (text: string): string =>
  decodeReferences(unescapeMarkdown(text)).replace(/[\s\p{Cc}]+/gu, "");

const LINK_SOURCES: { pattern: RegExp; bare?: boolean; email?: boolean }[] = [
  // Inline links and images: [text](target) and [text](<target>).
  { pattern: /\]\(\s*(<[^>\n]{0,2000}>|[^\s)]+)/g },
  // Reference definitions: [label]: target
  { pattern: /^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*(<[^>\n]{0,2000}>|\S+)/gm },
  // Autolinks: <scheme:...> and <user@host>.
  { pattern: /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/gi },
  { pattern: /<([^\s<>@]{1,64}@[^\s<>@]{1,255})>/g, email: true },
  // URL-bearing HTML attributes (values bounded so unclosed quotes stay linear).
  {
    pattern:
      /\b(?:href|src|srcset|poster|action|formaction|data|cite|background|xlink:href)\s*=\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\s"'>]+))/gi,
  },
  // Bare links GitHub turns into links: scheme://..., www. and e-mail addresses.
  { pattern: /\b([a-z][a-z0-9+.-]{1,31}:\/\/[^\s<>()"'`[\]]+)/gi, bare: true },
  { pattern: /(?<![\w.-])(www\.[^\s<>()"'`[\]]+)/gi, bare: true },
  {
    pattern: /(?<![\w.+-])([\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8})/g,
    bare: true,
    email: true,
  },
];

/** Every link target in `text`, raw (not yet decoded). */
export function linkTargets(text: string): string[] {
  const out: string[] = [];
  for (const { pattern, bare, email } of LINK_SOURCES) {
    for (const m of text.matchAll(pattern)) {
      let t = m.slice(1).find((g) => g !== undefined) ?? "";
      if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
      if (bare) t = t.replace(/[.,;:!?]+$/, "");
      if (email && !/^mailto:/i.test(t)) t = `mailto:${t}`;
      out.push(t);
    }
  }
  return out;
}

const BASE = "https://placeholder.invalid/";

export interface ResolvedLink {
  href: string;
  protocol: string;
  /** False for links inside the repository (relative paths, anchors). */
  external: boolean;
}

/**
 * Resolves a raw target the way a browser would from an https page. Undefined when
 * it can't be resolved or still holds an undecoded reference: treat as unknown.
 */
export function resolveLink(raw: string): ResolvedLink | undefined {
  let t = asLinkTarget(raw);
  if (/&[#a-z][a-z0-9]*;/i.test(t)) return undefined;
  if (/^www\./i.test(t)) t = `http://${t}`;
  try {
    const u = new URL(t, BASE);
    return {
      href: u.href,
      protocol: u.protocol,
      external: u.origin !== new URL(BASE).origin,
    };
  } catch {
    return undefined;
  }
}

/**
 * External links in `text`, resolved: the set a patch's new links must come from.
 * Computed once per proposal (doc plus PR diff) and stored for validating edits.
 */
export const knownLinksIn = (text: string): Set<string> =>
  new Set(
    linkTargets(text)
      .map(resolveLink)
      .filter((l) => l?.external)
      .map((l) => l!.href),
  );

export const UNSAFE_PROTOCOLS = new Set([
  "javascript:",
  "vbscript:",
  "data:",
  "file:",
]);
const SCRIPT_SCHEME = /(?:javascript|vbscript):/i;

/** Script schemes anywhere, after decoding, even outside a recognised link. */
export const hasScriptScheme = (text: string): boolean =>
  SCRIPT_SCHEME.test(asLinkTarget(text));

/**
 * Model-written prose (explanations, rationales) must be plain text: no hidden
 * characters, no HTML and no links of any kind, so it can't steer a reviewer.
 */
export function proseIssues(text: string): string[] {
  const issues: string[] = [];
  if (text.split("\n").some((l) => UNSAFE_CHAR.test(l))) {
    issues.push("TEXT_UNSAFE_CHARACTERS");
  }
  if (htmlFragments(text).length > 0) issues.push("TEXT_HTML");
  if (linkTargets(text).length > 0 || hasScriptScheme(text)) {
    issues.push("TEXT_LINK");
  }
  return issues;
}
