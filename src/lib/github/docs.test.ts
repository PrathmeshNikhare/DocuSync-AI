import { describe, expect, it } from "vitest";
import { gitBlobSha } from "@/lib/patches/blob-sha";
import { fetchDocsAtHead } from "./docs";
import type { GitHubTreeReader } from "./reader";

const ref = { owner: "acme", repo: "widgets", number: 5 };
const HEAD = "a".repeat(40);

/** A reader over in-memory entries; `bytes` overrides what a blob returns. */
function reader(
  entries: {
    path: string;
    mode?: string;
    type?: string;
    content?: string;
    bytes?: Buffer;
    sha?: string;
  }[],
  truncated = false,
) {
  const blobs = new Map<string, Buffer>();
  const calls: string[] = [];
  const tree = entries.map((e) => {
    const sha = e.sha ?? gitBlobSha(e.content ?? "");
    blobs.set(sha, e.bytes ?? Buffer.from(e.content ?? "", "utf8"));
    return {
      path: e.path,
      mode: e.mode ?? "100644",
      type: e.type ?? "blob",
      sha,
      size: (e.bytes ?? Buffer.from(e.content ?? "")).byteLength,
    };
  });
  const r: GitHubTreeReader = {
    async getTree(_ref, sha) {
      calls.push(`tree ${sha}`);
      return { truncated, tree };
    },
    async getBlob(_ref, sha) {
      calls.push(`blob ${sha}`);
      return {
        encoding: "base64",
        content: blobs.get(sha)!.toString("base64"),
      };
    },
  };
  return { r, calls };
}

describe("fetchDocsAtHead", () => {
  it("reads only allowed doc paths, at the head commit, keeping GitHub's blob ids exact", async () => {
    const { r, calls } = reader([
      { path: "README.md", content: "# Hi\n" },
      { path: "docs/a.md", content: "A\n" },
      { path: "src/index.ts", content: "code" },
      { path: "AGENTS.md", content: "agent instructions" },
      { path: "docs", type: "tree", mode: "040000", sha: "b".repeat(40) },
    ]);
    const { docs, notes } = await fetchDocsAtHead(r, ref, HEAD);
    expect(docs.map((d) => d.path)).toEqual(["README.md", "docs/a.md"]);
    expect(notes).toEqual([]);
    expect(calls[0]).toBe(`tree ${HEAD}`);
    expect(calls.some((c) => c.includes(gitBlobSha("code")))).toBe(false);
  });

  it("refuses symlinks and submodules, and notes them", async () => {
    const { r, calls } = reader([
      { path: "docs/link.md", mode: "120000", content: "../secrets.md" },
      { path: "docs/sub.md", mode: "160000", type: "commit", content: "x" },
    ]);
    const { docs, notes } = await fetchDocsAtHead(r, ref, HEAD);
    expect(docs).toEqual([]);
    expect(notes).toEqual([
      expect.stringContaining("2 doc file(s) were skipped: symbolic links"),
    ]);
    expect(calls).toEqual([`tree ${HEAD}`]);
  });

  it.each([
    [
      "a BOM",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Hi\n")]),
    ],
    ["a NUL byte", Buffer.from("a\0b")],
    ["invalid UTF-8", Buffer.from([0x61, 0xff, 0x62])],
  ])("skips a doc with %s", async (_label, bytes) => {
    const { r } = reader([{ path: "docs/x.md", bytes, sha: "c".repeat(40) }]);
    const { docs, notes } = await fetchDocsAtHead(r, ref, HEAD);
    expect(docs).toEqual([]);
    expect(notes[0]).toContain("not plain UTF-8 text");
  });

  it("skips a blob whose content does not hash to its id", async () => {
    const { r } = reader([
      { path: "docs/x.md", content: "real", sha: "d".repeat(40) },
    ]);
    const { docs, notes } = await fetchDocsAtHead(r, ref, HEAD);
    expect(docs).toEqual([]);
    expect(notes[0]).toContain("did not match");
  });

  it("notes a truncated tree and skips oversized docs without fetching them", async () => {
    const big = "x".repeat(200_001);
    const { r, calls } = reader([{ path: "docs/big.md", content: big }], true);
    const { docs, notes } = await fetchDocsAtHead(r, ref, HEAD);
    expect(docs).toEqual([]);
    expect(notes[0]).toContain("truncated");
    expect(notes[1]).toContain("larger than");
    expect(calls).toEqual([`tree ${HEAD}`]);
  });

  it("rejects a malformed tree response", async () => {
    const r: GitHubTreeReader = {
      getTree: async () => ({ tree: "nope" }),
      getBlob: async () => ({}),
    };
    await expect(fetchDocsAtHead(r, ref, HEAD)).rejects.toMatchObject({
      code: "GITHUB_INVALID_RESPONSE",
    });
  });
});
