import { repoPathSchema } from "@/lib/schemas";
import { UNSAFE_CHAR } from "./content";

// Default policy (D-011): Markdown files at the repository root or under docs/.
// Comparison is case-insensitive so "DOCS/" or "README.MD" cannot alias past it
// on case-insensitive file systems. No .txt (requirements.txt, CMakeLists.txt are
// build inputs) and no .mdx (its imports and {expressions} run at docs build time).
const DOC_EXTENSIONS = [".md", ".markdown"];
// Files that instruct AI coding agents: a patch to one is an instruction, not docs.
const AGENT_FILES = new Set([
  "agents.md",
  "agent.md",
  "claude.md",
  "gemini.md",
]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;
const MAX_SEGMENT_BYTES = 255;

/**
 * Returns the reasons a path may not be patched (empty when allowed). This is a
 * pure string check: patches are applied in memory, never on a file system.
 */
export function docPathIssues(path: string): string[] {
  if (!repoPathSchema.safeParse(path).success) return ["PATH_INVALID"];
  // Precomposed and decomposed forms of one name must not be two different paths.
  if (path.normalize("NFC") !== path) return ["PATH_NOT_NORMALIZED"];
  // Blank-rendering characters (e.g. Hangul fillers) make two paths look identical.
  if (UNSAFE_CHAR.test(path)) return ["PATH_INVALID"];
  const issues: string[] = [];
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  if (/[%?#]/.test(path)) issues.push("PATH_URL_CHARACTERS");
  if (
    segments.some(
      (s) =>
        s.startsWith(".") ||
        s.startsWith("-") ||
        WINDOWS_RESERVED.test(s) ||
        Buffer.byteLength(s) > MAX_SEGMENT_BYTES,
    )
  ) {
    issues.push("PATH_UNSAFE_SEGMENT");
  }
  if (!DOC_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    issues.push("PATH_NOT_DOCUMENTATION");
  }
  if (AGENT_FILES.has(segments[segments.length - 1]!)) {
    issues.push("PATH_AGENT_INSTRUCTIONS");
  }
  if (segments.length > 1 && segments[0] !== "docs") {
    issues.push("PATH_OUTSIDE_ALLOWED_DIRS");
  }
  return issues;
}
