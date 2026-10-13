import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorSchema } from "@/lib/schemas";
import {
  decisionLimits,
  handleDecision,
  handleGetAnalysis,
  handleGetReview,
  type ApiDeps,
} from "./api";

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  decisionLimits.reset();
});
afterEach(() => vi.restoreAllMocks());

const SECRET_ERROR = "connect ECONNREFUSED db.internal:5432 user=docusync_app";
// A pool whose every use fails, like a database outage.
const brokenPool = {
  query: () => Promise.reject(new Error(SECRET_ERROR)),
  connect: () => Promise.reject(new Error(SECRET_ERROR)),
} as unknown as Pool;
const reviewer = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "a",
  displayName: "A",
};
const ID = "00000000-0000-4000-8000-000000000002";
const ORIGIN = "http://localhost:3000";

async function expectInternalError(res: Response) {
  expect(res.status).toBe(500);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as unknown;
  expect(apiErrorSchema.parse(body).error.code).toBe("INTERNAL_ERROR");
  expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  const logged = logSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .join("\n");
  expect(logged).toContain('"code":"INTERNAL_ERROR"');
  expect(logged).not.toContain("ECONNREFUSED");
}

describe("unexpected failures", () => {
  const deps: ApiDeps = { pool: brokenPool, reviewerFor: async () => reviewer };

  it("become a coded 500 with a request id, and the error is never returned or logged", async () => {
    await expectInternalError(
      await handleGetAnalysis(new Request(`${ORIGIN}/x`), ID, deps),
    );
    await expectInternalError(
      await handleGetReview(new Request(`${ORIGIN}/x`), ID, deps),
    );
    await expectInternalError(
      await handleDecision(
        new Request(`${ORIGIN}/x`, {
          method: "PATCH",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: '{"decision":"accepted"}',
        }),
        ID,
        deps,
      ),
    );
  });

  it("include a failing session lookup", async () => {
    const throwing: ApiDeps = {
      pool: brokenPool,
      reviewerFor: () => Promise.reject(new Error(SECRET_ERROR)),
    };
    await expectInternalError(
      await handleGetAnalysis(new Request(`${ORIGIN}/x`), ID, throwing),
    );
  });
});

describe("same-origin check", () => {
  // No session: a request that passes the origin check gets 401, a refused one 403.
  const deps: ApiDeps = {
    pool: brokenPool,
    reviewerFor: async () => undefined,
  };
  const patch = (headers: Record<string, string>) =>
    handleDecision(
      new Request(`${ORIGIN}/api/reviews/x`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      }),
      ID,
      deps,
    );

  it("accepts a same-origin fetch that sends no Origin header", async () => {
    expect((await patch({ "sec-fetch-site": "same-origin" })).status).toBe(401);
  });

  it.each([
    ["Origin: null", { origin: "null" }],
    ["another site", { origin: "https://evil.example" }],
    ["another port", { origin: "http://localhost:3001" }],
    ["no Origin and no Sec-Fetch-Site", {}],
    [
      "no Origin, same-site but not same-origin",
      { "sec-fetch-site": "same-site" },
    ],
  ])("refuses %s", async (_label, headers) => {
    expect((await patch(headers)).status).toBe(403);
  });
});

describe("per-reviewer decision limit (Phase 06)", () => {
  it("refuses a 61st decision request within a minute with 429", async () => {
    const deps = { pool: brokenPool, reviewerFor: async () => reviewer };
    const send = () =>
      handleDecision(
        new Request(`${ORIGIN}/api/reviews/${ID}`, {
          method: "PATCH",
          headers: { origin: ORIGIN, "content-type": "text/plain" },
          body: "x",
        }),
        ID,
        deps,
      );
    for (let i = 0; i < 60; i++) expect((await send()).status).toBe(415);
    const r = await send();
    expect(r.status).toBe(429);
    expect(apiErrorSchema.parse(await r.json()).error.code).toBe(
      "RATE_LIMITED",
    );
  });
});

describe("same-origin check behind a TLS proxy (APP_ORIGIN)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const send = (origin: string) =>
    handleDecision(
      // What the app sees behind the proxy: plain http, internal host.
      new Request("http://app:3000/api/reviews/x", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin },
        body: "{}",
      }),
      ID,
      { pool: brokenPool, reviewerFor: async () => undefined },
    );

  it("compares the browser's Origin with APP_ORIGIN when it is set", async () => {
    vi.stubEnv("APP_ORIGIN", "https://docs.example.com");
    expect((await send("https://docs.example.com")).status).toBe(401);
    expect((await send("http://app:3000")).status).toBe(403);
    expect((await send("https://evil.example")).status).toBe(403);
  });

  it("refuses the public origin when APP_ORIGIN is not set (the failure it fixes)", async () => {
    expect((await send("https://docs.example.com")).status).toBe(403);
  });
});

describe("an invalid APP_ORIGIN (review L2)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers 503 CONFIG_INVALID on writes, logging the code but not the value", async () => {
    vi.stubEnv("APP_ORIGIN", "https://docs.example.com/app");
    const res = await handleDecision(
      new Request(`${ORIGIN}/api/reviews/x`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      }),
      ID,
      { pool: brokenPool, reviewerFor: async () => reviewer },
    );
    expect(res.status).toBe(503);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe(
      "CONFIG_INVALID",
    );
    const logged = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(logged).toContain('"code":"CONFIG_INVALID"');
    expect(logged).not.toContain("docs.example.com");
  });

  it("accepts a default port in APP_ORIGIN", async () => {
    vi.stubEnv("APP_ORIGIN", "https://docs.example.com:443");
    const res = await handleDecision(
      new Request("http://app:3000/api/reviews/x", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://docs.example.com",
        },
        body: "{}",
      }),
      ID,
      { pool: brokenPool, reviewerFor: async () => undefined },
    );
    expect(res.status).toBe(401);
  });
});
