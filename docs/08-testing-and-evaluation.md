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

## Phase 05 tests (implemented)

GitHub is mocked at the `fetch` level by `src/test/fake-github.ts`: an in-memory repository with commits, trees, blobs, branches and PRs, GitHub's status codes for the cases the write path depends on (404 refs, 409 conditional writes, 422 existing branch or PR), and fault injection (a status, a timeout, a redirect, or a request that takes effect while its response is lost). The real writer, both guard layers, the real token minting through `@octokit/auth-app` (a test RSA key) and the test database run against it. **No live GitHub App was used.**
- **Writer (`src/lib/github/writer.test.ts`, 36 tests):**
  - writes disabled, at open and after the token was minted;
  - a fresh token per operation, revoked;
  - four token-scope mismatches;
  - 409/422 mapping;
  - the tree walk and truncation;
  - redirects;
  - 22 guarded requests refused with zero requests sent;
  - the fetch layer and the hook layer each tested on their own;
  - no token or GitHub message in logs.
- **PR content (`pr-content.test.ts`, 11 tests):**
  - code spans and fenced blocks round-trip hostile values under CommonMark's rules;
  - after removing code, the body has no interpreted links, HTML, mentions or references except the source PR;
  - autolinks are github.com only;
  - a failing rationale is withheld;
  - the display name is shown, never the username;
  - the cap uses whole blocks;
  - title and commit message are neutralized.
- **Publish (`publish.db.test.ts`, 44 tests):**
  - **Happy path:** one branch at the head, one commit with exactly the approved content, a PR into the source head branch with `maintainer_can_modify: false`, the token revoked, the attempt recorded.
  - **Duplicates:** a repeated request makes no GitHub call; concurrent requests make one PR.
  - **15 refusals with no GitHub request and no output row:**
    - writes disabled;
    - no decision, rejected, requester without grant;
    - decider disabled or ungranted;
    - echo mismatches, extra body fields;
    - tampered hash, chain mismatch;
    - forged stored base, invalid patch;
    - installation not allowed, no branch names;
    - plus fixture data.
  - **13 changed GitHub states, each refused without writing the document and not retried:**
    - closed, moved head, retargeted;
    - fork, deleted fork, repository id;
    - changed blob, symlink, non-tree directory;
    - truncated tree;
    - blob bytes not hashing to the id, BOM bytes;
    - 409 on the PUT.
  - **Resume:** timed-out commit, lost commit response (adopted after `compare`), failed and lost PR creation.
  - **Branch tampering:** extra commit, a lost commit that changes another file, a PR by someone else.
  - **Leases and limits:** lease lost, lease held by another attempt, the attempt limit.
  - **Grants:** migration 0005 denies app-role updates to repository identity and output bindings, and deletes. The webhook-style update still works.
  - **Refs backfill:** branch names filled on a webhook-created PR row.
- **Live docs (`src/lib/github/docs.test.ts`, 8 tests):**
  - allowed paths only, read at the head;
  - symlinks and submodules refused without fetching;
  - BOM, NUL and invalid UTF-8;
  - blob id mismatch;
  - truncated tree and oversized docs;
  - malformed tree.
- **Route (`api-create-pr.test.ts`, 10 tests):**
  - 503 before the session is read;
  - cross-site, unauthenticated, oversized and malformed bodies never reach publishing;
  - code-to-status mapping with ids logged;
  - 201 and 200;
  - a coded 500 that hides the error.
- **UI:**
  - `CreatePrPanel`: the confirmation shows hashes, the diff and marked hidden characters, then sends exactly the echo; errors show code and message; a non-GitHub URL is never linked; Escape cancels.
  - `ReviewView`: the button appears only for accepted or edited live data with writes enabled and branch names; fixture, disabled, no-refs, rejected and already-opened states are explained.
- **Phase 04 follow-ups:**
  - **Session cap:** the 11th sign-in revokes the oldest (DB).
  - **Code-only errors:** an unexpected error in the sign-in action logs only `INTERNAL_ERROR`.
  - **Operator commands:** smoke-tested on the dev database.
