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

## Phase 02 baseline (implemented)

- **`impact-v1`:** 13 synthetic scenarios in `fixtures/impact/`, each with raw GitHub file entries, the docs at head, and `labels.affected`. Labels were written before any engine code existed. One matching bug (`fix` matched inside `lint:fix`) was fixed after the first run; it corrected an evidence entry and changed no metric.
- **`impact-v2`:** 8 regression scenarios added after the Phase 02 review: dependency bump, CI workflow YAML, a PR documenting its own env var, a doc linked from an edited doc, multi-hunk `package.json`, a scripts header out of view, root route, dynamic route. They were labelled **before** the engine fixes and run on the unfixed engine first.
- **Scoring rule:** labelling a doc the PR itself edits is rejected by the scenario schema, because such docs are excluded from scoring and would hide a false negative.
- **`npm run eval:impact`** runs the engine and writes `docs/evaluation/impact-baseline.md`, which reports TP/FP/FN/TN, precision and recall overall, per dataset, by category and per doc, plus the dataset's limits. A unit test fails if the committed report is out of date.

| Engine | Dataset | TP | FP | FN | TN |
|---|---|---|---|---|---|
| `deterministic-0.1.0` | `impact-v1` | 9 | 1 | 1 | 15 |
| `deterministic-0.1.0` (before review fixes) | `impact-v2` | 2 | 6 | 1 | 5 |
| `deterministic-0.2.0` (after review fixes) | `impact-v1` | 9 | 1 | 1 | 15 |
| `deterministic-0.2.0` (after review fixes) | `impact-v2` | 3 | 0 | 0 | 11 |

| `deterministic-0.3.0` (after security fixes) | `impact-v1` + `impact-v2` | 12 | 1 | 1 | 26 |

- The security fixes (ReDoS, budgets, evidence integrity) changed no metric on either dataset.
- The v1 FP and FN are the two deliberately adversarial scenarios, and are unchanged.
- The v2 scenarios target the fixed findings, so the perfect v2 score after the fixes shows the fixes work, not that the engine generalizes.
- All numbers come from small synthetic datasets whose author also wrote the engine. They are not a held-out evaluation and say nothing about real repositories.
