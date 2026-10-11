import type { ChangedFile, EvidenceReference } from "@/lib/schemas";
import type { SignalKind } from "./config";
import { clip } from "./match";

export type Change = "added" | "removed" | "modified";

/** Something the PR changed that documentation might mention. */
export interface Signal {
  kind: SignalKind;
  value: string;
  change: Change;
  /** File the signal came from (the old path for a renamed-away path). */
  path: string;
  /** First changed line that produced it, as bounded evidence. */
  evidence: EvidenceReference;
}

export interface ExtractedSignals {
  signals: Signal[];
  /** Env vars on unchanged context lines: they hint which docs list env vars. */
  contextEnvVars: string[];
  /** Script names on unchanged package.json lines classified as scripts. */
  contextScripts: string[];
}

export type FileClass =
  "docs" | "env" | "lockfile" | "config" | "test" | "source" | "other";

export function classifyPath(path: string): FileClass {
  const base = path.split("/").at(-1) ?? path;
  if (
    /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(base) ||
    path.startsWith("docs/")
  )
    return "docs";
  if (base.startsWith(".env")) return "env";
  if (
    /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(base)
  )
    return "lockfile";
  if (
    /(^|\/)(__tests__|tests?|fixtures?)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)
  )
    return "test";
  if (/\.(json|ya?ml|toml)$/i.test(base)) return "config";
  if (/\.[cm]?[jt]sx?$/.test(base)) return "source";
  return "other";
}

interface DiffLine {
  prefix: "+" | "-" | " ";
  /** Index of the hunk the line belongs to. */
  hunk: number;
  text: string;
  /** Line number in the base file (for "-" and " ") or head file (for "+"). */
  line: number;
}

/** Walks hunk lines with their base/head line numbers. "\ No newline" markers are skipped. */
export function diffLines(file: ChangedFile): DiffLine[] {
  const out: DiffLine[] = [];
  file.hunks.forEach((h, hunk) => {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const raw of h.lines) {
      const prefix = raw[0];
      const text = raw.slice(1);
      if (prefix === "+") out.push({ prefix, hunk, text, line: newLine++ });
      else if (prefix === "-")
        out.push({ prefix, hunk, text, line: oldLine++ });
      else if (prefix === " ") {
        out.push({ prefix, hunk, text, line: oldLine });
        oldLine++;
        newLine++;
      }
    }
  });
  return out;
}

