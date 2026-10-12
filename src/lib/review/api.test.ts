import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorSchema } from "@/lib/schemas";
import {
  handleDecision,
  handleGetAnalysis,
  handleGetReview,
  type ApiDeps,
} from "./api";

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
