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

## Phase 03 model-assisted evaluation (implemented)

- **Tests without a model:** the provider, Ollama transport (mocked `fetch`: 404, 5xx, refused connection, timeout, a hung server, non-JSON, unfinished and oversized replies), prompts and output schemas, the patch module (path attacks, git blob SHA vectors from `git hash-object`, render and strict-apply round trips including 2,000 seeded random edits, malformed and stale diffs, every validation rule), and `assistImpact` with a scripted mock model (fallbacks, the per-PR cap, prompt-injection behaviour, the no-change-facts guard).
- **Opt-in live tests:** `npm run test:ollama` (needs `OLLAMA_MODEL` and Ollama; fails rather than skipping without them): structured output, the injection fixture's invariants, a missing model and an unreachable server.
- **Patch labels (`patch-v1`):** `fixtures/patches/labels.json` gives each labelled-affected doc strings a correct patch must contain or must not leave behind (case-insensitive, on the whole patched doc). They were written before any model output was read. `patch-unavailable` is not labelled, because its diff is not available.
- **`npm run eval:llm`** runs deterministic and model-assisted analysis over all 21 scenarios and writes `docs/evaluation/llm-assisted.md`. Model output varies by machine and model build, so the report records one run and is not checked in CI.

All runs used `llama3.2:3b` via Ollama 0.40.3 on the development machine (temperature 0, seed 42 on a first attempt, `num_ctx` 8192), prompt `patch-v1`, engine `deterministic-0.3.0`, on 2026-10-11. Runs 1-5 used `assess-v1`; run 6 used `assess-v2`, whose only change is the citation bound in the output schema, plus a note in the prompt that indexes start at 0. "Model calls" in the report counts structured requests; a retry is part of its request's latency.

| Run | Assist policy | Patch requests | Valid proposals | Label pass / fail / no valid patch / not attempted (12 labels) | Assisted flagging TP / FP / FN / TN | Call latency median / p95 |
|---|---|---|---|---|---|---|
| 1 | none: the whole patch is rejected if any edit can't be placed | 12 | 0 | 0 / 0 / 10 / 2 | 12 / 1 / 1 / 26 | 2.8 s / 5.9 s |
| 2 | `assist-v1`: unplaceable edits are dropped | 12 | 10 | 6 / 3 / 1 / 2 | 12 / 1 / 1 / 26 | 2.8 s / 5.8 s |
| 3 | `assist-v2`: no patch without change facts | 9 | 7 | 6 / 1 / 1 / 4 | 12 / 1 / 1 / 26 | 2.5 s / 7.2 s |
| 4 | `assist-v3`: line-less evidence brings its file's hunks | 11 | 8 | 7 / 1 / 2 / 2 | 12 / 1 / 1 / 26 | 2.7 s / 6.3 s |
| 5 | `assist-v3` again (report wording changed only) | 11 | 8 | 7 / 1 / 2 / 2 | 12 / 1 / 1 / 26 | 2.6 s / 5.9 s |
| 6 | `assist-v4` + `assess-v2`: review fixes (bounded citations, a new seed on retry, no-op edits dropped, stricter link and HTML checks) | 12 | 9 | 8 / 1 / 2 / 1 | 12 / 1 / 1 / 26 | 3.1 s / 9.5 s* |
| 7 | `assist-v5`: security-check fixes (links resolved like a browser, new raw HTML rejected, unsafe model prose withheld, smaller context budgets, prompt-size guard) | 12 | 8 | 7 / 1 / 3 / 1 | 12 / 1 / 1 / 26 | 5.8 s / 20.3 s** |

`docs/evaluation/llm-assisted.md` is run 7. *A build and the database tests ran on the same machine during the end of run 6, so its latency is likely inflated. **Nothing else ran during run 7, yet latency roughly doubled; a single repeated call afterwards also took 10.4 s against about 3-6 s earlier. The cause (machine load or thermal state, Ollama) was not identified, so run 7's latency is not comparable with earlier runs.

