# Handoff — Phase 06: Evaluation, hardening and demo

- Date: 2026-10-13
- Status: PASS (confirmed by the user 2026-10-13). All Phase 06 tasks are implemented. `/review` is done (M1–M3, L1–L3, L5, L7 fixed), and `/security-check` is done (M-A, L-1, L-2, L-3, L-5, L-6 and the cheap Info items fixed; L-4 and the rest documented). Every local check passes, and GitHub Actions PASS on `dacb02e` (run 38354197107, all steps green).
- Branch: `main`, remote `origin` (github.com/PrathmeshNikhare/DocuSync-AI)
- HEAD commit: `dacb02e` (Phase 06, pushed), on top of `ff5222e` (CI fix). The PASS record is a follow-up commit.
- Working tree: clean apart from ignored local files `.env`, `.env.local`.
- Active phase after handoff: none; Phase 06 is the last phase in `phases/`. Wait for user direction.

## Outcome

DocuSync AI's evaluation is now reproducible and reports its dataset scope:
- **Held-out set:** a pre-registered `impact-v3` set.
- **Reports:** precision and recall per dataset with raw counts, latency and failure counts, and a model-assisted comparison.

Every security threat class in the spec maps to passing tests, and CI runs green on GitHub for the first time since Phase 00. A reference private-network deployment, a backup and restore procedure, and real screenshots of the review flow were each verified locally. Verifying them found and fixed four real problems:
- **CI never installed:** Windows lockfile.
- **Restores re-granted** the app role's restricted privileges.
- **The deployment's app-role password stayed at the placeholder.**
- **Every request through the TLS proxy was refused as cross-origin.**

## Files changed

- **CI:**
  - `package-lock.json` (regenerated on Linux, twice);
  - `src/lib/review/auth.ts` (cookie read before the pool; commit `ff5222e`).
- **Evaluation:**
  - `fixtures/impact/v3-*.json` (14);
  - `scripts/eval-latency.ts`;
  - `src/lib/impact-engine/evaluate.ts` (the limits note);
  - `docs/evaluation/*.md` (regenerated);
  - `package.json` (`eval:latency`).
- **Security and the Low items:**
  - `src/lib/review/rate-limit.ts` (+ test), `api.ts` (limits, `APP_ORIGIN`);
  - `publish.ts` (early exit, binding re-check, step);
  - `pr-content.ts` (markers);
  - `src/lib/github/octokit-reader.ts` (token repository ids), `reader.ts`, `docs.ts` (`partial`);
  - `scripts/analysis-run.ts` (repository check, canonical names, partial);
  - `src/lib/review/store.ts`, `queries.ts`;
  - `src/components/create-pr-panel.tsx` (focus, `PrResultNotice`), `review-view.tsx`, `analysis-view.tsx`;
  - `scripts/reviewer.ts` (transaction);
  - `src/lib/env.ts` (`getAppOrigin`, safer URL checks);
  - `migrations/0006_partial_docs.sql`.
- **Operations:**
  - `src/lib/db/grants.ts` (+ DB test), `scripts/check-grants.ts`;
  - `Dockerfile`, `.dockerignore`, `deploy/` (compose, Caddyfile, init script, env examples);
  - `.gitignore` (`deploy/*.env`).
- **Demo:** `scripts/screenshots.ts`, `docs/screenshots/*.png`, `@playwright/test` 1.63.0.
- **Docs:** 02 (as-built diagram), 03, 04, 07 (Phase 06 controls and the evidence table), 08, 09, 10 (deployment, backup and restore), 11 (recorded walkthrough), 13, INDEX, README (measured results, known limitations, the Windows lockfile note).
- **Progress:** STATUS, PHASE-LOG, DECISIONS (D-014), and dated CI corrections appended to the Phase 00–05 handoffs.

## Verification (final tree)

