import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { logEvent } from "@/lib/log";
import { readBodyLimited } from "@/lib/read-body";
import type { ApiError } from "@/lib/schemas";
import { writesEnabled } from "@/lib/env";
import { decide, type DecideResult } from "./decisions";
import { createDocsPr, RETRYABLE, type PublishDeps } from "./publish";
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

/** `{ headSha, patchSha256 }` is far smaller; anything bigger is refused unread. */
export const MAX_CREATE_PR_BODY_BYTES = 1024;

const PUBLISH_ERRORS: Record<string, [number, string]> = {
  WRITES_DISABLED: [503, "GitHub writes are turned off on this server"],
  INVALID_INPUT: [400, "Request could not be validated"],
  NOT_FOUND: [404, "Not found"],
  NOT_DECIDED: [409, "This proposal has no approved decision"],
  PROPOSAL_REJECTED: [409, "This proposal was rejected"],
  DECISION_REVOKED: [
    409,
    "The reviewer who approved this is no longer active or granted",
  ],
  APPROVAL_MISMATCH: [
    409,
    "The approval you confirmed differs from the recorded one; reload the page",
  ],
  APPROVAL_TAMPERED: [409, "The recorded approval failed its integrity checks"],
  PATCH_INVALID: [409, "The approved patch no longer passes validation"],
  FIXTURE_NOT_WRITABLE: [409, "Fixture data is never written to GitHub"],
  INSTALLATION_NOT_ALLOWED: [
    409,
    "This repository's installation is not allowed",
  ],
  ANALYSIS_TOO_OLD: [
    409,
    "This analysis lacks branch names; run a live analysis again",
  ],
  IN_PROGRESS: [409, "A pull request for this approval is being created"],
  RETRY_TOO_SOON: [429, "Wait 30 seconds before trying again"],
  ATTEMPT_LIMIT: [429, "Too many attempts for this approval"],
  PR_NOT_OPEN: [409, "The source pull request is not open"],
  REPOSITORY_MISMATCH: [409, "The repository on GitHub no longer matches"],
  FORK_NOT_SUPPORTED: [409, "Pull requests from forks are not supported"],
  STALE_HEAD: [409, "The source pull request has new commits; review again"],
  PR_RETARGETED: [409, "The source pull request's branches changed"],
  STALE_BLOB: [409, "The document changed on GitHub; review again"],
  TREE_TRUNCATED: [
    409,
    "The repository tree is too large to check the document",
  ],
  BRANCH_CONFLICT: [
    409,
    "The documentation branch on GitHub has unexpected changes",
  ],
  PR_HEAD_MISMATCH: [
    409,
    "A pull request was opened, but its branch changed before it was checked; close it on GitHub",
  ],
  PR_CREATE_REFUSED: [
    409,
    "GitHub refused to open the pull request (for example, the source branch was deleted)",
  ],
};

/** POST /api/reviews/:id/create-pr: the only route that writes to GitHub. */
export const handleCreatePr = (
  request: Request,
  proposalId: string,
  deps: ApiDeps & { publish(): PublishDeps },
) =>
  guarded("api_create_pr", (requestId) =>
    createPrInner(request, proposalId, deps, requestId),
  );

async function createPrInner(
  request: Request,
  proposalId: string,
  deps: ApiDeps & { publish(): PublishDeps },
  requestId: string,
): Promise<Response> {
  const who: { reviewerId?: string } = {};
  const fail = (
    status: number,
    code: string,
    message: string,
    outputId?: string,
  ) => {
    logEvent("api_create_pr", {
      requestId,
      reviewerId: who.reviewerId,
      outputId,
      outcome: "rejected",
      code,
    });
    return error(status, code, message, requestId);
  };
  // Checked first, and again inside the publish flow and the writer.
  if (!writesEnabled())
    return fail(503, "WRITES_DISABLED", PUBLISH_ERRORS.WRITES_DISABLED![1]);
  if (!sameOrigin(request))
    return fail(403, "FORBIDDEN_ORIGIN", "Cross-site request refused");
  const reviewer = await deps.reviewerFor(request);
  if (!reviewer) return fail(401, "UNAUTHENTICATED", "Sign in to continue");
  who.reviewerId = reviewer.id;
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return fail(415, "UNSUPPORTED_MEDIA_TYPE", "Send application/json");
  }
  const raw = await readBodyLimited(request, MAX_CREATE_PR_BODY_BYTES);
  if (!raw) return fail(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return fail(400, "INVALID_JSON", "Request body is not valid JSON");
  }
  // Configuration is validated before any attempt is claimed or token minted.
  let publishDeps: PublishDeps;
  try {
    publishDeps = deps.publish();
  } catch {
    return fail(
      503,
      "WRITES_MISCONFIGURED",
      "GitHub writes are enabled but not configured correctly on this server",
    );
  }
  const result = await createDocsPr(publishDeps, reviewer.id, proposalId, body);
  if (!result.ok) {
    const [status, message] =
      PUBLISH_ERRORS[result.code] ??
      (RETRYABLE.includes(result.code)
        ? [502, "GitHub could not complete the request; try again later"]
        : [
            502,
            "GitHub refused the request; this approval can't be published as it is",
          ]);
    return fail(
      status,
      result.code === "INVALID_INPUT" ? "VALIDATION_ERROR" : result.code,
      message,
      result.outputId,
    );
  }
  logEvent("api_create_pr", {
    requestId,
    reviewerId: reviewer.id,
    outputId: result.outputId,
    outcome: result.created ? "pr_opened" : "pr_exists",
  });
  return Response.json(
    {
      pullRequest: {
        number: result.prNumber,
        url: result.prUrl,
        created: result.created,
      },
    },
    { status: result.created ? 201 : 200, headers: NO_STORE },
  );
}
