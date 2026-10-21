# API Contracts

The HTTP surface of the app: one health check, one webhook, three review endpoints and one write endpoint. Request and response shapes are Zod schemas (`src/lib/schemas.ts`), and every error uses one envelope. Authenticated endpoints use the session cookie described in docs/07; sign-in and sign-out are Server Actions, not JSON endpoints.

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

Client errors never include stack traces, secrets, raw authorization headers or private model context.

## Endpoints

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /api/health` | Liveness: `{"status": "ok"}`. It does not check the database or the model. | none |
| `POST /api/webhooks/github` | Receive `pull_request` webhooks and enqueue an analysis | HMAC signature |
| `GET /api/analyses/:id` | An analysis with its candidates | session and grant |
| `GET /api/reviews/:id` | A proposal with its evidence and diff | session and grant |
| `PATCH /api/reviews/:id` | Record one decision | session, grant, same origin |
| `POST /api/reviews/:id/create-pr` | Open the documentation PR (the only write to GitHub) | session, grant, same origin |

### `POST /api/webhooks/github`
- Verifies `X-Hub-Signature-256` against the raw request body before trusting any payload field, then validates the event, action, repository and PR identifiers.
- Records an idempotency key and enqueues the analysis. It returns promptly and never fetches from GitHub or runs a model inline (D-009).
- Responses (errors use the error envelope):

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

### `GET /api/analyses/:id`
- Returns the analysis status, its impact candidates (evidence, missing context and the model assessment) and safe error information. It also returns `docsPartial`.
- Access is checked against the reviewer's grant on the analysis's repository.

### `GET /api/reviews/:id`
- Returns the proposal metadata, evidence and diff content needed for review. It also returns `pr.headRef`, `output` (`step`, `errorCode`, `prNumber`, `prUrl`, or null) and `writesEnabled`.
- It returns no secrets and no repository content beyond the document under review.

### `PATCH /api/reviews/:id`
- Accepts one decision: `accepted`, `edited` (with `editedPatch`), or `rejected` (`reviewDecisionInputSchema`).
- The body must not carry `reviewerId` or `proposalId`: the reviewer comes from the session and the proposal from the URL.
- An edited patch is validated with `validatePatch` before the decision is recorded.
- Recording a decision is a database write only. Opening a documentation PR is the separate `create-pr` endpoint.

### Review API behaviour

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
| More than 60 decision requests by one reviewer in a minute | 429 | `RATE_LIMITED` |
| Proposal already decided | 409 | `INVALID_TRANSITION` |
| Proposal did not pass validation | 409 | `PROPOSAL_NOT_VALID` |
| Edited patch identical to the proposal | 422 | `EDIT_UNCHANGED` |
| Edited patch fails `validatePatch` | 422 | `EDIT_INVALID`, with `issues` |
| Unexpected failure (database down, corrupt stored data) | 500 | `INTERNAL_ERROR` (the cause is neither returned nor logged) |

Sign-in and sign-out are Server Actions on `/login` and in the review layout, not JSON endpoints. Next.js refuses a Server Action whose `Origin` doesn't match the host; it answers 500 in that case.

### `POST /api/reviews/:id/create-pr`
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
| More than 10 create-PR requests by one reviewer in a minute | 429 | `RATE_LIMITED` |
| GitHub failed, timed out or answered ambiguously, the token was refused or wrongly scoped, a redirect (all retryable), or a terminal GitHub code such as a guard refusal or invalid response | 502 | the `GITHUB_*` or `LEASE_LOST` code; the message says whether to try again |
| Unexpected failure | 500 | `INTERNAL_ERROR` |

Non-retryable codes are stored on the output row, and later requests get the same code without calling GitHub; they need a new analysis and review. A decision whose PR was already opened always answers 200 with that PR, even if its approver was disabled since.

## Conventions

- All input is validated at runtime, with limits on body size and array lengths.
- Invalid state transitions are rejected (`INVALID_TRANSITION`).
- Every response carries consistent status codes and, for errors, a request id.
- IDs supplied by the client are never trusted without an ownership check: a missing resource and one the reviewer has no grant for both return 404.
- **Same origin behind a proxy:** the check compares `Origin` with `APP_ORIGIN` when that is set, and otherwise with the request's own URL. Behind a TLS proxy, set `APP_ORIGIN` to the browser-visible origin (docs/10), or every decision is refused with `FORBIDDEN_ORIGIN`.
- **Early answers:** `create-pr` answers an existing output that is locked, terminal, at its attempt limit or retried too soon from its row, before re-checking the approval. A decision whose PR was opened returns that PR.
