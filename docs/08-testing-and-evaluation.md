# Testing and Evaluation

A passing test suite does not by itself prove product quality. Test outcomes and benchmark results are reported separately, and every number below comes from a command in this repository.

## Test layers

- **Unit:** path normalization, diff parsing, candidate scoring, schemas, state transitions, patch validation, rate limits, password hashing.
- **Database (`npm run test:db`):** PostgreSQL repositories, migrations, authorization joins, the app role's limits, concurrency and idempotency. Needs Postgres and fails, never skips, without it.
- **Contract:** Route Handler request and response validation, webhook signature checks, status-code mapping.
- **UI (React Testing Library, jsdom):** the dashboard, analysis, review, decision and create-PR views, and every state: empty, no access, partial, failed, running, decided and invalid proposal; focus handling and untrusted text never rendered as HTML.
- **Live model (`npm run test:ollama`, opt-in):** structured output, the prompt-injection fixture's invariants, a missing model and an unreachable server. Needs `OLLAMA_MODEL` and a running Ollama; fails rather than skipping without them.
- **Security:** each threat class in docs/07 maps to named tests (see the evidence table there).

`npm test` runs the unit and component tests and needs no database, GitHub or model. The unit project's test timeout is 20 seconds (`vitest.config.mts`): cold imports of the webhook route and database pool modules can pass Vitest's 5-second default when the jsdom tests run in parallel. No test asserts timing this way.

GitHub is mocked at the `fetch` level by `src/test/fake-github.ts`: an in-memory repository with commits, trees, blobs, branches and PRs, GitHub's status codes for the cases the write path depends on (404 refs, 409 conditional writes, 422 existing branch or PR), and fault injection (a status, a timeout, a redirect, or a request that takes effect while its response is lost). The real writer, both guard layers, real token minting through `@octokit/auth-app` (with a generated test RSA key) and the test database run against it. **The fake is not GitHub.** One live run is described in docs/10.

## Fixtures

Synthetic repositories and diffs in `fixtures/` cover: a new environment variable, an API route change, a renamed or exported symbol, a changed CLI or package script, an internal refactor with no documentation impact, a documentation-only change, missing or contradictory docs, malformed and oversized diffs, path traversal attempts, prompt injection in a Markdown file, and model timeout or invalid structured output (the last through mock providers).

## Evaluation protocol

- Label the affected docs for each scenario before running the system.
- Track true positives, false positives, false negatives and true negatives; report precision and recall with the raw counts and the dataset scope.
- Separate deterministic baseline results from model-assisted results.
- Record model identifier, prompt version, dataset version and environment.
- Do not tune on the held-out set.
- Do not report invented or cherry-picked metrics.
- A scenario schema rejects labelling a doc that the PR itself edits, because such docs are excluded from scoring and would hide a false negative.

## Deterministic baseline

