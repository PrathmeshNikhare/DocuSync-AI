# Agent Coordination and Engineering Rules

## Source of truth

Priority order:
1. User's explicit instruction in the current session.
2. `CLAUDE.md` and this file.
3. Active phase specification in `phases/`.
4. Architecture/contracts/security/testing docs.
5. Current status, decisions and handoffs.
6. Chat context and agent assumptions.

If sources conflict, stop and explain the conflict; do not silently choose a risky interpretation.

## Ownership boundaries

- Main Claude Code session: phase scope, integration, shared contracts, status and final report.
- `architect`: design review and trade-offs; normally no implementation edits.
- `implementer`: implementation within the active phase and assigned files.
- `test-engineer`: tests and test design; coordinate before modifying shared production files.
- `security-reviewer`: read-only threat review unless explicitly assigned a remediation.
- `reviewer`: read-only correctness, maintainability and acceptance review.

Agents must state assumptions, changed files, commands run, test outcomes and unresolved issues. The main session independently verifies material claims.

## Handoff-first protocol

Every phase handoff must include:
- Active phase and outcome.
- What was implemented and why.
- Files changed.
- Exact checks and outcomes.
- Known failures, limitations and security concerns.
- Current branch and git status.
- Decisions added or changed.
- Next phase prerequisites.
- A rollback/recovery note.
- What the next session must verify before continuing.

The receiving session must inspect the repository and rerun appropriate checks before trusting a handoff.

## Definition of phase completion

All phase acceptance criteria pass; tests were run; docs are current; security review is complete for relevant boundaries; status and phase log are updated; handoff exists. If anything is blocked, mark the phase BLOCKED and identify the smallest unblock action.

## No false completion

Do not say “all tests pass” without command output from the current relevant run. Distinguish:
- PASS: executed and succeeded.
- FAIL: executed and failed.
- BLOCKED: not executable due to environment or dependency.
- NOT RUN: intentionally not executed.
