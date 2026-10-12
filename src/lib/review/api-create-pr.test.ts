import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorSchema } from "@/lib/schemas";
import { handleCreatePr } from "./api";
import { createDocsPr, type PublishDeps } from "./publish";

vi.mock("./publish", async (original) => ({
  ...(await original<typeof import("./publish")>()),
  createDocsPr: vi.fn(),
}));
const publish = vi.mocked(createDocsPr);

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("GITHUB_WRITES_ENABLED", "true");
  publish.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ORIGIN = "http://localhost:3000";
const ID = "00000000-0000-4000-8000-000000000002";
const reviewer = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "a",
  displayName: "A",
};
const body = { headSha: "a".repeat(40), patchSha256: "b".repeat(64) };

function call(
  init: {
    origin?: string;
    body?: string;
    signedIn?: boolean;
    contentType?: string;
    publish?: () => PublishDeps;
  } = {},
) {
  const reviewerFor = vi.fn(async () =>
    init.signedIn === false ? undefined : reviewer,
  );
  const deps = {
    pool: {} as Pool,
    reviewerFor,
    publish: init.publish ?? (() => ({}) as PublishDeps),
  };
  const req = new Request(`${ORIGIN}/api/reviews/${ID}/create-pr`, {
    method: "POST",
    headers: {
      "content-type": init.contentType ?? "application/json",
      origin: init.origin ?? ORIGIN,
    },
    body: init.body ?? JSON.stringify(body),
  });
  return { res: handleCreatePr(req, ID, deps), reviewerFor };
}

const codeOf = async (res: Response) =>
  apiErrorSchema.parse(await res.json()).error.code;
const logged = () =>
  logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

describe("POST /api/reviews/:id/create-pr", () => {
  it("answers 503 while writes are disabled, before looking at the session", async () => {
    for (const value of ["", "false", "1", "TRUE"]) {
      vi.stubEnv("GITHUB_WRITES_ENABLED", value);
      const { res, reviewerFor } = call();
      const r = await res;
      expect(r.status).toBe(503);
      expect(await codeOf(r)).toBe("WRITES_DISABLED");
      expect(reviewerFor).not.toHaveBeenCalled();
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses cross-site, unauthenticated and oversized requests without publishing", async () => {
    expect((await call({ origin: "https://evil.example" }).res).status).toBe(
      403,
    );
    expect((await call({ signedIn: false }).res).status).toBe(401);
    expect((await call({ body: "x".repeat(2000) }).res).status).toBe(413);
    expect((await call({ body: "{" }).res).status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ["STALE_HEAD", 409],
    ["APPROVAL_MISMATCH", 409],
    ["IN_PROGRESS", 409],
    ["RETRY_TOO_SOON", 429],
    ["NOT_FOUND", 404],
    ["GITHUB_TIMEOUT", 502],
  ])(
    "maps %s to %i with its code, and logs only codes and ids",
    async (code, status) => {
      publish.mockResolvedValue({
        ok: false,
        code,
        outputId: "00000000-0000-4000-8000-0000000000ff",
      });
      const r = await call().res;
      expect(r.status).toBe(status);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await codeOf(r)).toBe(code);
      expect(logged()).toContain(`"code":"${code}"`);
      expect(logged()).toContain(`"reviewerId":"${reviewer.id}"`);
      expect(logged()).toContain(
        '"outputId":"00000000-0000-4000-8000-0000000000ff"',
      );
    },
  );

  it("returns 201 with the new PR, and 200 when it already existed", async () => {
    publish.mockResolvedValueOnce({
      ok: true,
      outputId: ID,
      prNumber: 9,
      prUrl: "https://github.com/a/b/pull/9",
      created: true,
    });
    const created = await call().res;
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      pullRequest: {
        number: 9,
        url: "https://github.com/a/b/pull/9",
        created: true,
      },
    });
    publish.mockResolvedValueOnce({
      ok: true,
      outputId: ID,
      prNumber: 9,
      prUrl: "https://github.com/a/b/pull/9",
      created: false,
    });
    expect((await call().res).status).toBe(200);
    expect(publish).toHaveBeenCalledWith({}, reviewer.id, ID, body);
  });

  it("turns an unexpected failure into a coded 500 without its message", async () => {
    publish.mockRejectedValue(
      new Error("private key -----BEGIN RSA PRIVATE KEY----- ghs_secret"),
    );
    const r = await call().res;
    expect(r.status).toBe(500);
    const text = JSON.stringify(await r.json()) + logged();
    expect(text).not.toMatch(/PRIVATE KEY|ghs_secret/);
  });

  it("refuses a body that isn't JSON with 415", async () => {
    const r = await call({ contentType: "text/plain" }).res;
    expect(r.status).toBe(415);
    expect(await codeOf(r)).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(publish).not.toHaveBeenCalled();
  });

  it("answers 503 for missing write configuration without publishing or leaking it", async () => {
    const r = await call({
      publish: () => {
        throw new Error("Invalid server environment: GITHUB_APP_PRIVATE_KEY");
      },
    }).res;
    expect(r.status).toBe(503);
    expect(await codeOf(r)).toBe("WRITES_MISCONFIGURED");
    expect(publish).not.toHaveBeenCalled();
    expect(logged()).not.toContain("PRIVATE_KEY");
  });

  it("tells a retryable GitHub failure apart from a terminal one", async () => {
    publish.mockResolvedValueOnce({ ok: false, code: "GITHUB_TIMEOUT" });
    const retryable = await call().res;
    publish.mockResolvedValueOnce({
      ok: false,
      code: "GITHUB_INVALID_RESPONSE",
    });
    const terminal = await call().res;
    expect([retryable.status, terminal.status]).toEqual([502, 502]);
    const message = async (res: Response) =>
      apiErrorSchema.parse(await res.json()).error.message;
    expect(await message(retryable)).toMatch(/try again later/);
    expect(await message(terminal)).toMatch(/can't be published/);
  });
});