| Command / check | Result | Status |
|---|---|---|
| `npm run format:check`, `lint`, `typecheck` | clean | PASS |
| `npm test` | 31 files, 748 passed | PASS |
| `npm run test:db` | 6 files, 120 passed | PASS |
| `npm run build` | compiled (also without `DATABASE_URL`) | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities | PASS |
| CI pipeline in Linux containers (`node:24`, `postgres:16-alpine`), mirroring `ci.yml`, re-run after the review fixes | install, format, lint, typecheck, 748 unit, build, app-role setup, 122 DB | PASS |
| GitHub Actions on `ff5222e` | success (first since Phase 00) | PASS |
| GitHub Actions on `dacb02e` (run 38354197107) | all steps green, 748 unit and 122 DB | PASS |
| `npm run eval:impact` | 35 scenarios: TP 19, FP 2, FN 4, TN 43; `impact-v3` P 87.5% R 70.0% | PASS |
| `npm run eval:latency` | 700 analyses, median 0.06 ms, p95 0.18 ms, 0 failures | PASS |
| `OLLAMA_MODEL=llama3.2:3b npm run eval:llm` | flagging identical; 20 patch requests, 14 valid; 41 calls, median 2.9 s, p95 7.8 s | PASS |
| `npm run db:migrate` (dev), `npm run db:check-grants` (dev) | 0006 applied; OK | PASS |
| Fresh setup on a new volume, then `pg_dump` and restore | the fresh database checks clean; the safe restore keeps identical ACLs and passes `db:check-grants`; a plain restore re-granted `UPDATE` (found, documented, now detected) | PASS |
| Reference deployment (`deploy/compose.yml`) | healthy; only the proxy published; Postgres with no route out; the placeholder app password refused over the network; session and DB round trip through the proxy; same-origin and cross-site behaviour correct with `APP_ORIGIN` | PASS |
| Screenshots (`npm run screenshots`) against `next start` | 6 real screenshots, each checked by eye | PASS |
| Phase 06 mutation checks (12 + 7 for the review fixes) | all caught (observed locally; logs not committed) | PASS |
| `/review` | no High; M1–M3, L1–L3, L5, L7 fixed; L4, L6, L8 and Info open | DONE |
| `/security-check` | no High; M-A, L-1, L-2, L-3, L-5, L-6 and the cheap Info items fixed and re-verified; L-4 and the rest documented | DONE |
| Hosted deployment; live GitHub App write; `ollama` container in the deployment | — | NOT RUN |

## Exit criteria (phases/06)

- [x] **Evaluation is reproducible and reports dataset scope:** three generated reports with per-dataset counts, a pre-registered held-out set, and a limits section.
- [x] **All required checks pass or are marked blocked:** local, Linux mirror and GitHub Actions are green. The NOT RUN items are listed above.
- [x] **Security controls have test evidence:** the docs/07 evidence table and 12 + 30 mutation checks.
- [x] **The demo path works end to end or names its mocked steps:** docs/11 recorded walkthrough; the create-PR step is marked as mocked.
- [x] **No fabricated metrics or unsupported claims:** every number cites the command that produced it. An unmeasured claim I drafted ("33 mutation checks") was removed before saving.
- [x] **Final handoff with known limitations and resume-safe measured results:** this file and the README.

## `/review` results and fixes

- **No High findings.**
- **Fixed:**
  - **M1:** `db:check-grants` covers every restriction, including column-level, database TEMPORARY and schema CREATE. The restore procedure re-applies `REVOKE TEMPORARY`. Re-verified: the check failed before that step and passed after it.
  - **M2:**
    - the report text is data-driven (scenario count, adversarial list);
    - `eval:llm` was re-run (model latency now median 2.9 s, p95 7.8 s);
    - the latency maximum is corrected to 1.24 ms;
    - the CI claims are reworded;
    - process evidence is labelled as observed, with logs not committed.
  - **M3:** dumps are ignored by both ignore files and written outside the repository.
  - **L1:** the serving Ollama has no egress; a one-shot pull service does the downloads.
  - **L2:** `APP_ORIGIN` is normalized, and an invalid value gives `503 CONFIG_INVALID`.
  - **L3:** `.dockerignore` matches `.gitignore`'s secrets.
  - **L5:** the init script runs in a subshell (safe when sourced); percent-encoding is documented.
  - **L7:** the Ollama URL guard.
- **Open (not selected):**
  - **L4:** the module-level focus flag can leak if a refresh fails.
  - **L6:** the `impact-v3` pre-registration hash sits in an uncommitted file and covers labels only.
  - **L8:** test gaps:
    - the `REPOSITORY_MISMATCH` half of the L3 re-check;
    - the CLI repository check;
    - storing canonical names.
  - **Info:**
    - a stale header comment in `publish.ts`;
    - docs/13 doesn't mention installation-id changes;
    - an ambiguous commit in `reviewer:add`;
    - `.next` owned by root in the runtime image;
    - no compose hardening;
    - `canonical.owner.login` not checked for emptiness.