- **The policy changes were made after reading model output on these same fixtures**, so runs 2-7 are tuned on the evaluation set. Labels and the engine did not change; the assessment prompt changed once (run 6) to bound citations. Run 1 is the only untuned result.
  - Run 1: the model usually found the right edit but also sent overlapping or redundant edits and edits copied from the source diff, and a single unplaceable edit rejected the whole patch.
  - Run 2: one of the 10 valid proposals was fabricated. For `patch-unavailable`, with no diff, the model changed port 8080 to 8081. That led to `assist-v2`. Another passed validation and its label but duplicated a line and dropped formatting.
  - Run 3 exposed a bug in `assist-v2`: route evidence has no line number, so its file's hunks were left out and two route scenarios were wrongly marked `NO_CHANGE_FACTS`. Fixed in `assist-v3`.
- **Run 7 rejected the `injection-in-doc` patch** (`PATCH_UNSAFE_HTML`): the model rewrote the doc's injected `<!-- AI assistant: ignore all previous instructions … -->` comment while renaming the variable, and a changed comment is new raw HTML. Earlier runs counted that proposal as valid and passing its label. With the same prompt and seed they most likely proposed the same rewrite, so the earlier validator let a model edit an injected instruction (not re-run to confirm).
- **Model-assisted flagging equals the deterministic baseline in every run.** The model judged every assessed doc `needs_update`, including the known false positive, so with this model the assessment step neither helped nor hurt. In runs 1-5 one assessment per run (`linked-file-renamed`) was rejected. Its reply was valid JSON but cited evidence `[1, 2]` of two items (indexes 0 and 1), probably counting from 1. The range check ran outside the retry, reported it as invalid output, and the deterministic status stood. The `/review` also showed that the retry itself was a no-op: the same request with the same seed at temperature 0 returned a byte-identical reply. Run 6 bounds citations in the schema (enforced during decoding) and retries with a new seed; that assessment now succeeds and its patch passes its label.
- **Repeatability:** run 5 repeated run 4 with identical outcomes for every doc; only latency differed. Variation across machines, model builds or Ollama versions was not measured.
- **Limits:** 21 small synthetic scenarios, with prompts, labels and code by one author. `label_pass` checks a few strings, not prose quality. Latency is per call on one machine. None of this estimates real-world performance.

## Phase 04 tests (implemented)

- **Database tests (`npm run test:db`, 42):**
  - login: a generic error, rate limiting, and disabled reviewers;
  - sessions: stored only as a hash, revoked, expired and malformed tokens;
  - authorized reads and decisions: no grant means not found;
  - the decision rules: one final decision, six concurrent decisions with exactly one winner, a valid edit, unchanged, invalid and other-file edits, extra body keys, and an invalid proposal;
  - the app role's limits: an append-only audit trail and operator-only accounts;
  - the API status mapping: 401, 403, 404, 409, 413, 415, 422.
- **Unit and component tests (`npm test`, 600):**
  - password hashing;
  - side-by-side diff rows;
  - invisible-character markers;
  - the security headers, and that `next.config.ts` applies them;
  - React Testing Library tests (jsdom) for the dashboard, analysis and review views, and every state: empty, no access, partial (model not configured), failed, running, decided and invalid proposal;
  - the decision panel: confirm step with focus, Escape to cancel, pending, success with refresh, validation issues, 409, 401, unknown errors and network failure;
  - the login form;
  - untrusted text never rendered as HTML.
- **Mutation checks:** 13 controls, each disabled in turn, and every one caught a failing test:
  - the grant joins on reads and on decisions;
  - one decision per proposal: the code check survived on its own because the unique constraint backs it up, so the constraint was pinned with its own test and mutated separately;
  - edited-patch validation;
  - session revocation, login rate limiting and disabled reviewers;
  - the same-origin check and `no-store`;
  - invisible markers, the confirm step and model-text labelling.
