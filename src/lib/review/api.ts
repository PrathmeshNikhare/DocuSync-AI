import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { logEvent } from "@/lib/log";
import { readBodyLimited } from "@/lib/read-body";
import type { ApiError } from "@/lib/schemas";
import { decide, type DecideResult } from "./decisions";
import { getAnalysis, getReview } from "./queries";
import type { Reviewer } from "./session";

/** Room for a 100,000-character edited patch, JSON-escaped. */
export const MAX_DECISION_BODY_BYTES = 256 * 1024;

export interface ApiDeps {
  pool: Pool;
  reviewerFor(request: Request): Promise<Reviewer | undefined>;
}

const NO_STORE = { "cache-control": "no-store" };

function error(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: object,
) {
  const body: ApiError & { issues?: string[] } = {
    error: { code, message, requestId },
    ...extra,
  };
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Cookie-authenticated writes must come from this site. SameSite=Strict already
 * stops cross-site cookies; this also refuses requests whose Origin says otherwise.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/**
 * Any unexpected failure (database down, corrupt stored data) becomes a coded 500
 * in the usual envelope. The error itself is never logged or returned: database
 * errors can name hosts and users.
 */
async function guarded(
  name: string,
  handle: (requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    return await handle(requestId);
  } catch {
    logEvent(name, { requestId, outcome: "error", code: "INTERNAL_ERROR" });
    return error(500, "INTERNAL_ERROR", "Something went wrong", requestId);
  }
}

const readOnly = (
  request: Request,
  deps: ApiDeps,
  load: (reviewerId: string) => Promise<unknown>,
  name: string,
) =>
  guarded(name, (requestId) =>
    readOnlyInner(request, deps, load, name, requestId),
  );

async function readOnlyInner(
  request: Request,
  deps: ApiDeps,
  load: (reviewerId: string) => Promise<unknown>,
  name: string,
  requestId: string,
): Promise<Response> {
  const reviewer = await deps.reviewerFor(request);
  if (!reviewer)
    return error(401, "UNAUTHENTICATED", "Sign in to continue", requestId);
  const data = await load(reviewer.id);
  logEvent(name, { requestId, outcome: data ? "ok" : "not_found" });
  // Not found and not authorized look the same, so ids can't be probed.
  return data
    ? Response.json(data, { headers: NO_STORE })
    : error(404, "NOT_FOUND", "Not found", requestId);
}

export const handleGetAnalysis = (
  request: Request,
  id: string,
  deps: ApiDeps,
) =>
  readOnly(
    request,
    deps,
    (r) => getAnalysis(deps.pool, r, id),
    "api_get_analysis",
  );

export const handleGetReview = (request: Request, id: string, deps: ApiDeps) =>
  readOnly(request, deps, (r) => getReview(deps.pool, r, id), "api_get_review");

const DECISION_ERRORS: Record<
  Extract<DecideResult, { ok: false }>["code"],
  [number, string, string]
> = {
  INVALID_INPUT: [400, "VALIDATION_ERROR", "Request could not be validated"],
  NOT_FOUND: [404, "NOT_FOUND", "Not found"],
  ALREADY_DECIDED: [
    409,
    "INVALID_TRANSITION",
    "This proposal already has a decision",
  ],
  PROPOSAL_NOT_VALID: [
    409,
    "PROPOSAL_NOT_VALID",
    "This proposal did not pass validation, so it can't be decided",
  ],
  EDIT_UNCHANGED: [
    422,
    "EDIT_UNCHANGED",
    "The edited patch is the same as the proposal",
  ],
  EDIT_INVALID: [
    422,
    "EDIT_INVALID",
    "The edited patch did not pass validation",
  ],
};

/** PATCH /api/reviews/:id — one decision; never a GitHub write. */
export const handleDecision = (
  request: Request,
  proposalId: string,
  deps: ApiDeps,
) =>
  guarded("api_review_decision", (requestId) =>
    decisionInner(request, proposalId, deps, requestId),
  );

async function decisionInner(
  request: Request,
  proposalId: string,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const fail = (
    status: number,
    code: string,
    message: string,
    extra?: object,
  ) => {
    logEvent("api_review_decision", { requestId, outcome: "rejected", code });
    return error(status, code, message, requestId, extra);
  };
  if (!sameOrigin(request))
    return fail(403, "FORBIDDEN_ORIGIN", "Cross-site request refused");
  const reviewer = await deps.reviewerFor(request);
  if (!reviewer) return fail(401, "UNAUTHENTICATED", "Sign in to continue");
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return fail(415, "UNSUPPORTED_MEDIA_TYPE", "Send application/json");
  }
  const raw = await readBodyLimited(request, MAX_DECISION_BODY_BYTES);
  if (!raw) return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return fail(400, "INVALID_JSON", "Request body is not valid JSON");
  }
  const result = await decide(deps.pool, reviewer.id, proposalId, body);
  if (!result.ok) {
    const [status, code, message] = DECISION_ERRORS[result.code];
    return fail(
      status,
      code,
      message,
      result.issues ? { issues: result.issues } : undefined,
    );
  }
  logEvent("api_review_decision", {
    requestId,
    outcome: result.record.decision,
  });
  return Response.json({ decision: result.record }, { headers: NO_STORE });
}
