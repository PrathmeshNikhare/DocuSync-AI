// An in-memory GitHub at the fetch level, for writer and publish tests. It
// implements only the endpoints the writer may call, with GitHub's status codes
// for the cases the write path depends on, and records every request it sees.
import { createHash, randomBytes } from "node:crypto";
import { gitBlobSha } from "@/lib/patches/blob-sha";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
export const randomSha = () => sha1(randomBytes(16).toString("hex"));

interface Commit {
  parent: string | undefined;
  /** path -> blob sha */
  files: Map<string, string>;
}

export interface FakePull {
  number: number;
  state: "open" | "closed";
  user: { login: string };
  head: { sha: string; ref: string; repo: { id: number } | null };
  base: { ref: string; repo: { id: number } };
}

type Fault =
  | { status: number; headers?: Record<string, string> }
  | "timeout"
  /** The request takes effect, then the response is lost. */
  | "lost"
  | { redirect: string }
  /** The request takes effect, then GitHub answers with this body instead. */
  | { respond: unknown }
  /** Runs first (e.g. someone pushes), then the request proceeds normally. */
  | { before: () => void };

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  repoId: number;
  installationId: number;
  /** Initial files at the source PR's head. */
  files: Record<string, string>;
  pullNumber: number;
  headRef: string;
  baseRef: string;
  appSlug: string;
}

export class FakeGitHub {
  readonly blobs = new Map<string, string>();
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly pulls: FakePull[] = [];
  readonly requests: string[] = [];
  readonly headSha: string;
  revoked = 0;
  tokenResponse: Record<string, unknown> | undefined;
  /** Mode for tree entries, by path (default 100644). */
  readonly modes = new Map<string, string>();
  truncateTrees = false;
  private faults: { match: (m: string, p: string) => boolean; fault: Fault }[] =
    [];
  private trees = new Map<string, { commit: string; dir: string }>();

  constructor(readonly o: FakeGitHubOptions) {
    const files = new Map<string, string>();
    for (const [path, content] of Object.entries(o.files))
      files.set(path, this.addBlob(content));
    this.headSha = randomSha();
    this.commits.set(this.headSha, { parent: undefined, files });
    this.branches.set(o.headRef, this.headSha);
    this.pulls.push({
      number: o.pullNumber,
      state: "open",
      user: { login: "author" },
      head: { sha: this.headSha, ref: o.headRef, repo: { id: o.repoId } },
      base: { ref: o.baseRef, repo: { id: o.repoId } },
    });
  }

  addBlob(content: string): string {
    const sha = gitBlobSha(content);
    this.blobs.set(sha, content);
    return sha;
  }

  /** A commit on `branch` changing files, as a person with push access could. */
  pushCommit(branch: string, changes: Record<string, string>): string {
    const parent = this.branches.get(branch)!;
    const files = new Map(this.commits.get(parent)!.files);
    for (const [p, c] of Object.entries(changes)) files.set(p, this.addBlob(c));
    const sha = randomSha();
    this.commits.set(sha, { parent, files });
    this.branches.set(branch, sha);
    return sha;
  }

  fileAt(commit: string, path: string): string | undefined {
    const blob = this.commits.get(commit)?.files.get(path);
    return blob === undefined ? undefined : this.blobs.get(blob);
  }

  get sourcePull(): FakePull {
    return this.pulls[0]!;
  }

  failNext(match: (method: string, path: string) => boolean, fault: Fault) {
    this.faults.push({ match, fault });
  }

