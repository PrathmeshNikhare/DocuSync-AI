import { randomUUID } from "node:crypto";
import type { EnqueueResult, PullRequestWork } from "@/lib/analysis-work";
import { logEvent } from "@/lib/log";
import { readBodyLimited } from "@/lib/read-body";
import type { ApiError } from "@/lib/schemas";
import {
  MAX_WEBHOOK_BODY_BYTES,
  idempotencyKey,
  parseWebhook,
  verifySignature,
  webhookHeadersSchema,
} from "./webhook";

export interface WebhookConfig {
  secret: string;
  /** Only these GitHub App installations may queue work. Never empty. */
  allowedInstallationIds: ReadonlySet<number>;
}

export interface WebhookDeps {
  /** Throws if the secret or the installation allowlist is not configured. */
  getConfig: () => WebhookConfig;
  enqueue: (
    work: PullRequestWork,
    key: string,
    deliveryId: string,
  ) => Promise<EnqueueResult>;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  const body: ApiError = { error: { code, message, requestId } };
  return Response.json(body, { status });
}

/**
 * Verifies, validates and records a GitHub webhook delivery. It only queues
 * analysis work; it never fetches repository content or runs model calls inline.
 */
export async function handleGitHubWebhook(
  request: Request,
  deps: WebhookDeps,
): Promise<Response> {
  const requestId = randomUUID();
  const fail = (status: number, code: string, message: string) => {
    logEvent("github_webhook", { requestId, outcome: "rejected", code });
    return errorResponse(status, code, message, requestId);
  };

  let config: WebhookConfig;
  try {
    config = deps.getConfig();
    if (config.allowedInstallationIds.size === 0) throw new Error("empty");
  } catch {
    // Fail closed: without an allowlist, any installation could queue work.
    return fail(503, "NOT_CONFIGURED", "Webhook receiver is not configured");
  }
  const { secret } = config;

  const raw = await readBodyLimited(request, MAX_WEBHOOK_BODY_BYTES);
  if (!raw) return fail(413, "PAYLOAD_TOO_LARGE", "Payload too large");

  if (
    !verifySignature(raw, request.headers.get("x-hub-signature-256"), secret)
  ) {
    return fail(401, "INVALID_SIGNATURE", "Signature verification failed");
  }

  // Signature is valid from here on, so header and payload come from GitHub.
  const headers = webhookHeadersSchema.safeParse({
    event: request.headers.get("x-github-event"),
    deliveryId: request.headers.get("x-github-delivery"),
  });
  if (!headers.success)
    return fail(400, "INVALID_HEADERS", "Invalid webhook headers");
  const { event, deliveryId } = headers.data;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return fail(400, "INVALID_JSON", "Payload is not valid JSON");
  }

  const parsed = parseWebhook(event, payload);
  if (parsed.kind === "invalid") {
    return fail(400, "INVALID_PAYLOAD", "Payload failed validation");
  }
  const reason =
    parsed.kind === "ignored"
      ? parsed.reason
      : config.allowedInstallationIds.has(parsed.work.installationId)
        ? undefined
        : "installation_not_allowed";
  if (parsed.kind === "ignored" || reason) {
    // Ignored deliveries never touch the database.
    logEvent("github_webhook", {
      requestId,
      deliveryId,
      event,
      outcome: "ignored",
      code: reason,
    });
    return Response.json(
      { status: "ignored", reason, requestId },
      { status: 202 },
    );
  }

  let result: EnqueueResult;
  try {
    result = await deps.enqueue(
      parsed.work,
      idempotencyKey(parsed.work),
      deliveryId,
    );
  } catch {
    // The error may contain connection details; only a fixed code is logged.
    logEvent("github_webhook", {
      requestId,
      deliveryId,
      event,
      outcome: "error",
      code: "ENQUEUE_FAILED",
    });
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Could not record the delivery",
      requestId,
    );
  }

  const outcome = result.created ? "queued" : "duplicate";
  logEvent("github_webhook", {
    requestId,
    deliveryId,
    event,
    outcome,
    analysisId: result.analysisId,
  });
  return Response.json(
    { status: outcome, analysisId: result.analysisId, requestId },
    { status: result.created ? 202 : 200 },
  );
}