- **Mutation checks:** 20, all caught, covering:
  - the writer: writes flag, hook allowlist, fetch-layer host, redirect refusal, token scope;
  - publish: decider standing, echo, chain, H1 blob check, stale head, adoption limits, bot-only adoption, the progress lease, the claim lease, token revocation;
  - the route's flag check, code-span fence length, symlink refusal, the UI's link check;
  - the migration 0005 repository revoke (test schema reset before and after).
  - The claim-lease mutation was first missed, because the retry interval also blocked the duplicate. A test where only the lease blocks was added.
- **Production-mode end to end (`npm run build` + `next start`):**
  - writes off gives 503 `WRITES_DISABLED` with `no-store`;
  - the review page shows the fixture explanation and no button;
  - writes on gives 409 `FIXTURE_NOT_WRITABLE` for fixture data, 403 cross-site and 401 without a session;
  - no output rows were created.
- **Counts:** `npm test` 704, `npm run test:db` 94.

### Phase 05 `/review` fixes

- **M1 (token revocation after the deadline):**
  - the fake GitHub now rejects requests whose signal is already aborted, as `fetch` does;
  - a test fires the operation's deadline and still sees the token revoked.
- **M2 (retargeted PR):** a PR retargeted without a new commit can be analysed and decided again, and then published. The first decision keeps `PR_RETARGETED`, and the branch names on the PR row are refreshed.
- **M3 (failure classification):**
  - **Unusable responses:** an unusable `PUT` or PR-create response is `GITHUB_AMBIGUOUS` and is retried. The retry adopts the commit through `compare`, or the bot's PR. The fake can now return a body of the test's choosing after a request takes effect.
  - **Token and PR refusals:** a refused token request is `GITHUB_TOKEN_REFUSED` and succeeds on retry. A refused PR creation is `PR_CREATE_REFUSED` and is not retried.
  - **API message:** the route tells retryable and terminal 502s apart.
- **M4 (claims without tests):**
  - **Token client:** 5 tests where it refuses another endpoint, another installation, more permissions, an unscoped token and a repository write before sending.
  - **Method list:** a test pins the writer's methods (no merge, delete or generic request).
  - **H1 wording:** corrected in docs/13 and docs/07. A forged stored base is `PATCH_INVALID` via `validatePatch`'s hash check. GitHub bytes that don't hash to the id are `APPROVAL_TAMPERED`. The text-equality clause is defence in depth. The earlier "H1 blob check" mutation was caught through the hash clause.
- **L1:** an unexpected error after the claim releases the lease and records `INTERNAL_ERROR` (retryable); the attempt-log insert now sits inside the guarded block.
- **L2:** a branch that couldn't be created is not recorded as `branch_created`.
- **L4:** an opened PR is returned even after its approver was disabled. An adopted PR reports `created: false`.
- **L5:** a missing App slug fails before any attempt or token. The route answers `503 WRITES_MISCONFIGURED` without publishing or logging the setting.
- **L10:**
  - the route's 415;
  - a terminal code reported ahead of the attempt limit;
  - a deleted docs branch after the commit gives `BRANCH_CONFLICT`;
  - plus the M1–M3 tests above.
- **Mutation checks for the fixes:** 7, all caught: revocation without the deadline, ref refresh, `GITHUB_AMBIGUOUS` and `GITHUB_TOKEN_REFUSED` retryable, `PR_CREATE_REFUSED`, branch confirmation, opened PR first.
- **Counts:** `npm test` 715, `npm run test:db` 105.

### Phase 05 `/security-check` fix (M-1)

- **Push races** (the fake GitHub can now run a push just before a request):
  - a push just before our commit makes GitHub commit on top of it, which is refused (`BRANCH_CONFLICT`) and not recorded;
  - a push just before PR creation gives `PR_HEAD_MISMATCH`, not recorded, terminal.
- **Recorded commit:** a recorded commit that isn't exactly ours fails the `compare` check before any PR.
- **PR body:** names DocuSync's commit.
- **Mutation checks:** 3, all caught (parent check, compare before the PR, created PR head).
- **Counts:** `npm run test:db` 109.

## Phase 06 evaluation and tests (implemented)

