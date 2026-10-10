import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { apiErrorSchema } from "@/lib/schemas";
import type { EnqueueResult, PullRequestWork } from "@/lib/analysis-work";
import { idempotencyKey } from "./webhook";
import { handleGitHubWebhook, type WebhookDeps } from "./webhook-handler";

const SECRET = "test-webhook-secret-0123456789";
const BODY = readFileSync("fixtures/webhooks/pull_request.opened.json", "utf8");
const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

function webhookRequest(
  body = BODY,
  headers: Record<string, string | null> = {},
): Request {
  const all: Record<string, string | null> = {
    "content-type": "application/json",
    "x-github-event": "pull_request",
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256": sign(body),
    ...headers,
  };
  const h = new Headers();
  for (const [k, v] of Object.entries(all)) if (v !== null) h.set(k, v);
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    body,
    headers: h,
  });
}

/** In-memory stand-in for the database: one analysis per idempotency key. */
function fakeDeps(overrides: Partial<WebhookDeps> = {}) {
  const byKey = new Map<string, string>();
  const calls: { work: PullRequestWork; key: string; deliveryId: string }[] =
    [];
  const deps: WebhookDeps = {
    // 987654 is the installation id in the webhook fixture.
    getConfig: () => ({
      secret: SECRET,
      allowedInstallationIds: new Set([987654]),
    }),
    enqueue: async (work, key, deliveryId): Promise<EnqueueResult> => {
      calls.push({ work, key, deliveryId });
      const existing = byKey.get(key);
      if (existing) return { analysisId: existing, created: false };
      const id = randomUUID();
      byKey.set(key, id);
      return { analysisId: id, created: true };
    },
    ...overrides,
  };
  return { deps, calls, byKey };
}

let logSpy: MockInstance;
const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body: unknown = await res.json();
  expect(apiErrorSchema.parse(body).error.code).toBe(code);
}

