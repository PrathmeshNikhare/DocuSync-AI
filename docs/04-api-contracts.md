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

### `GET /api/analyses/:id`
- Return status, impact candidates and safe error information.
- Enforce access to the associated repository.

### `GET /api/reviews/:id`
- Return proposal metadata, evidence and diff content necessary for review.
- Do not return secrets or unnecessary repository content.

### `PATCH /api/reviews/:id`
- Accept one decision: `accepted`, `edited` (with `editedPatch`), or `rejected` (`reviewDecisionInputSchema`).
- The body must not carry `reviewerId` or `proposalId`. The reviewer comes from the authenticated session, and the proposal comes from the URL.
- Require authentication and authorization.
- Validate edited patch; record reviewer and decision.
- Acceptance is not itself a GitHub write unless the explicit approval workflow is implemented and invoked.

### `POST /api/reviews/:id/create-pr`
- Later phase only.
- Require fresh explicit approval, repository write authorization and source revision check.
- Use narrow GitHub permissions and idempotency.
- Never merge automatically.

## Shared contract rules

- Validate all input at runtime.
- Limit body size and array lengths.
- Reject unknown or invalid state transitions.
- Use consistent status codes and request IDs.
- Avoid trusting IDs supplied by the client without checking ownership.