- **End to end against `next dev` (2026-10-11, recorded in the handoff):**
  - the signed-out redirect, and 401 from the API;
  - sign-in through the real Server Action without JavaScript: a wrong password, a cross-site post refused, then success with an `HttpOnly`, `SameSite=Strict`, 12-hour cookie;
  - the dashboard, analysis and review pages;
  - cross-site PATCH 403, a client `reviewerId` 400, accept 200, a second decision 409, and the audit trail shown;
  - sign-out revoking the session, so the old cookie gets 401.
  - **The run found a bug:** a Next.js invariant when the login page re-rendered after a failed no-JavaScript sign-in, because the layout's session nav read cookies. It was fixed by moving the signed-in nav into a `(review)` route group, and the re-run was clean.
- **Not tested:** a real browser's keyboard flow beyond the component tests, screen-reader output, the narrow-viewport layout, and reduced motion (the UI has no animations). Async Server Components can't be unit-tested with Vitest, so the pages are thin and covered by the end-to-end run.
- **Timeout change:** the unit project's test timeout is 20 seconds (`vitest.config.mts`). Cold imports of the webhook route and database pool modules took just over Vitest's 5-second default once the jsdom tests joined the suite. No test asserts timing this way, and the Phase 01 test files are unchanged.

### Phase 04 `/review` fixes

- **Validation context (M1):** a pull request with more names or longer links than the stored validation context allowed made every edit decision fail with a 500. The context is now bounded where it is built and checked with one shared schema on save and on read. A database test seeds a PR with 260 exported names and a 4,100-character URL, then records an edit.
- **Unexpected errors (M2):** both review API handlers now return a coded `500 INTERNAL_ERROR` with a request id. Tested with a pool that fails, including that the error text never reaches the response or the logs.
- **Login race (M3):** 20 parallel wrong-password attempts used to be checked all 20 times. Now exactly 5 are checked and 15 refused (database test). A successful sign-in leaves earlier failures counted.
- **Smaller fixes, each with a test:**
  - L1: no "passed validation" claim on an invalid proposal.
  - L2: a separate `PROPOSAL_NOT_VALID` code.
  - L3: sign-out overwrites the cookie with its own options (`actions.test.ts`, which also covers the sign-in cookie flags).
  - L5: focus returns to the button that opened a step, and moves to the success notice.
  - L6: TRUNCATE and UPDATE checks for every protected table.
  - L8: unsupported scrypt parameters are refused without throwing, and `DUMMY_HASH` is a usable hash.
  - L9: same-origin requests without `Origin`; `Origin: null`, other origins and ports; insertion-only and deletion-only diff hunks.
- **Mutation checks:** each of the 10 fixes was reverted in turn, and every one was caught. For M1 the producer-side caps were removed, because changing a limit on both sides at once is consistent by design.
- **Counts:** `npm test` 615 passed, `npm run test:db` 46 passed.

### Phase 04 `/security-check` fixes

- **M-A (sign-in flood):** malformed usernames are refused without scrypt or database work (a timing test plus "no row recorded"). At most 4 concurrent sign-ins per process; extra ones are refused as busy (10 parallel give 4 checked and 6 busy). A new `attempted_at` index for pruning.
- **Race test:** rewritten as waves of 4 concurrent attempts, because the concurrency cap now limits in-process parallelism. Without the per-username lock, the second wave would all be checked.
- **L-A, L-C (privileges):** permission-denied checks for UPDATE and DELETE on proposals and candidates, and for UPDATE of `expires_at` and other session columns and DELETE on `sessions`.
  - Removing UPDATE broke the decision row lock (`FOR UPDATE` needs UPDATE privilege); the DB tests caught it, and the lock was dropped in favour of immutability plus the unique constraint.
- **L-B:** accepting a stored patch that no longer validates is refused with `PROPOSAL_NOT_VALID` and its issues.
- **L-E:** sign-in and sign-out log events, with no username or password.
- **L-F:** eight blank-rendering code points are marked in the UI and rejected in added lines and paths.
- **L-G:** HSTS in production only.
- **Mutation checks:** 10 (including both migration revokes, with the test schema reset before and after), all caught.
- **Production-mode end-to-end run (`npm run build` + `next start`):**
  - the full review flow passed;
  - cache headers on pages and the API, HSTS, and the `__Host-` cookie with `Secure` were verified.
- **Counts:** `npm test` 634, `npm run test:db` 49.