describe("handleGitHubWebhook", () => {
  it("queues a valid signed pull_request delivery", async () => {
    const { deps, calls } = fakeDeps();
    const deliveryId = randomUUID();
    const res = await handleGitHubWebhook(
      webhookRequest(BODY, { "x-github-delivery": deliveryId }),
      deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; analysisId: string };
    expect(body.status).toBe("queued");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.deliveryId).toBe(deliveryId);
    expect(calls[0]!.key).toBe(idempotencyKey(calls[0]!.work));
  });

  it("returns the same analysis for a redelivery and for a new delivery of the same head", async () => {
    const { deps, byKey } = fakeDeps();
    const deliveryId = randomUUID();
    const first = await handleGitHubWebhook(
      webhookRequest(BODY, { "x-github-delivery": deliveryId }),
      deps,
    );
    const redelivered = await handleGitHubWebhook(
      webhookRequest(BODY, { "x-github-delivery": deliveryId }),
      deps,
    );
    const reopened = BODY.replace('"opened"', '"reopened"');
    const sameHead = await handleGitHubWebhook(webhookRequest(reopened), deps);

    const a = (await first.json()) as { analysisId: string };
    for (const res of [redelivered, sameHead]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "duplicate",
        analysisId: a.analysisId,
      });
    }
    expect(byKey.size).toBe(1);
  });

  it("rejects an invalid or missing signature before parsing or enqueueing", async () => {
    const { deps, calls } = fakeDeps();
    await expectError(
      await handleGitHubWebhook(
        webhookRequest(BODY, {
          "x-hub-signature-256": sign(BODY, "wrong-secret-000000000000"),
        }),
        deps,
      ),
      401,
      "INVALID_SIGNATURE",
    );
    await expectError(
      await handleGitHubWebhook(
        webhookRequest(BODY, { "x-hub-signature-256": null }),
        deps,
      ),
      401,
      "INVALID_SIGNATURE",
    );
    // A tampered body with the original signature, and invalid JSON with no valid signature.
    await expectError(
      await handleGitHubWebhook(
        webhookRequest(BODY + " ", { "x-hub-signature-256": sign(BODY) }),
        deps,
      ),
      401,
      "INVALID_SIGNATURE",
    );
    await expectError(
      await handleGitHubWebhook(
        webhookRequest("{not json", { "x-hub-signature-256": "sha256=00" }),
        deps,
      ),
      401,
      "INVALID_SIGNATURE",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects oversized payloads with 413", async () => {
    const { deps, calls } = fakeDeps();
    const huge = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
    await expectError(
      await handleGitHubWebhook(webhookRequest(huge), deps),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects signed requests with bad headers, JSON or payload", async () => {
    const { deps, calls } = fakeDeps();
    await expectError(
      await handleGitHubWebhook(
        webhookRequest(BODY, { "x-github-delivery": "not-a-uuid" }),
        deps,
      ),
      400,
      "INVALID_HEADERS",
    );
    await expectError(
      await handleGitHubWebhook(
        webhookRequest(BODY, { "x-github-event": null }),
        deps,
      ),
      400,
      "INVALID_HEADERS",
    );
    await expectError(
      await handleGitHubWebhook(webhookRequest("{not json"), deps),
      400,
      "INVALID_JSON",
    );
    const bad = BODY.replace(
      '"1111111111111111111111111111111111111111"',
      '"main"',
    );
    await expectError(
      await handleGitHubWebhook(webhookRequest(bad), deps),
      400,
      "INVALID_PAYLOAD",
    );
    expect(calls).toHaveLength(0);
  });

  it("ignores unsupported events and actions without enqueueing", async () => {
    const { deps, calls } = fakeDeps();
    const push = await handleGitHubWebhook(
      webhookRequest(BODY, { "x-github-event": "push" }),
      deps,
    );
    const closed = await handleGitHubWebhook(
      webhookRequest(BODY.replace('"opened"', '"closed"')),
      deps,
    );
    expect(push.status).toBe(202);
    expect(await push.json()).toMatchObject({
      status: "ignored",
      reason: "unsupported_event",
    });
    expect(await closed.json()).toMatchObject({
      status: "ignored",
      reason: "unsupported_action",
    });
    expect(calls).toHaveLength(0);
  });

  it("ignores a valid delivery from an installation not on the allowlist", async () => {
    const { deps, calls } = fakeDeps({
      getConfig: () => ({
        secret: SECRET,
        allowedInstallationIds: new Set([111]),
      }),
    });
    const res = await handleGitHubWebhook(webhookRequest(), deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "ignored",
      reason: "installation_not_allowed",
    });
    expect(calls).toHaveLength(0);
    expect(logged()).toContain("installation_not_allowed");
  });

  it("returns 503 when the secret or allowlist is not configured, or the allowlist is empty", async () => {
    for (const getConfig of [
      () => {
        throw new Error("Invalid server environment: GITHUB_WEBHOOK_SECRET");
      },
      () => ({ secret: SECRET, allowedInstallationIds: new Set<number>() }),
    ]) {
      const { deps, calls } = fakeDeps({ getConfig });
      await expectError(
        await handleGitHubWebhook(webhookRequest(), deps),
        503,
        "NOT_CONFIGURED",
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("returns a generic 500 and logs no details when enqueueing fails", async () => {
    const { deps } = fakeDeps({
      enqueue: async () => {
        throw new Error(
          "connect ECONNREFUSED postgres://docusync_app:hunter2@db:5432/docusync",
        );
      },
    });
    const res = await handleGitHubWebhook(webhookRequest(), deps);
    await expectError(res, 500, "INTERNAL_ERROR");
    expect(logged()).toContain("ENQUEUE_FAILED");
    expect(logged()).not.toContain("hunter2");
    expect(logged()).not.toContain("postgres://");
  });

  it("never logs the secret, signature or payload content", async () => {
    const { deps } = fakeDeps();
    const signature = sign(BODY);
    await handleGitHubWebhook(
      webhookRequest(BODY, { "x-hub-signature-256": signature }),
      deps,
    );
    await handleGitHubWebhook(
      webhookRequest(BODY, {
        "x-hub-signature-256": sign(BODY, "wrong-secret-000000000000"),
      }),
      deps,
    );
    await handleGitHubWebhook(
      webhookRequest(BODY.replace('"opened"', '"closed"')),
      deps,
    );
    const out = logged();
    expect(out).not.toBe("");
    for (const secretish of [
      SECRET,
      signature.slice(7),
      "octocat",
      "Add NEW_FLAG",
    ]) {
      expect(out).not.toContain(secretish);
    }
    for (const line of out.split("\n"))
      expect(() => JSON.parse(line)).not.toThrow();
  });
});
