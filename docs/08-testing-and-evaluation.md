# Testing and Evaluation

## Test layers

- Unit: path normalization, diff parsing, candidate scoring, schemas, state transitions and patch validation.
- Integration: PostgreSQL repositories, GitHub adapter mocked at network boundary, Ollama provider mocked for deterministic tests.
- Contract: Route Handler request/response validation and webhook signature checks.
- UI: review controls, empty/loading/error states, keyboard accessibility.
- End-to-end: test repository workflow from PR event to proposed changes and human approval.
- Security: malformed webhook, replay, prompt injection, traversal paths, unauthorized review, stale SHA, oversized diff and duplicate PR attempts.

## Required test fixtures

Create synthetic repositories and diffs covering:
- New environment variable.
- API route or request/response change.
- Renamed/exported symbol.
- Changed CLI/package script.
- Internal refactor with no doc impact.
- Documentation-only change.
- Missing/contradictory docs.
- Malformed and oversized diff.
- Path traversal attempt.
- Prompt injection in a comment or Markdown file.
- Model timeout and invalid structured output.

## Evaluation protocol

- Label affected docs for each scenario before evaluating the system.
- Track true positives, false positives, false negatives and true negatives.
- Report precision and recall, plus the raw counts and dataset scope.
- Track patch validity, reviewer acceptance rate and median/p95 latency.
- Separate deterministic baseline results from LLM-assisted results.
- Record model identifier, prompt version, test set version and environment.
- Never tune on the final held-out evaluation set.
- Do not report invented or selectively cherry-picked metrics.

## Phase gate

A test suite passing does not by itself prove product quality. Record test outcomes and benchmark results separately.
