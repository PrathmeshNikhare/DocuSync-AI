# Phase 01 — GitHub Diff Ingestion

## Goal

Safely fetch and normalize pull-request metadata and diffs through a read-only GitHub integration.

## Tasks

- Define GitHub adapter interfaces and mockable tests.
- Configure GitHub App authentication and minimal read permissions.
- Verify webhook signature using raw body before trusting event payload.
- Validate supported event/action types with Zod.
- Normalize changed paths and bounded diff hunks.
- Add size limits, pagination, timeout and error mapping.
- Persist or safely represent idempotency keys.
- Never check out or execute repository code.
- Provide a local fixture mode for development without credentials.

## Exit criteria

- Valid webhook fixture is accepted; invalid signature is rejected.
- Unsupported events are safely ignored or rejected.
- Path traversal and oversized inputs are rejected.
- Duplicate delivery does not create duplicate analysis work.
- GitHub calls are tested with mocks; no secrets appear in logs.
- Only read operations are enabled.
- Docs/status/handoff updated.