## `/security-check` results and fixes

- **No High findings.** The `/review` fixes were verified, except two claims it corrected: M1's "covers every restriction" (see L-2) and L3's "matches .gitignore" (see L-1).
- **Fixed:**
  - **M-A:** the reference proxy publishes only the webhook path, and the reviewer UI moves to a private-only site.
  - **L-1:** an explicit file list in the Dockerfile, plus `**/` patterns in `.dockerignore`.
  - **Re-verified with Docker:**
    - the public site gives 404 for everything except the webhook;
    - no planted secret reached either image, with a positive control;
    - the migrate job uses `run --build`, after a stale image was found in the first check.
- **Fixed in round 2:**
  - **L-2:** `db:check-grants` checks denied SELECT, INSERT and UPDATE with `has_any_column_privilege` (2 new DB tests; mutation caught).
  - **L-3, L-5:** the deployment's own `deploy/initdb/01-app-role.sql` creates the app role `NOLOGIN`, and `02-app-password.sh` grants `LOGIN` only after refusing unset, `REPLACE_…` or short passwords. A failed first start fails closed (verified).
  - **L-6:** the screenshot script refuses non-fixture data before approving, requires https unless local, prints fixed codes only, and writes files only on success (verified on a live-labelled analysis).
  - **Info:**
    - the deployment no longer creates `docusync_test`;
    - the password is read with `\getenv`, not passed as a `psql` argument;
    - Server Action sign-in through the proxy verified, also with a spoofed `X-Forwarded-Host`;
    - `grants.db.test.ts` added to the evidence table.
- **Documented, not fixed** (docs/10 "Known limitations of the reference deployment", README):
  - **L-4:** migrations and operator commands run as the bootstrap superuser, and the app doesn't assert its own role.
  - Ollama has no authentication on the private network.
  - Images are pinned by tag, not digest, and Actions by tag, not SHA.
  - **Residual of L-3:** a failed volume keeps the owner's placeholder password (internal network only); recreate the volume.

## Decisions

D-014: reference deployment only, Playwright screenshots, live GitHub deferred, and the Low items in scope.

## Risks and limitations

- **Intermittent unit test (open):** in 1 of 4 full local `npm test` runs on 2026-10-13, `llm.test.ts` › "times out while reading a body that never ends" hung for the 20 s test timeout although its own timeout is 300 ms. It passed 15/15 alone, 3/3 in later full runs, and in the CI mirror. A forced-GC repro did not reproduce it. The cause is unknown; the test is unchanged.
- **GitHub writes have never run live.** Rulesets (docs/10) are required before enabling them.
- **No runner for webhook-queued analyses (D-009).**
- **Single-instance limits:** the decision and create-PR rate limits are in-process. A per-IP limiter at the proxy is required.
- **The deployment was verified locally only.** No real certificate; Ollama in compose not pulled or run; the `ollama/ollama:0.40.3` tag is unverified.
- **Windows lockfile trap:** any `npm install` on Windows strips Linux-only lockfile entries. Regenerate on Linux (README); CI catches it.
- **Evaluation:**
  - small and synthetic, with the same author for labels and engine;
  - `impact-v3` patches have no patch labels;
  - one model and one run.
- **Accepted risks:** app-DB-role trust (D-013) and the inline-script CSP (D-012).
- **Not built:** MFA, signed decisions, decision expiry, the A→B→A diff pinning.

## Recovery / rollback

- **`ff5222e` and `dacb02e` are pushed.** Revert with `git revert` if needed. Don't force-push.
- **Migration 0006** is applied to the dev and test databases. To roll back locally, run `ALTER TABLE analyses DROP COLUMN docs_partial` as the owner and delete its `schema_migrations` row, or recreate the volume.

## What the next session must verify

- Re-run `npm test`, `npm run test:db` and `npm run build`, and check the latest GitHub Actions run.
- Check `package-lock.json` still has `node_modules/@emnapi/core` and `@emnapi/runtime` before any commit made on Windows.
- No further phase is specified. The open items are the NOT RUN rows above (live GitHub App write, hosted deployment, the `ollama` container), the documented limitations in docs/10, and the intermittent `llm.test.ts` hang. Ask the user which, if any, to take on.