- **Held-out dataset `impact-v3`:**
  - 14 scenarios (`fixtures/impact/v3-*.json`), labelled before the engine or model ran on them;
  - label hash `d8b4e802…c25`, recorded in the phase log before the first run;
  - the engine was not changed in response;
  - same author as the engine, so "held-out" means pre-registered, not independent.
- **Deterministic results** (`npm run eval:impact`, `impact-baseline.md`):

  | Scope | TP | FP | FN | TN | Precision | Recall |
  |---|---|---|---|---|---|---|
  | All 35 scenarios | 19 | 2 | 4 | 43 | 90.5% | 82.6% |
  | `impact-v3` only | 7 | 1 | 3 | 17 | 87.5% | 70.0% |

  The `impact-v3` misses are a CLI option rename, a Dockerfile port and a newly added route; the false positive is a generic word.
- **Model-assisted** (`OLLAMA_MODEL=llama3.2:3b npm run eval:llm`, `llm-assisted.md`):
  - **flagging:** identical to deterministic;
  - **patches:** 20 requested, 14 validated, 6 rejected (`EDIT_FIND_NOT_FOUND` 5, `EDIT_FIND_AMBIGUOUS` 3, `EDIT_NO_OP` 1, `NO_CHANGE_FACTS` 1, `PATCH_UNSAFE_HTML` 1);
  - **calls:** 41 model calls, median 2.9 s, p95 7.8 s;
  - **patch labels:** `v3` patches are not labelled.
- **Latency and failures** (`npm run eval:latency`, `impact-latency.md`): 700 timed analyses (35 × 20), median 0.06 ms, p95 0.18 ms, max 1.24 ms, 0 failures (values from the committed report; they vary between runs). Engine only, one laptop.
- **New tests:**
  - **Rate limits:** `rate-limit.test.ts` (2); the 61st decision request and the 11th create-PR request get 429.
  - **Same origin behind a proxy:** `APP_ORIGIN` at the route and in env validation.
  - **`db:check-grants`:** `grants.db.test.ts` (2), including a simulated post-restore re-grant.
  - **L-1:** live reader token scope.
  - **L-2:** hidden characters in PR text.
  - **L3:** resume re-checks the binding.
  - **L6:** step reported and logged.
  - **L7:** focus while pending, after an error and after success.
  - **L8:** partial analysis, in the fetcher, the DB and the view.
  - **L-3:** early exit for terminal and locked outputs.
- **How the process checks are evidenced:** the mutation runs, the Linux CI mirror, the deployment, fresh-setup and restore checks, and the screenshot capture were run during the session. Their results are recorded here and in `progress/PHASE-LOG.md`, but their raw logs are not committed. Treat them as observed, not reproducible artifacts, except the screenshots and the `docs/evaluation/` reports, which are committed outputs.
- **Mutation checks (Phase 06):** 12, all caught (observed locally):
  - the create-PR and decision limits, and the limiter logic;
  - early exit and the resume binding check;
  - PR-text markers;
  - `APP_ORIGIN` use and its validation;
  - the grants checker;
  - the partial flag, panel focus and the live token scope.
  - Not mutation-checked, because they live in scripts: the L-1 comparison in `analysis-run.ts` and the L9 transaction in `reviewer.ts`. Both were smoke-tested by hand.
- **CI and operations:**
  - **CI mirror:** the full pipeline ran in Linux containers matching `.github/workflows/ci.yml`, and GitHub Actions passed on `ff5222e`.
  - **Fresh setup:** verified on a new volume.
  - **Backup and restore:** verified, which found and fixed the default-privilege re-grant.
  - **Reference deployment:** verified with Docker (docs/10).
  - **Screenshots:** captured with Playwright (docs/11).
- **Counts:** `npm test` 742, `npm run test:db` 116.

### Phase 06 `/review` fixes

