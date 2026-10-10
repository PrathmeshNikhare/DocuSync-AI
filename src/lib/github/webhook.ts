import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PullRequestWork } from "@/lib/analysis-work";
import { PG_INT_MAX, githubNameSchema, gitShaSchema } from "@/lib/schemas";

/** GitHub caps payloads at 25 MB; pull_request events are far smaller. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Checks `X-Hub-Signature-256` against an HMAC-SHA256 of the exact raw body.
 * Must run before any payload field is trusted or even parsed.
 */
export function verifySignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const given = Buffer.from(signatureHeader.slice("sha256=".length), "utf8");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(rawBody).digest("hex"),
    "utf8",
  );
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Reads at most `maxBytes` of the body. Returns null if the declared or actual
 * size is larger, without buffering the excess.
 */
export async function readBodyLimited(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const webhookHeadersSchema = z.object({
  event: z.string().regex(/^[a-z_]{1,64}$/),
  deliveryId: z.uuid(),
});

export const SUPPORTED_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
] as const;

// Only the fields we use; GitHub sends many more, which are ignored.
const pullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    // Stored in an `integer` column; larger values would fail in the database.
    number: z.int().min(1).max(PG_INT_MAX),
    draft: z.boolean().optional(),
    head: z.object({ sha: gitShaSchema }),
    base: z.object({ sha: gitShaSchema }),
  }),
  repository: z.object({
    id: z.int().min(1),
    name: githubNameSchema,
    owner: z.object({ login: githubNameSchema }),
  }),
  installation: z.object({ id: z.int().min(1) }),
});

export type ParsedWebhook =
  | {
      kind: "ignored";
      reason: "unsupported_event" | "unsupported_action" | "draft";
    }
  | { kind: "invalid" }
  | { kind: "pull_request"; work: PullRequestWork };

/** Classifies a verified webhook. Unknown events and actions are ignored, not errors. */
export function parseWebhook(event: string, payload: unknown): ParsedWebhook {
  if (event !== "pull_request")
    return { kind: "ignored", reason: "unsupported_event" };
  const action = z.object({ action: z.string() }).safeParse(payload);
  if (!action.success) return { kind: "invalid" };
  if (
    !(SUPPORTED_PR_ACTIONS as readonly string[]).includes(action.data.action)
  ) {
    return { kind: "ignored", reason: "unsupported_action" };
  }
  const parsed = pullRequestEventSchema.safeParse(payload);
  if (!parsed.success) return { kind: "invalid" };
  const p = parsed.data;
  if (p.pull_request.draft) return { kind: "ignored", reason: "draft" };
  return {
    kind: "pull_request",
    work: {
      githubRepoId: p.repository.id,
      owner: p.repository.owner.login,
      repo: p.repository.name,
      installationId: p.installation.id,
      prNumber: p.pull_request.number,
      headSha: p.pull_request.head.sha,
      baseSha: p.pull_request.base.sha,
    },
  };
}

/** One analysis per repository, PR and head commit, however many deliveries arrive. */
export function idempotencyKey(work: PullRequestWork): string {
  return `github:pr:${work.githubRepoId}:${work.prNumber}:${work.headSha}`;
}
