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

### `POST /api/webhooks/github`
- Accept GitHub webhook events.
- Verify `X-Hub-Signature-256` against the raw request body before trusting payload fields.
- Validate event/action/repository/PR identifiers.
- Persist idempotency state and dispatch supported events.
- Return promptly; do not perform unbounded model work inline.

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
- Accept one decision: `accept`, `edit`, or `reject`.
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