- **M1 (`db:check-grants` coverage):**
  - It now checks:
    - whole-table privileges, including UPDATE on `repository_reviewers` and UPDATE/DELETE on `schema_migrations`;
    - every column of the column-restricted tables, read from `information_schema`;
    - TRUNCATE on every table;
    - TEMPORARY on the database and CREATE on schema public.
  - `grants.db.test.ts` has 6 tests, including a column-level and a database-level case.
  - **Restore re-verified:** straight after a restore the check failed with "app role has TEMPORARY on the database" (`pg_dump` without `--create` drops it), and after the documented `REVOKE TEMPORARY` step it reported OK.
- **M2 (claims):**
  - **Data-driven report text:** `llm-assisted.md` now states its real scenario count, and the baseline's limits list the adversarial scenarios from the data (4).
  - **Model re-run:** `eval:llm` was re-run. Counts are unchanged; latency is now median 2.9 s, p95 7.8 s.
  - **Latency maximum:** corrected to 1.24 ms.
  - **CI wording:** says which tests have run in GitHub Actions and which haven't yet.
  - **Process evidence:** labelled as observed, with logs not committed.
- **M3:** `*.dump`, `*.backup` and `*.sql.gz` are git- and docker-ignored, and the documented dump path is outside the repository.
- **L1:** the serving Ollama has no route out. A one-shot `ollama-pull` service does the downloads; the compose config validates, but it was not pulled or run.
- **L2:** `APP_ORIGIN` is normalized (case, default ports), and an invalid value gives `503 CONFIG_INVALID`, logged by code only. Tested in env and on both routes.
- **L3:** `.dockerignore` now matches `.gitignore`'s secret entries.
- **L5:** the init script's body runs in a subshell. When sourced, it fails cleanly without leaking `set -u` (checked in a `postgres:16-alpine` container). Percent-encoding is documented.
- **L7:** an unparseable `OLLAMA_BASE_URL` gives the key-only env error (tested).
- **Mutation checks:** 7 more, all caught: database TEMPORARY, every column, schema CREATE, `CONFIG_INVALID`, `APP_ORIGIN` normalization, the Ollama URL guard, the adversarial count. Not mutation-checked: the `llm-assisted.md` scenario count (no test renders that report).
- **Deployment re-verified** with all fixes: healthy, `db:check-grants` OK, only the proxy published, no route out, the placeholder password refused, session and origin behaviour as before.
- **Counts:** `npm test` 748, `npm run test:db` 120, also in the Linux CI mirror.

### Phase 06 `/security-check` fixes

- **M-A (public surface):** the reference Caddyfile now has a webhook-only public site and a private reviewer-UI site. Deployment re-verification:
  - **Public site:** 404 for `/login`, `/api/health`, `/api/reviews/…` and `/`; an unsigned webhook reaches the app (503 `NOT_CONFIGURED`, no secret set).
  - **UI site:** health 200 with HSTS; a session reaches the database; the same-origin PATCH passes; PATCHes from the public origin and from `evil.example` get 403.
- **L-1 (secrets in images):**
  - **The fix:** the Dockerfile copies an explicit list, and `.dockerignore` uses `**/` patterns.
  - **The check:** dummy secret files were planted in nested folders while both images were rebuilt. None were found in either image, and a positive control confirmed the search works.
  - **Found along the way:** the first check had inspected a stale migrate image, because `up --build` skips profile services. The docs and the verification now use `run --build`.
- These are manual verifications with Docker. Their logs are not committed.

### Phase 06 `/security-check` fixes, round 2

- **L-2 (`db:check-grants`):** 2 new DB tests; a single-column INSERT on `reviewers` and a single-column UPDATE on `patch_proposals.patch_text` are reported. Reverting the fix makes both fail (mutation check).
- **L-3, L-5 (deployment init):** with the unedited env examples, init refused with its message. After the automatic restart, the app role was refused with both the committed placeholder and the `REPLACE_…` value.
- **L-6 (screenshot script):** a temporary live-labelled analysis was refused with `NOT_FIXTURE_DATA`. No decision was recorded and no file written. The screenshots were then re-captured from fixture data and checked by eye.
- **Info:** browser sign-in through the private UI site was verified with Playwright, with and without a spoofed `X-Forwarded-Host`.
- **Full deployment re-check:** passed again with all fixes.
- **Counts:** `npm test` 748, `npm run test:db` 122, also in the Linux CI mirror.