const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
];
const ENV_FILE_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;
const EXPORT_DECL =
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_LIST = /^\s*export\s*(?:type\s*)?\{([^}]*)\}/;
const INLINE_ROUTE =
  /\.(?:get|post|put|patch|delete|all|route)\(\s*["'`](\/[^"'`\s]*)["'`]/g;
const JSON_KEY = /^\s*"([^"]+)"\s*:/;
// These three run on trimmed text and have no ambiguous trailing quantifiers:
// a line of 60,000 spaces must not cause polynomial backtracking.
const JSON_KEY_VALUE = /^"([^"]+)"\s*:\s*(.*)$/;
const JSON_BLOCK_OPEN = /^"([^"]+)"\s*:\s*\{$/;
const JSON_BLOCK_CLOSE = /^\},?$/;
/** Longer names are not identifiers anyone documents; they only cost work. */
export const MAX_SIGNAL_VALUE = 200;
/** Context-line names are hints; beyond this many they add work, not signal. */
export const MAX_CONTEXT_NAMES = 200;
// A package.json value that names a version or package source, not a command.
const VERSION_LIKE =
  /^"\s*(?:[~^<>=]*\s*v?\d|workspace:|npm:|file:|link:|git[+:]|https?:|\*|latest"|next"|canary")/;
// Top-level package.json fields: changing them is not a script change.
const PACKAGE_METADATA = new Set([
  "name",
  "version",
  "description",
  "main",
  "module",
  "types",
  "typings",
  "type",
  "license",
  "private",
  "homepage",
  "author",
  "packageManager",
  "repository",
  "bugs",
  "keywords",
  "files",
  "sideEffects",
  "browser",
  "unpkg",
  "jsdelivr",
  "funding",
]);
const YAML_KEY = /^\s*([A-Za-z_][\w.-]*)\s*:/;
const TOML_KEY = /^\s*([A-Za-z_][\w.-]*)\s*=/;

/**
 * Files whose keys are application settings that docs plausibly describe. Other
 * JSON/YAML/TOML (CI workflows, i18n, data, tool configs) contribute path
 * signals only: their keys ("run", "name", "version") collide with prose.
 */
export function isAppConfigFile(path: string): boolean {
  if (path.startsWith(".github/")) return false;
  const base = path.split("/").at(-1) ?? path;
  return (
    /(^|\/)config\//.test(path) ||
    /^(app|config|settings|default|defaults|production|development|staging|local|custom-environment-variables)\.(json|ya?ml|toml)$/i.test(
      base,
    ) ||
    /\.config\.(json|ya?ml|toml)$/i.test(base)
  );
}

/** Block a package.json line is in: a named block, or unknown (header out of view). */
export type PackageBlock = { name: string } | "unknown";

/**
 * Classifies one package.json key line. Keys inside a visible "scripts" block are
 * scripts; keys in any other visible block are ignored. When the block header is
 * out of view, a string value that is not a version and not a metadata field is
 * taken to be a script.
 */
export function packageJsonKey(
  text: string,
  block: PackageBlock,
): string | undefined {
  const t = text.trim();
  const m = JSON_KEY_VALUE.exec(t);
  if (!m?.[1] || JSON_BLOCK_OPEN.test(t)) return undefined;
  const key = m[1];
  const value = m[2] ?? "";
  if (block !== "unknown") return block.name === "scripts" ? key : undefined;
  if (!value.startsWith('"') || VERSION_LIKE.test(value)) return undefined;
  return PACKAGE_METADATA.has(key) ? undefined : key;
}

/** Route served by a Next.js App Router or Pages API file, if the path is one. */
export function routeFromPath(path: string): string | undefined {
  const app = /(?:^|\/)app\/(.+)\/route\.[cm]?[jt]sx?$/.exec(path);
  if (app?.[1]) {
    const segments = app[1].split("/").filter((s) => !/^\(.*\)$/.test(s));
    return "/" + segments.join("/");
  }
  const pages = /(?:^|\/)pages\/(api\/.+)\.[cm]?[jt]sx?$/.exec(path);
  if (pages?.[1]) return "/" + pages[1].replace(/\/index$/, "");
  return undefined;
}

function exportedNames(text: string): string[] {
  const decl = EXPORT_DECL.exec(text);
  if (decl?.[1]) return [decl[1]];
  const list = EXPORT_LIST.exec(text);
  if (!list?.[1]) return [];
  return list[1]
    .split(",")
    .map(
      (part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? "",
    )
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

function symbolsOnLine(
  file: ChangedFile,
  cls: FileClass,
  text: string,
  block: PackageBlock,
) {
  const found: { kind: SignalKind; value: string }[] = [];
  if (cls === "source" || cls === "test") {
    for (const re of ENV_PATTERNS) {
      for (const m of text.matchAll(re))
        found.push({ kind: "env_var", value: m[1]! });
    }
  }
  if (cls === "source") {
    for (const name of exportedNames(text))
      found.push({ kind: "import_export", value: name });
    for (const m of text.matchAll(INLINE_ROUTE))
      found.push({ kind: "api_route", value: m[1]! });
  }
  if (cls === "env") {
    const m = ENV_FILE_LINE.exec(text);
    if (m?.[1]) found.push({ kind: "env_var", value: m[1] });
  }
  const isPackageJson = /(^|\/)package\.json$/.test(file.path);
  if (cls === "config" && isPackageJson) {
    const script = packageJsonKey(text, block);
    if (script) found.push({ kind: "package_script", value: script });
  } else if (cls === "config" && isAppConfigFile(file.path)) {
    const re = file.path.endsWith(".json")
      ? JSON_KEY
      : /\.toml$/i.test(file.path)
        ? TOML_KEY
        : YAML_KEY;
    const m = re.exec(text);
    if (m?.[1]) found.push({ kind: "config_key", value: m[1] });
  }
  return found;
}

const evidenceFor = (
  kind: SignalKind,
  path: string,
  line?: DiffLine,
): EvidenceReference => ({
  signal: kind,
  sourcePath: path,
  ...(line && {
    lineRange: { start: line.line, end: line.line },
    side: line.prefix === "-" ? ("base" as const) : ("head" as const),
    excerpt: clip(line.text.trim(), 300),
  }),
});

/**
 * Extracts deterministic signals from a PR's changed files. Only changed lines
 * create signals; context lines are kept separately as hints. Docs, lockfiles
 * and files without parsed hunks contribute path signals only.
 */
export function extractSignals(
  files: readonly ChangedFile[],
): ExtractedSignals {
  // key -> first occurrence on a removed line and on an added line (each with its file)
  type Occurrence = { path: string; line: DiffLine };
  const seen = new Map<
    string,
    {
      kind: SignalKind;
      value: string;
      removed?: Occurrence;
      added?: Occurrence;
    }
  >();
  const contextEnv = new Set<string>();
  const contextScripts = new Set<string>();
  const signals: Signal[] = [];

  const pathSignal = (
    kind: SignalKind,
    value: string,
    change: Change,
    path: string,
  ) =>
    signals.push({
      kind,
      value,
      change,
      path,
      evidence: evidenceFor(kind, path),
    });

  for (const file of files) {
    const cls = classifyPath(file.path);
    const route = cls === "source" ? routeFromPath(file.path) : undefined;
    const prevRoute = file.previousPath
      ? routeFromPath(file.previousPath)
      : undefined;

    if (
      cls === "docs" &&
      file.status !== "renamed" &&
      file.status !== "removed"
    ) {
      // Editing a doc in place does not make docs that link to it stale.
    } else if (file.status === "renamed" && file.previousPath) {
      pathSignal(
        "path_change",
        file.previousPath,
        "removed",
        file.previousPath,
      );
      pathSignal("path_change", file.path, "added", file.path);
      if (prevRoute && prevRoute !== route)
        pathSignal("api_route", prevRoute, "removed", file.previousPath);
      if (route && prevRoute !== route)
        pathSignal("api_route", route, "added", file.path);
    } else {
      const change: Change =
        file.status === "added"
          ? "added"
          : file.status === "removed"
            ? "removed"
            : "modified";
      pathSignal("path_change", file.path, change, file.path);
      if (route) pathSignal("api_route", route, change, file.path);
    }

    if (cls === "docs" || cls === "lockfile" || file.patchState !== "included")
      continue;

    // package.json block state is per hunk: a hunk shows only nearby lines.
    let block: PackageBlock = "unknown";
    let hunk = -1;
    for (const line of diffLines(file)) {
      if (line.hunk !== hunk) {
        hunk = line.hunk;
        block = "unknown";
      }
      const trimmed = line.text.trim();
      const open = JSON_BLOCK_OPEN.exec(trimmed);
      if (open?.[1]) {
        block = { name: open[1] };
        continue;
      }
      if (JSON_BLOCK_CLOSE.test(trimmed)) {
        block = "unknown";
        continue;
      }
      for (const s of symbolsOnLine(file, cls, line.text, block)) {
        if (s.value.length > MAX_SIGNAL_VALUE) continue;
        if (line.prefix === " ") {
          if (s.kind === "env_var" && contextEnv.size < MAX_CONTEXT_NAMES)
            contextEnv.add(s.value);
          if (
            s.kind === "package_script" &&
            contextScripts.size < MAX_CONTEXT_NAMES
          )
            contextScripts.add(s.value);
          continue;
        }
        const key = `${s.kind}:${s.value}`;
        const entry = seen.get(key) ?? { ...s };
        // A removed line of a renamed file exists only at the old path.
        const occurrence = {
          path:
            line.prefix === "-" && file.previousPath
              ? file.previousPath
              : file.path,
          line,
        };
        if (line.prefix === "-") entry.removed ??= occurrence;
        else entry.added ??= occurrence;
        seen.set(key, entry);
      }
    }
  }

  for (const e of seen.values()) {
    const change: Change =
      e.removed && e.added ? "modified" : e.removed ? "removed" : "added";
    // Prefer the removed line: it is what existing docs would still describe.
    const at = (e.removed ?? e.added)!;
    signals.push({
      kind: e.kind,
      value: e.value,
      change,
      path: at.path,
      evidence: evidenceFor(e.kind, at.path, at.line),
    });
  }

  const order = (s: Signal) => `${s.kind}:${s.value}:${s.change}`;
  signals.sort((a, b) =>
    order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
  );
  return {
    signals,
    contextEnvVars: [...contextEnv].sort(),
    contextScripts: [...contextScripts].sort(),
  };
}
