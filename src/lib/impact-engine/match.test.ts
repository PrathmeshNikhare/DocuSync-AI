import { describe, expect, it } from "vitest";
import {
  clip,
  findPathMentions,
  findRouteMentions,
  findSymbolMentions,
  resolveDocLink,
  routeMatcher,
} from "./match";

describe("clip", () => {
  it("never splits a surrogate pair", () => {
    const s = "x".repeat(299) + "\u{1F600}tail";
    const out = clip(s, 300);
    expect(out).toBe("x".repeat(299));
    expect(out.isWellFormed()).toBe(true);
    expect(clip("short", 300)).toBe("short");
  });
});

describe("findSymbolMentions", () => {
  it("matches whole words only, case-sensitively, with 1-based line numbers", () => {
    const doc =
      "intro\nSet `API_TOKEN` here.\nAPI_TOKEN_V2 and MY_API_TOKEN differ\napi_token is lowercase";
    expect(findSymbolMentions(doc, "API_TOKEN")).toEqual([
      { line: 2, excerpt: "Set `API_TOKEN` here." },
    ]);
  });

  it("treats script punctuation as part of the name when asked", () => {
    const doc = "Run `npm run lint:fix`.\nOr run `npm run fix`.";
    expect(findSymbolMentions(doc, "fix").map((m) => m.line)).toEqual([1, 2]);
    expect(findSymbolMentions(doc, "fix", ":-").map((m) => m.line)).toEqual([
      2,
    ]);
    expect(
      findSymbolMentions(doc, "lint:fix", ":-").map((m) => m.line),
    ).toEqual([1]);
  });

  it("escapes regex characters in the symbol", () => {
    expect(findSymbolMentions("cost is $total", "$total")).toHaveLength(1);
    expect(findSymbolMentions("a.b and axb", "a.b")).toHaveLength(1);
  });

  it("returns at most three mentions with bounded excerpts", () => {
    const long = "  FOO " + "x".repeat(1000);
    const doc = Array(10).fill(long).join("\n");
    const found = findSymbolMentions(doc, "FOO");
    expect(found).toHaveLength(3);
    expect(found[0]!.excerpt.length).toBe(300);
    expect(found[0]!.excerpt.startsWith("FOO ")).toBe(true);
  });
});

describe("findRouteMentions", () => {
  it("does not treat the root route as matchable", () => {
    expect(routeMatcher("/")).toBeUndefined();
    expect(findRouteMentions("Visit https://example.com/ today", "/")).toEqual(
      [],
    );
  });

  it("does not match the path part of an external URL", () => {
    expect(findRouteMentions("See https://example.com/docs", "/docs")).toEqual(
      [],
    );
    expect(findRouteMentions("Open /docs locally", "/docs")).toHaveLength(1);
  });

  it.each([
    ["/api/users/[id]", "GET /api/users/{id}"],
    ["/api/users/[id]", "GET /api/users/:id"],
    ["/api/users/:id", "GET /api/users/[id]"],
    ["/blog/[...slug]", "GET /blog/{slug}"],
  ])("matches dynamic route %s in %j", (route, doc) => {
    expect(findRouteMentions(doc, route)).toHaveLength(1);
  });

  it("matches many dynamic segments in linear time (no exponential backtracking)", () => {
    const route = "/" + Array(30).fill("[a]").join("/") + "/zz";
    const hostile = "/" + Array(30).fill("[[...a]]").join("/") + "/zy";
    const start = performance.now();
    expect(findRouteMentions(hostile, route)).toEqual([]);
    // The ambiguous pattern needed ~8.8 s for 16 segments; 30 would never finish.
    expect(performance.now() - start).toBeLessThan(200);
    expect(
      findRouteMentions("/" + Array(30).fill("{a}").join("/") + "/zz", route),
    ).toHaveLength(1);
  });

  it("does not let a dynamic segment match a static one", () => {
    expect(findRouteMentions("GET /api/users/me", "/api/users/[id]")).toEqual(
      [],
    );
  });

  it("matches the route but not longer routes or other prefixes", () => {
    const doc =
      "POST /api/users\nGET /api/users-v2\nsee /v1/api/users\nGET /api/users/{id}";
    expect(findRouteMentions(doc, "/api/users").map((m) => m.line)).toEqual([
      1, 4,
    ]);
  });
});

describe("excerpts", () => {
  it("keep the match visible on long lines", () => {
    const line = "x".repeat(1000) + " TARGET_NAME " + "y".repeat(1000);
    const [m] = findSymbolMentions(line, "TARGET_NAME");
    expect(m!.excerpt.length).toBeLessThanOrEqual(300);
    expect(m!.excerpt).toContain("TARGET_NAME");
  });

  it("quote short lines exactly (trimmed)", () => {
    expect(findSymbolMentions("   Set FOO here.  ", "FOO")[0]!.excerpt).toBe(
      "Set FOO here.",
    );
  });
});

describe("resolveDocLink", () => {
  it.each([
    ["docs/arch.md", "../src/cli.ts", "src/cli.ts"],
    ["docs/arch.md", "./api.md#auth", "docs/api.md"],
    ["docs/arch.md", "/src/cli.ts", "src/cli.ts"],
    ["README.md", "src/cli.ts?raw=1", "src/cli.ts"],
    ["docs/arch.md", "https://example.com/src/cli.ts", undefined],
    ["docs/arch.md", "mailto:a@b.c", undefined],
    ["docs/arch.md", "#section", undefined],
    ["docs/arch.md", "../../outside.md", undefined],
  ])("%s + %s -> %s", (doc, target, expected) => {
    expect(resolveDocLink(doc, target)).toBe(expected);
  });
});

describe("findPathMentions", () => {
  it("stays linear on hostile link syntax", () => {
    const hostile = "](".repeat(100_000); // 200,000 characters, no closing ")"
    const start = performance.now();
    expect(findPathMentions("docs/a.md", hostile, "src/x.ts")).toEqual([]);
    // Quadratic matching took ~4.5 s on an 80,000-character line before the fix.
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("finds relative links and literal paths, ignoring longer paths and URLs", () => {
    const doc = [
      "The [CLI](../src/cli.ts) entry point.",
      "Also named src/cli.ts in prose.",
      "Not src/cli.tsx or lib/src/cli.ts.",
      "Not [remote](https://github.com/o/r/blob/main/src/cli.ts).",
    ].join("\n");
    expect(
      findPathMentions("docs/arch.md", doc, "src/cli.ts").map((m) => m.line),
    ).toEqual([1, 2]);
  });
});