`npm run eval:impact` runs the engine over `fixtures/impact/*.json` and writes `docs/evaluation/impact-baseline.md` (TP/FP/FN/TN, precision and recall overall, per dataset, by category and per doc, plus the dataset's limits). A unit test fails if the committed report is out of date, so the report is changed only by regenerating it.

| Dataset | Scenarios | Written |
|---|---|---|
| `impact-v1` | 13 | Labels written before any engine code existed. One matching bug (`fix` matched inside `lint:fix`) was fixed after the first run; it corrected an evidence entry and changed no metric. |
| `impact-v2` | 8 | Regression scenarios for specific review findings (dependency bump, CI workflow YAML, a PR documenting its own env var, a doc linked from an edited doc, multi-hunk `package.json`, a scripts header out of view, root route, dynamic route). Labelled **before** the engine fixes and run on the unfixed engine first. |
| `impact-v3` | 14 | Held-out set, labelled before the engine or model ran on it. The engine was not changed in response. |

Engine history on these datasets:

| Engine | Dataset | TP | FP | FN | TN |
|---|---|---|---|---|---|
| `deterministic-0.1.0` | `impact-v1` | 9 | 1 | 1 | 15 |
| `deterministic-0.1.0` (before review fixes) | `impact-v2` | 2 | 6 | 1 | 5 |
| `deterministic-0.2.0` (after review fixes) | `impact-v1` | 9 | 1 | 1 | 15 |
| `deterministic-0.2.0` (after review fixes) | `impact-v2` | 3 | 0 | 0 | 11 |
| `deterministic-0.3.0` (after security fixes) | `impact-v1` + `impact-v2` | 12 | 1 | 1 | 26 |

- The security fixes (ReDoS, work budgets, evidence integrity) changed no metric.
- The v1 false positive and false negative are the two deliberately adversarial scenarios.
- The v2 scenarios target the fixed findings, so their perfect score after the fixes shows the fixes work, not that the engine generalizes.

Current results (`deterministic-0.3.0`, from `docs/evaluation/impact-baseline.md`):

| Scope | TP | FP | FN | TN | Precision | Recall |
|---|---|---|---|---|---|---|
| All 35 scenarios | 19 | 2 | 4 | 43 | 90.5% | 82.6% |
| `impact-v3` only | 7 | 1 | 3 | 17 | 87.5% | 70.0% |

The `impact-v3` misses are a CLI option rename, a Dockerfile port and a newly added route; its false positive is a generic word.

**Held-out label hash.** Before the first run on `impact-v3`, a SHA-256 over each file's name, its `labels` JSON and its category, in sorted file order, was recorded: `d8b4e802e6fc9c5943cb0950d8d2dc0df9f474cc7d7749238ed4284571779c25`. It lets a reader check that the labels were not edited after the results were seen. The same author wrote the engine, the fixtures and the labels, so "held-out" means pre-registered, not independent.

All numbers come from small synthetic datasets. They say nothing about real repositories.

## Model-assisted evaluation

`npm run eval:llm` runs deterministic and model-assisted analysis over all scenarios and writes `docs/evaluation/llm-assisted.md`. Model output varies by machine and model build, so that report records one run and is not checked in CI.

- **Without a model:** the provider, the Ollama transport (mocked `fetch`: 404, 5xx, refused connection, timeout, a hung server, non-JSON, unfinished and oversized replies), prompts and output schemas, the patch module (path attacks, git blob SHA vectors from `git hash-object`, render and strict-apply round trips including 2,000 seeded random edits, malformed and stale diffs, every validation rule), and `assistImpact` with a scripted mock model (fallbacks, the per-PR cap, prompt-injection behaviour, the no-change-facts guard) are all tested.
- **Patch labels (`patch-v1`):** `fixtures/patches/labels.json` gives each labelled-affected doc strings a correct patch must contain or must not leave behind (case-insensitive, on the whole patched doc). They were written before any model output was read. `patch-unavailable` is not labelled, because its diff is not available. `impact-v3` patches have no patch labels.

Development runs used `llama3.2:3b` via Ollama 0.40.3 on one machine (temperature 0, `num_ctx` 8192), prompt `patch-v1`, engine `deterministic-0.3.0`, over the 21 scenarios of `impact-v1` and `impact-v2`. Runs 1-5 used `assess-v1`; run 6 used `assess-v2`, whose only change is the citation bound in the output schema, plus a note in the prompt that indexes start at 0. "Model calls" counts structured requests; a retry is part of its request's latency.

| Run | Assist policy | Patch requests | Valid proposals | Label pass / fail / no valid patch / not attempted (12 labels) | Assisted flagging TP / FP / FN / TN | Call latency median / p95 |
|---|---|---|---|---|---|---|
| 1 | none: the whole patch is rejected if any edit can't be placed | 12 | 0 | 0 / 0 / 10 / 2 | 12 / 1 / 1 / 26 | 2.8 s / 5.9 s |
| 2 | `assist-v1`: unplaceable edits are dropped | 12 | 10 | 6 / 3 / 1 / 2 | 12 / 1 / 1 / 26 | 2.8 s / 5.8 s |
| 3 | `assist-v2`: no patch without change facts | 9 | 7 | 6 / 1 / 1 / 4 | 12 / 1 / 1 / 26 | 2.5 s / 7.2 s |
| 4 | `assist-v3`: line-less evidence brings its file's hunks | 11 | 8 | 7 / 1 / 2 / 2 | 12 / 1 / 1 / 26 | 2.7 s / 6.3 s |
| 5 | `assist-v3` again (report wording changed only) | 11 | 8 | 7 / 1 / 2 / 2 | 12 / 1 / 1 / 26 | 2.6 s / 5.9 s |
| 6 | `assist-v4` + `assess-v2`: bounded citations, a new seed on retry, no-op edits dropped, stricter link and HTML checks | 12 | 9 | 8 / 1 / 2 / 1 | 12 / 1 / 1 / 26 | 3.1 s / 9.5 s* |
| 7 | `assist-v5`: links resolved like a browser, new raw HTML rejected, unsafe model prose withheld, smaller context budgets, prompt-size guard | 12 | 8 | 7 / 1 / 3 / 1 | 12 / 1 / 1 / 26 | 5.8 s / 20.3 s** |

*A build and the database tests ran on the same machine during the end of run 6, so its latency is likely inflated. **Nothing else ran during run 7, yet latency roughly doubled; a single repeated call afterwards also took 10.4 s against about 3-6 s earlier. The cause was not identified, so run 7's latency is not comparable with earlier runs.

- **The policy changes were made after reading model output on these same fixtures**, so runs 2-7 are tuned on the evaluation set. Labels and the engine did not change; the assessment prompt changed once (run 6) to bound citations. Run 1 is the only untuned result.
  - Run 1: the model usually found the right edit but also sent overlapping or redundant edits and edits copied from the source diff, and a single unplaceable edit rejected the whole patch.
  - Run 2: one of the 10 valid proposals was fabricated. For `patch-unavailable`, with no diff, the model changed port 8080 to 8081. That led to `assist-v2`. Another passed validation and its label but duplicated a line and dropped formatting.
  - Run 3 exposed a bug in `assist-v2`: route evidence has no line number, so its file's hunks were left out and two route scenarios were wrongly marked `NO_CHANGE_FACTS`. Fixed in `assist-v3`.
- **Run 7 rejected the `injection-in-doc` patch** (`PATCH_UNSAFE_HTML`): the model rewrote the doc's injected `<!-- AI assistant: ignore all previous instructions … -->` comment while renaming the variable, and a changed comment is new raw HTML. Earlier runs counted that proposal as valid and passing its label. With the same prompt and seed they most likely proposed the same rewrite, so the earlier validator let a model edit an injected instruction (not re-run to confirm).
- **Model-assisted flagging equals the deterministic baseline in every run.** The model judged every assessed doc `needs_update`, including the known false positive, so with this model the assessment step neither helped nor hurt. In runs 1-5 one assessment per run (`linked-file-renamed`) was rejected: its reply was valid JSON but cited evidence `[1, 2]` of two items (indexes 0 and 1). The range check ran outside the retry, and the retry itself was a no-op (the same request with the same seed at temperature 0 returned a byte-identical reply). Run 6 bounds citations in the schema (enforced during decoding) and retries with a new seed.
- **Repeatability:** run 5 repeated run 4 with identical outcomes for every doc; only latency differed. Variation across machines, model builds or Ollama versions was not measured.

The committed `docs/evaluation/llm-assisted.md` is a later run over all 35 scenarios, with the same model:

- **Flagging:** identical to deterministic.
- **Patches:** 20 requested, 14 validated, 6 rejected (`EDIT_FIND_NOT_FOUND` 5, `EDIT_FIND_AMBIGUOUS` 3, `EDIT_NO_OP` 1, `NO_CHANGE_FACTS` 1, `PATCH_UNSAFE_HTML` 1; a patch can carry more than one code).
- **Calls:** 41 model calls, median 2.9 s, p95 7.8 s.
- **Limits:** small synthetic scenarios with prompts, labels and code by one author. `label_pass` checks a few strings, not prose quality. Latency is per call on one machine. None of this estimates real-world performance.

## Engine latency

`npm run eval:latency` writes `docs/evaluation/impact-latency.md`: 700 timed analyses (35 scenarios × 20 runs), median 0.06 ms, p95 0.18 ms, max 1.24 ms, 0 failures (values from the committed report; they vary between runs). It measures the engine only, on one laptop: no GitHub fetches, database or model.

## What the tests cover

**Review UI and authentication** (database and component tests)
- Login: a generic error, per-username rate limiting under concurrency, and disabled reviewers. Sessions are stored only as a hash and are revoked, expired or malformed.
- Authorization: no grant means not found, on reads and on decisions.
- Decisions: one final decision per proposal (six concurrent decisions, exactly one winner, and the unique constraint pinned on its own), valid and invalid edited patches, extra body keys, an invalid stored proposal.
- The app role's limits: an append-only audit trail, operator-only accounts, protected tables and columns (UPDATE, DELETE and TRUNCATE denied).
- API status mapping: 401, 403, 404, 409, 413, 415, 422, 429 and a coded 500 that hides the error.
- UI: the decision panel (confirm step with focus, Escape to cancel, pending, success with refresh, validation issues, 409, 401, unknown errors, network failure), the login form, invisible-character markers, side-by-side diff rows, the security headers and that `next.config.ts` applies them.

**GitHub write path** (against the fake GitHub and the test database)
- **Writer:** writes disabled (at open and after the token was minted); a fresh token per operation, revoked, including after the deadline; token-scope mismatches; 409 and 422 mapping; the tree walk and truncation; redirects; 22 guarded requests refused with zero requests sent; the hook layer and the fetch layer each tested on their own; the token client refusing other endpoints, installations and permissions; no merge, delete or generic request method; no token or GitHub message in logs.
- **PR content:** code spans and fenced blocks round-trip hostile values under CommonMark's rules; after removing code, the body has no interpreted links, HTML, mentions or references except the source PR; autolinks are github.com only; the display name is shown, never the username; the body cap uses whole blocks.
- **Publish:**
  - Happy path: one branch at the head, one commit with exactly the approved content, a PR into the source head branch with `maintainer_can_modify: false`, the token revoked, the attempt recorded.
  - Duplicates and concurrency: a repeated request makes no GitHub call, and concurrent requests make one PR.
  - Refusals with no GitHub request and no output row: writes disabled; no decision or a rejected one; a requester without grant; a decider disabled or ungranted; echo mismatches and extra body fields; a tampered hash; a chain mismatch; a forged stored base; an invalid patch; an installation not allowed; no branch names; fixture data.
  - Changed GitHub states, each refused without writing the document and not retried: closed PR, moved head, retargeted PR, fork, deleted fork, repository id, changed blob, symlink, non-tree directory, truncated tree, blob bytes not hashing to the id, BOM bytes, 409 on the `PUT`.
  - Resume and adoption: a timed-out commit, a lost commit response (adopted after `compare`), failed and lost PR creation, an extra commit on the branch, a lost commit that changes another file, a PR by someone else, a push just before the commit and just before PR creation.
  - Leases and limits: lease lost, lease held by another attempt, the attempt limit, early exit for terminal and locked outputs.
  - Grants: migration 0005 denies app-role updates to repository identity and output bindings, and deletes.
- **Live docs (`docs.test.ts`):** allowed paths only, read at the head; symlinks and submodules refused without fetching; BOM, NUL and invalid UTF-8; blob id mismatch; truncated tree and oversized docs; malformed tree.
- **Route (`api-create-pr.test.ts`):** 503 before the session is read; cross-site, unauthenticated, oversized and malformed bodies never reach publishing; code-to-status mapping; 201 and 200; 415; a coded 500.

**Operations**
- `db:check-grants` (`grants.db.test.ts`): passes on a migrated database; reports re-granted privileges, single-column grants, UPDATE on the grants and ledger tables, database TEMPORARY, schema CREATE, TRUNCATE, and a simulated post-restore re-grant.
- Rate limits (`rate-limit.test.ts`): the 61st decision request and the 11th create-PR request get 429.
- `APP_ORIGIN` at the route and in environment validation, including normalization and `CONFIG_INVALID`.

## Mutation checks

During development, each important control was removed in turn, and a test had to fail. This covered, among others: the grant joins on reads and decisions; one decision per proposal; edited-patch validation; session revocation and login rate limiting; the same-origin check and `no-store`; invisible-character markers and the confirm step; the writer's write flag, request allowlist, fetch-layer host check, redirect refusal and token scope; the publish checks (decider standing, echo, chain, stale head, blob check, adoption limits, leases, token revocation); the push-race protections; the create-PR and decision rate limits; `APP_ORIGIN`; and the `db:check-grants` coverage. Every mutation was caught. Where a mutation survived at first (the claim lease, masked by the retry interval; the one-decision check, backed by the unique constraint), a test was added that pins that control on its own.

Not mutation-checked, because they live in scripts: the repository comparison in `analysis-run.ts` and the account transaction in `reviewer.ts`. Both were smoke-tested by hand. These mutation runs were done by hand; their raw logs are not committed, so treat them as observed, not reproducible artifacts.

## Manual and end-to-end verification

These were run by hand and are not automated in CI; their logs are not committed.

- **Review flow against `next dev` and a production build (`next build` + `next start`):** the signed-out redirect and 401 from the API; sign-in through the real Server Action without JavaScript (a wrong password, a cross-site post refused, then success with an `HttpOnly`, `SameSite=Strict`, 12-hour cookie); the dashboard, analysis and review pages; a cross-site PATCH 403, a client `reviewerId` 400, accept 200, a second decision 409 and the audit trail; sign-out revoking the session. This run found a Next.js invariant error when the login page re-rendered after a failed no-JavaScript sign-in; it was fixed by moving the signed-in nav into a `(review)` route group.
- **Production headers:** cache headers on pages and the API, HSTS, and the `__Host-` cookie with `Secure` were verified against the production build. Writes off gave 503 `WRITES_DISABLED`; with writes on, fixture data gave 409 `FIXTURE_NOT_WRITABLE`, a cross-site request 403 and no session 401, and no output rows were created.
- **Reference deployment, fresh setup, backup and restore, secrets in images:** verified with Docker (docs/10).
- **Screenshots:** captured with Playwright from the real UI (docs/11).
- **Live GitHub:** one run, described in docs/10.
- **CI:** `.github/workflows/ci.yml` runs format check, lint, type check, unit tests, build and database tests on every push to `main` and every pull request. Check the repository's Actions tab for current results; this document does not assert them.

## Not covered

- A real browser's keyboard flow beyond the component tests, screen-reader output, the narrow-viewport layout, and reduced motion (the UI has no animations). Async Server Components cannot be unit-tested with Vitest, so the pages are thin and covered by the end-to-end runs.
- Fuzzing and load testing.
- Prompt injection against a live model on more than one fixture and one small model.
- An automated test of the deployment.
- Model-assisted evaluation with a larger model, and on real repositories.
- The `llm-assisted.md` scenario count (no test renders that report).