  /** Requests that changed GitHub state. */
  get writes(): string[] {
    return this.requests.filter(
      (r) => !r.startsWith("GET ") && !r.startsWith("DELETE /installation"),
    );
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname);
    this.requests.push(`${method} ${path}${url.search}`);
    if (init?.redirect !== "manual")
      throw new Error("redirects must be manual");
    // Like fetch: an already-aborted signal rejects with its reason.
    if (init?.signal?.aborted) throw init.signal.reason;
    const i = this.faults.findIndex((f) => f.match(method, path));
    const fault = i >= 0 ? this.faults.splice(i, 1)[0]!.fault : undefined;
    if (fault === "timeout") {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }
    if (fault && typeof fault === "object" && "status" in fault)
      return json({ message: "fault" }, fault.status, fault.headers);
    if (fault && typeof fault === "object" && "redirect" in fault)
      return new Response(null, {
        status: 307,
        headers: { location: fault.redirect },
      });
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as never) : {};
    if (fault && typeof fault === "object" && "before" in fault) fault.before();
    const res = this.route(method, path, url.searchParams, body);
    if (fault === "lost") throw new TypeError("fetch failed");
    if (fault && typeof fault === "object" && "respond" in fault)
      return json(fault.respond);
    return res;
  };

  private treeSha(commit: string, dir: string) {
    const sha = sha1(`${commit}:${dir}`);
    this.trees.set(sha, { commit, dir });
    return sha;
  }

  private route(
    method: string,
    path: string,
    q: URLSearchParams,
    body: Record<string, unknown>,
  ): Response {
    const o = this.o;
    if (
      method === "POST" &&
      path === `/app/installations/${o.installationId}/access_tokens`
    ) {
      return json(
        this.tokenResponse ?? {
          token: `ghs_${randomBytes(8).toString("hex")}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { ...(body.permissions as object), metadata: "read" },
          repository_selection: "selected",
          repositories: [{ id: o.repoId, name: o.repo }],
        },
        201,
      );
    }
    if (method === "DELETE" && path === "/installation/token") {
      this.revoked++;
      return new Response(null, { status: 204 });
    }
    const r = `/repos/${o.owner}/${o.repo}`;
    if (!path.startsWith(`${r}/`)) return json({}, 404);
    const rest = path.slice(r.length + 1);
    let m: RegExpExecArray | null;

    if (method === "GET" && (m = /^pulls\/(\d+)$/.exec(rest))) {
      const p = this.pulls.find((x) => x.number === Number(m![1]));
      return p ? json(p) : json({}, 404);
    }
    if (method === "GET" && (m = /^git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      const at = this.commits.has(m[1]!)
        ? { commit: m[1]!, dir: "" }
        : this.trees.get(m[1]!);
      if (!at) return json({}, 404);
      const prefix = at.dir ? `${at.dir}/` : "";
      const entries = new Map<string, object>();
      for (const [p, sha] of this.commits.get(at.commit)!.files) {
        if (!p.startsWith(prefix)) continue;
        const [name, ...more] = p.slice(prefix.length).split("/");
        entries.set(
          name!,
          more.length
            ? {
                path: name,
                mode: "040000",
                type: "tree",
                sha: this.treeSha(at.commit, prefix + name),
              }
            : {
                path: name,
                mode: this.modes.get(p) ?? "100644",
                type: "blob",
                sha,
              },
        );
      }
      return json({
        sha: m[1],
        truncated: this.truncateTrees,
        tree: [...entries.values()],
      });
    }
    if (method === "GET" && (m = /^git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
      const content = this.blobs.get(m[1]!);
      if (content === undefined) return json({}, 404);
      return json({
        sha: m[1],
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    if (method === "GET" && rest.startsWith("git/ref/heads/")) {
      const tip = this.branches.get(rest.slice("git/ref/heads/".length));
      return tip
        ? json({
            ref: `refs/${rest.slice(8)}`,
            object: { type: "commit", sha: tip },
          })
        : json({}, 404);
    }
    if (method === "POST" && rest === "git/refs") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (this.branches.has(name)) return json({ message: "exists" }, 422);
      this.branches.set(name, String(body.sha));
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (
      method === "GET" &&
      (m = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))
    ) {
      const [base, tip] = [m[1]!, m[2]!];
      const chain: string[] = [];
      for (
        let c: string | undefined = tip;
        c && c !== base;
        c = this.commits.get(c)?.parent
      )
        chain.unshift(c);
      const before = this.commits.get(base)!.files;
      const after = this.commits.get(tip)!.files;
      const files = [...new Set([...before.keys(), ...after.keys()])]
        .filter((p) => before.get(p) !== after.get(p))
        .map((p) => ({
          filename: p,
          sha: after.get(p) ?? null,
          status: !before.has(p)
            ? "added"
            : !after.has(p)
              ? "removed"
              : "modified",
        }));
      return json({
        status: "ahead",
        ahead_by: chain.length,
        behind_by: 0,
        total_commits: chain.length,
        commits: chain.map((sha) => ({
          sha,
          parents: [{ sha: this.commits.get(sha)!.parent }],
        })),
        files,
      });
    }
    if (method === "PUT" && rest.startsWith("contents/")) {
      const file = rest.slice("contents/".length);
      const branch = String(body.branch);
      const tip = this.branches.get(branch);
      if (!tip) return json({}, 404);
      if (this.commits.get(tip)!.files.get(file) !== body.sha)
        return json({ message: "does not match" }, 409);
      const content = Buffer.from(String(body.content), "base64").toString(
        "utf8",
      );
      const commit = this.pushCommit(branch, { [file]: content });
      return json(
        {
          content: { path: file, sha: gitBlobSha(content) },
          commit: { sha: commit, parents: [{ sha: tip }] },
        },
        200,
      );
    }
    if (method === "GET" && rest === "pulls") {
      const head = q.get("head");
      return json(
        this.pulls.filter(
          (p) =>
            `${o.owner}:${p.head.ref}` === head &&
            (q.get("state") === "all" || p.state === "open"),
        ),
      );
    }
    if (method === "POST" && rest === "pulls") {
      const ref = String(body.head);
      if (this.pulls.some((p) => p.head.ref === ref && p.state === "open"))
        return json({ message: "A pull request already exists" }, 422);
      const pull: FakePull & {
        title: string;
        body: string;
        maintainer_can_modify: unknown;
      } = {
        number: 100 + this.pulls.length,
        state: "open",
        user: { login: `${o.appSlug}[bot]` },
        head: { sha: this.branches.get(ref)!, ref, repo: { id: o.repoId } },
        base: { ref: String(body.base), repo: { id: o.repoId } },
        title: String(body.title),
        body: String(body.body),
        maintainer_can_modify: body.maintainer_can_modify,
      };
      this.pulls.push(pull);
      return json(pull, 201);
    }
    return json({ message: "not implemented in fake" }, 404);
  }
}

function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
