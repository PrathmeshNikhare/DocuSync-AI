import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The database call is replaced; everything else (env, pool construction, handler) is real.
const enqueueAnalysis = vi.fn();
vi.mock("@/lib/db/analyses", () => ({ enqueueAnalysis }));

const SECRET = "route-test-secret-0123456789";
const BODY = readFileSync("fixtures/webhooks/pull_request.opened.json", "utf8");

function signedRequest(secret = SECRET): Request {
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    body: BODY,
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256":
        "sha256=" + createHmac("sha256", secret).update(BODY).digest("hex"),
    },
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("DATABASE_URL", "postgres://u:p@127.0.0.1:1/db");
  vi.stubEnv("GITHUB_ALLOWED_INSTALLATION_IDS", "987654"); // fixture installation
  enqueueAnalysis.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("POST /api/webhooks/github", () => {
  it("wires the configured secret and the shared pool into the handler", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    enqueueAnalysis.mockResolvedValue({
      analysisId: randomUUID(),
      created: true,
    });
    const { POST } = await import("./route");
    const { getPool } = await import("@/lib/db/pool");

    const res = await POST(signedRequest());
    expect(res.status).toBe(202);
    expect(enqueueAnalysis).toHaveBeenCalledTimes(1);
    const [pool, work, key] = enqueueAnalysis.mock.calls[0]!;
    expect(pool).toBe(getPool());
    expect(work).toMatchObject({ prNumber: 42, owner: "example-org" });
    expect(key).toBe(`github:pr:123456789:42:${"1".repeat(40)}`);
  });

  it("rejects a request signed with a different secret", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    const { POST } = await import("./route");
    const res = await POST(signedRequest("some-other-secret-000000000"));
    expect(res.status).toBe(401);
    expect(enqueueAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    ["GITHUB_WEBHOOK_SECRET", ""],
    ["GITHUB_ALLOWED_INSTALLATION_IDS", ""],
  ])("returns 503 when %s is missing", async (name, value) => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    vi.stubEnv(name, value);
    const { POST } = await import("./route");
    const res = await POST(signedRequest());
    expect(res.status).toBe(503);
    expect(enqueueAnalysis).not.toHaveBeenCalled();
  });

  it("ignores an installation that is not on the configured allowlist", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("GITHUB_ALLOWED_INSTALLATION_IDS", "111,222");
    const { POST } = await import("./route");
    const res = await POST(signedRequest());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      reason: "installation_not_allowed",
    });
    expect(enqueueAnalysis).not.toHaveBeenCalled();
  });
});
