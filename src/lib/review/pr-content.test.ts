import { describe, expect, it } from "vitest";
import {
  PR_BODY_MAX,
  codeBlock,
  codeSpan,
  commitMessage,
  prBody,
  prTitle,
  type PrContent,
} from "./pr-content";

/** CommonMark's code span rule: the content between equal backtick runs. */
function decodeSpan(span: string): string | undefined {
  const open = /^`+/.exec(span)?.[0];
  if (!open) return undefined;
  const rest = span.slice(open.length);
  const closeAt = rest.search(new RegExp(`(?<!\`)${open}(?!\`)`));
  if (closeAt !== rest.length - open.length) return undefined; // closed early
  const inner = rest.slice(0, closeAt);
  return /^ [\s\S]* $/.test(inner) && /[^ ]/.test(inner)
    ? inner.slice(1, -1)
    : inner;
}

/** Removes every fenced block and code span, leaving what GitHub would interpret. */
function interpreted(markdown: string): string {
  let s = markdown.replace(/^( *)(`{3,})text\n[\s\S]*?\n\1\2$/gm, "[block]");
  s = s.replace(/(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g, "[code]");
  return s;
}

const hostile = [
  "src/a](https://evil.example) x.ts",
  "src/<a href=https://evil.example>x</a>.ts",
  "``tick`` @org/team #1 owner/repo#2",
  "`starts and ends`",
  " spaced ",
  "line\nbreak <script>alert(1)</script>",
];

const base: PrContent & { commitSha: string } = {
  owner: "acme",
  repo: "widgets",
  pullNumber: 5,
  headRef: "feature/x",
  targetPath: "docs/config.md",
  decision: "accepted",
  reviewerName: "Alice Example",
  patchSha256: "a".repeat(64),
  headSha: "b".repeat(40),
  baseBlobSha: "c".repeat(40),
  evidence: [],
  model: { provider: "ollama", modelId: "llama3.2:3b", promptVersion: "p1" },
  rationale: "Renamed the variable.",
  commitSha: "d".repeat(40),
};

describe("codeSpan and codeBlock", () => {
  it.each(hostile)("render %j literally", (value) => {
    expect(decodeSpan(codeSpan(value))).toBe(value.replace(/[\r\n]+/g, " "));
    const block = codeBlock(value);
    const fence = /^`+/.exec(block)![0];
    // No line inside is a closing fence of this length or longer.
    const inner = block.split("\n").slice(1, -1);
    expect(inner.some((l) => new RegExp(`^ {0,3}${fence}`).test(l))).toBe(
      false,
    );
  });
});

describe("prBody", () => {
  it("keeps every untrusted value inside code, with links only as server-built autolinks", () => {
    const body = prBody({
      ...base,
      headRef: hostile[2]!,
      reviewerName: hostile[1]!,
      targetPath: hostile[0]!,
      model: {
        provider: hostile[3]!,
        modelId: hostile[2]!,
        promptVersion: "p",
      },
      rationale: hostile[2]!,
      evidence: hostile.slice(0, 3).map((p, i) => ({
        signal: "explicit_reference" as const,
        sourcePath: p.replace(/\n/g, ""),
        lineRange: { start: i + 1, end: i + 2 },
        excerpt: hostile[5]!,
      })),
    });
    const links = [...interpreted(body).matchAll(/<(https:[^>]*)>/g)].map(
      (m) => m[1]!,
    );
    expect(links.length).toBe(3);
    for (const l of links) {
      // Autolinks to github.com only; untrusted text in them is percent-encoded path.
      expect(l).toMatch(
        /^https:\/\/github\.com\/acme\/widgets\/blob\/b{40}\/[^\s<>]+#L\d+$/,
      );
    }
    const left = interpreted(body).replace(/<https:[^>]*>/g, "[link]");
    for (const bad of ["evil", "<", "](", "@org", "#2", "owner/repo"])
      expect(left).not.toContain(bad);
    // The only interpreted reference is the source PR.
    expect(left.match(/#\d+/g)?.every((m) => m === "#5")).toBe(true);
  });

  it("withholds a rationale that fails the prose checks", () => {
    const body = prBody({
      ...base,
      rationale: "See [docs](https://evil.example).",
    });
    expect(body).not.toContain("evil");
    expect(body).toContain("Withheld");
  });

  it("names the reviewer by display name and says it is never merged automatically", () => {
    const body = prBody(base);
    expect(body).toContain("`Alice Example`");
    expect(body).toContain("never merged automatically");
    expect(body).toContain("force-pushed");
    // Names our one commit, so extra commits on the branch stand out.
    expect(body).toContain(
      "`" +
        "d".repeat(40) +
        "`. This pull request should contain exactly this one commit",
    );
  });

  it("stays under the cap with whole blocks only", () => {
    const big = "`".repeat(5) + "x".repeat(490);
    const body = prBody({
      ...base,
      evidence: Array.from({ length: 300 }, (_, i) => ({
        signal: "explicit_reference" as const,
        sourcePath: `src/f${i}.ts`,
        excerpt: big,
      })),
    });
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).toContain("more evidence item(s) not shown");
    expect(interpreted(body)).not.toContain("x".repeat(10));
    expect(body.trimEnd().endsWith("never merged automatically.")).toBe(true);
  });
});

describe("title and commit message", () => {
  it("neutralize mentions and references", () => {
    const c = { ...base, targetPath: "docs/@team-#1.md" };
    expect(prTitle(c)).not.toMatch(/@team|#1\b/);
    expect(commitMessage(c)).not.toMatch(/@team|#1\b/);
    expect(prTitle(base)).toBe("docs: update docs/config.md for #5");
  });
});
