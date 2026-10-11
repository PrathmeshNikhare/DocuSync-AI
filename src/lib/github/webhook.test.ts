import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_WEBHOOK_BODY_BYTES,
  idempotencyKey,
  parseWebhook,
  verifySignature,
} from "./webhook";
import { readBodyLimited } from "@/lib/read-body";

const SECRET = "test-webhook-secret-0123456789";
const sign = (body: string | Uint8Array, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const fixture = readFileSync(
  "fixtures/webhooks/pull_request.opened.json",
  "utf8",
);
const enc = (s: string) => new TextEncoder().encode(s);

describe("verifySignature", () => {
  it("accepts the HMAC of the exact raw body", () => {
    expect(verifySignature(enc(fixture), sign(fixture), SECRET)).toBe(true);
  });

  it.each([
    ["missing header", null],
    ["empty header", ""],
    ["sha1 prefix", sign(fixture).replace("sha256=", "sha1=")],
    ["no prefix", sign(fixture).slice("sha256=".length)],
    ["truncated digest", sign(fixture).slice(0, -2)],
    ["uppercase digest", "sha256=" + sign(fixture).slice(7).toUpperCase()],
    ["wrong secret", sign(fixture, "another-secret-0123456789")],
  ])("rejects %s", (_label, header) => {
    expect(verifySignature(enc(fixture), header, SECRET)).toBe(false);
  });

  it("rejects a body modified after signing, even by whitespace", () => {
    const signature = sign(fixture);
    expect(verifySignature(enc(fixture + " "), signature, SECRET)).toBe(false);
    expect(
      verifySignature(
        enc(fixture.replace("opened", "closed")),
        signature,
        SECRET,
      ),
    ).toBe(false);
  });
});

describe("readBodyLimited", () => {
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://x", { method: "POST", body, headers });

  it("returns the body when within the limit", async () => {
    const out = await readBodyLimited(req("hello"), 10);
    expect(new TextDecoder().decode(out!)).toBe("hello");
  });

  it("rejects by declared content-length without reading", async () => {
    expect(
      await readBodyLimited(req("hi", { "content-length": "999999999" }), 10),
    ).toBeNull();
  });

  it("rejects by actual size when content-length is absent or wrong", async () => {
    expect(await readBodyLimited(req("x".repeat(11)), 10)).toBeNull();
    expect(
      await readBodyLimited(
        req("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1)),
        MAX_WEBHOOK_BODY_BYTES,
      ),
    ).toBeNull();
  });

  /** A chunked body with no content-length, like a streamed upload. */
  const streamed = (chunks: string[], headers: Record<string, string> = {}) => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled++];
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    const request = new Request("http://x", {
      method: "POST",
      body,
      headers,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return { request, pulledChunks: () => pulled };
  };

  it("accumulates a multi-chunk stream within the limit", async () => {
    const { request } = streamed(["ab", "cd", "ef"]);
    expect(request.headers.get("content-length")).toBeNull();
    const out = await readBodyLimited(request, 6);
    expect(new TextDecoder().decode(out!)).toBe("abcdef");
  });

  it("stops reading a stream as soon as it exceeds the limit", async () => {
    const { request, pulledChunks } = streamed([
      "aaaa",
      "bbbb",
      "cccc",
      "dddd",
    ]);
    expect(await readBodyLimited(request, 6)).toBeNull();
    expect(pulledChunks()).toBeLessThanOrEqual(3); // never drains the whole stream
  });

  it("ignores an understated content-length and enforces the real size", async () => {
    const { request } = streamed(["aaaaaa", "bbbbbb"], {
      "content-length": "4",
    });
    expect(await readBodyLimited(request, 10)).toBeNull();
  });
});

describe("parseWebhook", () => {
  const payload = JSON.parse(fixture) as Record<string, unknown>;
  const pr = payload.pull_request as Record<string, unknown>;

  it("extracts the work for a supported pull_request action", () => {
    expect(parseWebhook("pull_request", payload)).toEqual({
      kind: "pull_request",
      work: {
        githubRepoId: 123456789,
        owner: "example-org",
        repo: "example-repo",
        installationId: 987654,
        prNumber: 42,
        headSha: "1".repeat(40),
        baseSha: "2".repeat(40),
      },
    });
  });

  it.each(["synchronize", "reopened", "ready_for_review"])(
    "supports %s",
    (action) => {
      expect(parseWebhook("pull_request", { ...payload, action }).kind).toBe(
        "pull_request",
      );
    },
  );

  it("ignores other events, other actions and drafts", () => {
    expect(parseWebhook("push", payload)).toEqual({
      kind: "ignored",
      reason: "unsupported_event",
    });
    expect(
      parseWebhook("pull_request", { ...payload, action: "closed" }),
    ).toEqual({
      kind: "ignored",
      reason: "unsupported_action",
    });
    expect(
      parseWebhook("pull_request", {
        ...payload,
        pull_request: { ...pr, draft: true },
      }),
    ).toEqual({ kind: "ignored", reason: "draft" });
  });

  it.each([
    ["no action", { ...payload, action: undefined }],
    ["non-object payload", "opened"],
    [
      "bad head sha",
      { ...payload, pull_request: { ...pr, head: { sha: "main" } } },
    ],
    [
      "traversal in repo name",
      { ...payload, repository: { id: 1, name: "..", owner: { login: "o" } } },
    ],
    ["missing installation", { ...payload, installation: undefined }],
    ["negative PR number", { ...payload, pull_request: { ...pr, number: -1 } }],
    [
      "PR number beyond a Postgres integer",
      { ...payload, pull_request: { ...pr, number: 2_147_483_648 } },
    ],
  ])("marks %s as invalid", (_label, p) => {
    expect(parseWebhook("pull_request", p)).toEqual({ kind: "invalid" });
  });
});

describe("idempotencyKey", () => {
  it("depends on repository, PR and head commit only", () => {
    const work = {
      githubRepoId: 1,
      owner: "o",
      repo: "r",
      installationId: 2,
      prNumber: 3,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    };
    expect(idempotencyKey(work)).toBe(`github:pr:1:3:${"a".repeat(40)}`);
    expect(
      idempotencyKey({ ...work, baseSha: "c".repeat(40), installationId: 9 }),
    ).toBe(idempotencyKey(work));
    expect(idempotencyKey({ ...work, headSha: "d".repeat(40) })).not.toBe(
      idempotencyKey(work),
    );
  });
});
