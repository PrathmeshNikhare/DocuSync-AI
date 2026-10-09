# Phase 05 — Approval-Gated Documentation PR

## Goal

Create a separate documentation branch and pull request only after explicit human approval.

## Prerequisites

Phases 00–04 pass; security reviewer approves the write workflow design.

## Tasks

- Define minimal GitHub write permissions.
- Bind approval to authenticated reviewer, exact proposal, target repo and source SHA.
- Re-check authorization and source revision at write time.
- Revalidate every accepted/edited patch.
- Create a unique branch and commit only approved documentation changes.
- Create a PR with a summary, evidence links and validation results.
- Add idempotency to prevent duplicate PRs on retries.
- Add tests for stale SHA, revoked permission, duplicate event, rejected proposal and partial GitHub failure.
- Never auto-merge.

## Exit criteria

- No GitHub write occurs without explicit valid approval.
- Stale approvals are rejected.
- Rejected proposals are excluded.
- Duplicate requests do not create duplicate PRs.
- Secrets remain server-side and logs are redacted.
- Security review passes and docs/status/handoff updated.
