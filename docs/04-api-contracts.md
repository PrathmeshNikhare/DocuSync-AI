# API Contracts

These are intended contracts. Implement only the endpoints needed by the active phase. Use Zod schemas and return consistent error shapes.

## Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request could not be validated",
    "requestId": "opaque-id"
  }
}
```

Never include stack traces, secrets, raw authorization headers or private model context in client errors.

## Planned endpoints

### `POST /api/webhooks/github` (implemented in Phase 01)
- Accept GitHub webhook events.
- Verify `X-Hub-Signature-256` against the raw request body before trusting payload fields.
- Validate event/action/repository/PR identifiers.
- Persist idempotency state and dispatch supported events.
- Return promptly; do not perform unbounded model work inline.
- Implemented responses (errors use the error envelope):

| Case | Status | Body |
|---|---|---|
| Supported `pull_request` action, new head commit | 202 | `{status: "queued", analysisId, requestId}` |
| Redelivery, or another delivery for the same head commit | 200 | `{status: "duplicate", analysisId, requestId}` |
| Other event, other action, a draft PR, or an installation not in `GITHUB_ALLOWED_INSTALLATION_IDS` | 202 | `{status: "ignored", reason, requestId}` (no database write) |
| Body over 1 MiB | 413 | `PAYLOAD_TOO_LARGE` |
| Missing or invalid signature | 401 | `INVALID_SIGNATURE` |
| Signed, but bad headers, JSON or payload | 400 | `INVALID_HEADERS`, `INVALID_JSON`, `INVALID_PAYLOAD` |
| Webhook secret or installation allowlist not configured (fails closed) | 503 | `NOT_CONFIGURED` |
| Database failure | 500 | `INTERNAL_ERROR` |

### `POST /api/analyses`
- Authenticated user-triggered analysis, if needed.
- Validate repository/PR references and authorize the user.
- Return an analysis identifier and state.

### `GET /api/analyses/:id` (implemented in Phase 04)
- Return status, impact candidates and safe error information.
- Enforce access to the associated repository.

### `GET /api/reviews/:id` (implemented in Phase 04)
- Return proposal metadata, evidence and diff content necessary for review.
- Do not return secrets or unnecessary repository content.

### `PATCH /api/reviews/:id` (implemented in Phase 04)
- Accept one decision: `accepted`, `edited` (with `editedPatch`), or `rejected` (`reviewDecisionInputSchema`).
- The body must not carry `reviewerId` or `proposalId`. The reviewer comes from the authenticated session, and the proposal comes from the URL.
- Require authentication and authorization.
- Validate edited patch; record reviewer and decision.
- Acceptance is not itself a GitHub write unless the explicit approval workflow is implemented and invoked.

### Implemented behaviour (Phase 04)

All three endpoints authenticate with the session cookie and answer with `cache-control: no-store`. Errors use the envelope above, plus an `issues` array for patch validation failures. A missing resource and one the reviewer has no grant for both return 404, so ids can't be probed.

| Case | Status | Code |
|---|---|---|
| Decision recorded | 200 | body `{decision: ReviewDecisionRecord}` |
| GET with access | 200 | the analysis or review view |
| No or expired session | 401 | `UNAUTHENTICATED` |
| PATCH whose `Origin` isn't this site (or, with no `Origin`, `Sec-Fetch-Site` isn't `same-origin`) | 403 | `FORBIDDEN_ORIGIN` |
| Unknown id, malformed id, or no grant for the repository | 404 | `NOT_FOUND` |
| PATCH body not `application/json` | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| PATCH body over 256 KiB | 413 | `PAYLOAD_TOO_LARGE` |
| Body not JSON, or not one of the three decision shapes (extra keys such as `reviewerId` included) | 400 | `INVALID_JSON`, `VALIDATION_ERROR` |
| More than 60 decision requests by one reviewer in a minute (Phase 06) | 429 | `RATE_LIMITED` |
| Proposal already decided | 409 | `INVALID_TRANSITION` |
| Proposal did not pass validation | 409 | `PROPOSAL_NOT_VALID` |
| Edited patch identical to the proposal | 422 | `EDIT_UNCHANGED` |
| Edited patch fails `validatePatch` | 422 | `EDIT_INVALID`, with `issues` |
| Unexpected failure (database down, corrupt stored data) | 500 | `INTERNAL_ERROR` (the cause is neither returned nor logged) |

Sign-in and sign-out are Server Actions on `/login` and in the review layout, not JSON endpoints. Next.js refuses a Server Action whose `Origin` doesn't match the host; it answers 500 in that case.

### `POST /api/reviews/:id/create-pr` (implemented in Phase 05)
- The only route that writes to GitHub (docs/13). Body: exactly `{ headSha, patchSha256 }` (at most 1 KiB), echoing the approval the reviewer confirmed. Same-origin, session and grant checks as for decisions; `cache-control: no-store`.
- Never merges. Creates at most one branch, one commit and one PR per decision.

| Case | Status | Code |
|---|---|---|
| PR created | 201 | body `{pullRequest: {number, url, created: true}}` |
| PR already created for this decision (no GitHub call) | 200 | same body, `created: false` |
| `GITHUB_WRITES_ENABLED` is not `true` (checked before the session) | 503 | `WRITES_DISABLED` |
| Writes enabled but the App id or key, `GITHUB_APP_SLUG` or the installation allowlist is invalid (no attempt is used) | 503 | `WRITES_MISCONFIGURED` |
| Cross-site request / no session | 403 / 401 | `FORBIDDEN_ORIGIN` / `UNAUTHENTICATED` |
| Not JSON, over 1 KiB, wrong shape | 415, 413, 400 | `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `INVALID_JSON` / `VALIDATION_ERROR` |
| Unknown id or no grant | 404 | `NOT_FOUND` |
| Approval problems | 409 | `NOT_DECIDED`, `PROPOSAL_REJECTED`, `DECISION_REVOKED`, `APPROVAL_MISMATCH`, `APPROVAL_TAMPERED`, `PATCH_INVALID` |
| Not writable | 409 | `FIXTURE_NOT_WRITABLE`, `INSTALLATION_NOT_ALLOWED`, `ANALYSIS_TOO_OLD` |
| GitHub state changed | 409 | `PR_NOT_OPEN`, `REPOSITORY_MISMATCH`, `FORK_NOT_SUPPORTED`, `STALE_HEAD`, `PR_RETARGETED`, `STALE_BLOB`, `TREE_TRUNCATED`, `BRANCH_CONFLICT`, `PR_CREATE_REFUSED`, `PR_HEAD_MISMATCH` (a PR was opened but its branch moved; close it) |
| Another attempt holds the lease | 409 | `IN_PROGRESS` |
| Retried within 30 s / more than 5 attempts | 429 | `RETRY_TOO_SOON` / `ATTEMPT_LIMIT` |
| More than 10 create-PR requests by one reviewer in a minute (Phase 06) | 429 | `RATE_LIMITED` |
| GitHub failed, timed out or answered ambiguously, the token was refused or wrongly scoped, a redirect (all retryable), or a terminal GitHub code such as a guard refusal or invalid response | 502 | the `GITHUB_*` or `LEASE_LOST` code; the message says whether to try again |
| Unexpected failure | 500 | `INTERNAL_ERROR` |

Non-retryable codes are stored on the output row, and later requests get the same code without calling GitHub; they need a new analysis and review. A decision whose PR was already opened always answers 200 with that PR, even if its approver was disabled since.

## Shared contract rules

- Validate all input at runtime.
- Limit body size and array lengths.
- Reject unknown or invalid state transitions.
- Use consistent status codes and request IDs.
- Avoid trusting IDs supplied by the client without checking ownership.

## Phase 06 additions

- **`GET /api/reviews/:id` fields:** it also returns `pr.headRef`, `output` (`step`, `errorCode`, `prNumber`, `prUrl`, or null) and `writesEnabled`.
- **`GET /api/analyses/:id` fields:** it also returns `docsPartial`.
- **Same origin behind a proxy:** the check compares `Origin` with `APP_ORIGIN` when that is set, and otherwise with the request's own URL. Behind a TLS proxy, set `APP_ORIGIN` to the public origin (docs/10).
- **Early answers:** create-PR answers an existing output that is locked, terminal, at its attempt limit or retried too soon from its row, before re-checking the approval. A decision whose PR was opened returns that PR.
