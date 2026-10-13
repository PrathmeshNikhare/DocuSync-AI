# Handoff — Phase 04: Human review UI

- Date: 2026-10-11 (updated 2026-10-12)
- Status: PASS (user-confirmed 2026-10-12). All local checks PASS, re-run on the final tree before the commit. `/review` done, with M1-M3, L1-L3, L5, L6, L8 and the testable parts of L9 fixed. `/security-check` done, with M-A, L-A, L-B, L-C, L-E, L-F and L-G fixed, L-D documented with an unlock command, and Info 3 verified; the remaining items are recorded as Phase 05 requirements. Committed locally; not pushed.
- Branch: `main` (no remote)
- HEAD commit: the Phase 04 checkpoint commit (the commit containing this handoff; see `git log`), on top of `f9f19a3` (Phase 03 PASS).
- Working tree: clean after the commit (local only, not pushed). Ignored local files: `.env` and `.env.local`.
- Active phase after handoff: 04 is complete; Phase 05 is NOT STARTED and waits for user direction

## Outcome

Reviewers sign in with local accounts and see the repositories they have been granted. They inspect each analysis's documentation candidates, with deterministic evidence, uncertainty and the model's assessment kept apart. On the review page they see the original document and the proposed change side by side, then accept, edit or reject. Each decision is final, validated on the server, bound to the revision and patch hash, and recorded in an append-only audit trail. Nothing is written to GitHub. Analyses come from real pipeline runs over labelled fixtures, marked as fixture data throughout (D-012).

## What was implemented and why

- **`migrations/0003_review.sql`:**
  - persisted candidates and proposals, plus reviewers, sessions, login failures, grants and decisions;
  - `repositories.source` so fixture data has no GitHub ids;
  - app-role restrictions: an append-only `review_decisions`, and operator-only accounts and grants. Details in docs/03.
- **`src/lib/review/`:**
  - `password.ts`: scrypt from `node:crypto`.
  - `session.ts`: login with one generic error, a per-username rate limit, hashed random tokens, revocation.
  - `queries.ts`: every read goes through the reviewer's grant, and JSONB is re-validated on read.
  - `decisions.ts`: one final decision, under a row lock and a unique constraint; edits pass `validatePatch` with the stored context.
  - `store.ts`: saves a fixture run.
  - `api.ts`: route logic with an origin check, body limits, the error envelope and `no-store`.
  - `auth.ts`: the cookie and current-reviewer helpers.
  - `diff-rows.ts`, `visible-text.ts`: pure UI helpers.
- **Pages:** `/login` (a Server Action form that works without JavaScript), and `(review)/` with `/`, `/analyses/[id]` and `/reviews/[id]`. Session reads sit behind `<Suspense>` (Cache Components). There are also `error.tsx` and `not-found.tsx`.
- **API routes:** `GET /api/analyses/[id]`, `GET /api/reviews/[id]`, `PATCH /api/reviews/[id]`.
- **Components (`src/components/`):**
  - dashboard, analysis and review views;
  - evidence and model-assessment blocks;
  - the side-by-side diff;
  - the decision panel (client): confirm steps, focus management, Escape to cancel, every error state;
  - the login form, visible text (invisible characters shown as `U+XXXX` markers), and shared state pieces.
- **Security headers:** `src/lib/security-headers.ts`, applied to all routes by `next.config.ts`. The nonce CSP was dropped for Cache Components (D-012, user choice).
- **Scripts:** `npm run analysis:run -- --fixture <name>`, `npm run reviewer:add`, `npm run reviewer:grant`.
- **Changes to Phase 03 code:**
  - `validatePatch` takes `knownLinks` (computed by `knownLinksIn`) instead of the whole known text, so a proposal can store its link set for validating edits later;
  - `assistImpact` returns each valid proposal's validation context.
  - Behaviour is unchanged: all Phase 03 tests pass, and the baseline is unchanged.
- **Dev dependencies:** `@testing-library/react`, `@testing-library/dom`, `jsdom`, `@vitejs/plugin-react` (approved).

## Files changed

- **Modified:** `README.md`, docs 02, 03, 04, 07, 08, 09 and 10, `next.config.ts`, `package.json`, `package-lock.json`, `vitest.config.mts`, `src/app/layout.tsx`, `src/app/api/webhooks/github/route.test.ts` (timeout only), `src/lib/assist/assist.ts`, `src/lib/db/migrate.db.test.ts`, `src/lib/llm/ollama.ollama.test.ts`, `src/lib/patches/content.ts`, `src/lib/patches/patches.test.ts`, `src/lib/patches/validate.ts`, and the progress files.
- **Moved:** `src/app/page.tsx` → `src/app/(review)/page.tsx`.
- **New:**
  - `migrations/0003_review.sql`;
  - `scripts/analysis-run.ts`, `scripts/reviewer.ts`;
  - `src/app/(review)/{layout.tsx, session-nav.tsx, analyses/[id]/page.tsx, reviews/[id]/page.tsx}`, `src/app/{actions.ts, error.tsx, not-found.tsx, login/page.tsx}`, `src/app/api/{analyses,reviews}/[id]/route.ts`;
  - `src/components/*`;
  - `src/lib/review/*`, `src/lib/security-headers{,.test}.ts`, `src/test/review-seed.ts`;
  - this handoff.

## Checks and outcomes

| Command / check | Outcome | Result |
|---|---|---|
| Phase 03 gate re-check before starting | `f9f19a3`, clean tree | PASS |
| `npm run format:check`, `lint`, `typecheck` | exit 0 | PASS |
| `npm test` | 24 files, 600 passed (run twice) | PASS |
| `npm run test:db` | 4 files, 42 passed | PASS |
| `npm run test:ollama` | 4 passed | PASS |
| `npm run build` | exit 0. `/` and the detail pages are partial prerenders with streamed session content; `/login` is static | PASS |
| `npm run eval:impact` | baseline unchanged | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities | PASS |
| `npm audit` (including dev) | 5 high, all in `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`. Dev-only lint tooling, present before this phase; the only fix is a major downgrade | Recorded |
| Mutation checks (13 controls; docs/08) | all caught. The "one decision" code check survived alone because the unique constraint backs it up; the constraint got its own test and mutation | PASS |
| End to end against `next dev` (Node script; real Server Action without JavaScript) | signed-out redirect; API 401; wrong password gives a generic error; cross-site sign-in refused with no cookie; sign-in 303 with an `HttpOnly`, `SameSite=Strict`, 12-hour cookie; dashboard, analysis and review pages render; cross-site PATCH 403; client `reviewerId` 400; accept 200; second decision 409; audit trail shown; sign-out revokes the session (old cookie 401); all security headers present | PASS (after one fix, below) |
| Final gate re-run before the PASS commit: format:check, lint, typecheck, `npm test` (twice), `npm run test:db`, build, `eval:impact` | all exit 0; 634 unit, 49 DB tests; baseline unchanged. The first re-run hit a 5-second timeout in the pool test (a cold import), the same cause as the earlier webhook test, so the unit project's timeout became 20 seconds | PASS |
| `/review` probes (before fixing) | Zod `.max(200).max(1000)` keeps 200 (M1); scrypt N=2^17 or r=16 throws under 64 MiB (L8); Next's `cookies().delete()` drops `Secure` (L3); 20 parallel wrong logins all checked (M3) | Confirmed |
| After the `/review` fixes: format, lint, typecheck, `npm test`, `npm run test:db`, build, `eval:impact`, `npm audit --omit=dev` | all exit 0; 615 unit, 46 DB tests; baseline unchanged; 0 vulnerabilities | PASS |
| `/review` fix mutation checks (M1 producer caps, M2 coded 500, M3 lock, L1, L2, L3, L5 ×2, L8, L9 origin) | all 10 caught; sources restored | PASS |
| Race probe after the M3 fix | 20 parallel wrong logins give 5 checks and 15 refusals | PASS |
| End to end against `next dev` after the fixes | same results as before; only the expected cross-site sign-in refusals in the log | PASS |
| Security-check probes (before fixing) | the app role could UPDATE and DELETE `patch_proposals`, `impact_candidates` and `sessions` (L-A, L-C); eight blank-rendering code points were neither marked nor rejected (L-F); no HSTS (L-G); malformed usernames skipped the rate limit (M-A, by reading the code) | Confirmed |
| After the security-check fixes: format, lint, typecheck, `npm test`, `npm run test:db`, build, `eval:impact`, `npm audit --omit=dev` | all exit 0; 634 unit, 49 DB tests; baseline unchanged; 0 vulnerabilities | PASS |
| Security-fix mutation checks (malformed name, concurrency cap, per-username lock, proposals immutable, accept re-validates, sessions revoke-only, auth logging, blanks in patches, blanks in UI, HSTS) | all 10 caught; both migration mutations ran with a test-schema reset before and after | PASS |
| Production-mode end to end (`npm run build` + `next start`) | full flow passes. Pages send `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, the API `no-store`; HSTS present; the cookie is `__Host-docusync_session` with `Secure`, `HttpOnly` and `SameSite=Strict`. Only the expected cross-site sign-in refusals in the log | PASS |
| `npm run reviewer:unlock -- --username demo-reviewer` | cleared 5 failures left by earlier end-to-end runs (a real lockout) | PASS |
| CLIs on the dev database | `reviewer:add` (and `REVIEWER_EXISTS` on repeat), `reviewer:grant` (and `REVIEWER_NOT_FOUND`, `REPOSITORY_NOT_FOUND`), `analysis:run` with and without a model | PASS |

**Issues found and fixed during the phase:**
- **Migration:** `login_failures.id` was `bigserial`, and the app role has no sequence privileges. It became `uuid`. The migration was uncommitted and applied only to the test database, whose schema was reset.
- **Next.js invariant:** "Received an underlying cookies object that does not match…" fired when the login page re-rendered after a failed no-JavaScript sign-in while the layout's session nav read cookies. Removing React `cache` didn't help, so that was ruled out. The fix moved the signed-in nav into the `(review)` route group so `/login` never reads cookies; the re-run was clean.
- **Test timeout:** cold imports in the webhook route test and the pool test exceeded Vitest's 5-second default once the jsdom tests joined the suite. The unit project's timeout is now 20 seconds; the Phase 01 test files are unchanged.

## Acceptance criteria

- [x] **A reviewer can inspect evidence and patch:** the analysis and review pages (component tests plus the end-to-end run).
- [x] **Accept, edit and reject persist correctly, and invalid transitions fail:** DB tests (a second decision, concurrency, invalid proposal, unchanged or invalid edit) and API 409/422.
- [x] **UI states are tested:** loading (Suspense fallbacks; not unit-testable), empty, no access, partial, failed, running, success, decided, error and network failure (React Testing Library).
- [x] **Authorization checks are server-side:** SQL grant joins in every query and in the decision transaction, 404 without a grant, and tests plus mutation checks.
- [x] **No fake live data or nonfunctional controls:** fixture data is labelled everywhere, there is no PR URL or create-PR button, and the completion state says no GitHub PR was created.
- [x] Docs, status and handoff updated.
- [x] `/review`: done (by the reviewer agent; findings reproduced before fixing).
  - **Fixed:**
    - M1: the validation context is bounded and checked with one schema on save and on read.
    - M2: a coded 500 for unexpected errors, with nothing leaked.
    - M3: an atomic per-username rate limit.
    - L1: no false "passed validation" claim.
    - L2: a separate `PROPOSAL_NOT_VALID` code.
    - L3: sign-out overwrites the cookie with its options.
    - L5: focus returns to the opener, or moves to the success notice.
    - L6: doc claims corrected, and the missing grant and cookie tests added.
    - L8: the scrypt parameter range is narrowed.
    - L9: tests for the origin fallback, `Origin: null`, insertion-only and deletion-only hunks, and `DUMMY_HASH`.
  - **Documented as accepted:**
    - L4: pages answer 200 for not-found and signed-out.
    - L7: the origin check behind a proxy.
  - **Not fixed:** the nits.
- [x] `/security-check`: done (read-only, not an audit).
  - **Fixed:**
    - M-A: malformed usernames refused at once, at most 4 concurrent sign-ins, a pruning index, and the upstream rate limiter documented as a deployment requirement.
    - L-A: stored proposals and candidates are immutable for the app role.
    - L-B: accepting re-validates the stored patch.
    - L-C: sessions are revoke-only, and the trail is documented as tamper-evident against edits, not unforgeable.
    - L-E: sign-in and sign-out log events.
    - L-F: default-ignorable and blank characters are marked in the UI and rejected in patches and paths.
    - L-G: HSTS in production.
  - **Documented:** L-D (lockout), with `npm run reviewer:unlock`.
  - **Verified:** Info 3 (page cache headers) on a production build.
  - **Recorded as Phase 05 requirements:** Info 1, 2, 4 and 5.

## Decisions

D-012 (local reviewer accounts, labelled fixture runs, one final decision, CSP without nonce, React Testing Library with jsdom).

## Risks and limitations

- **Authentication is basic:** local accounts, no MFA, rate limiting per username only (no per-IP limit), no session rotation or "sign out everywhere". Reviewers are not GitHub identities.
- **Script CSP allows `'unsafe-inline'` (D-012):** script injection is prevented by never rendering untrusted HTML (React text only, tested), not by the CSP.
- **The recorded approval binding is not yet checked against GitHub.** `baseBlobSha` is the hash of the stored text (Phase 03 security L4). Phase 05 must compare head SHA, blob SHA and patch hash with GitHub before any write.
- **Not tested in a real browser:** keyboard flow beyond component tests, screen readers, narrow layouts, and the client-side (JavaScript) Server Action path. The end-to-end run used the no-JavaScript form path.
- **A cross-site sign-in post gets Next.js's 500** ("Invalid Server Actions request") rather than a 403. No cookie is set.
- **Login failure rows** are pruned only when new failures arrive.
- **Dev data:** the dev database holds the `demo-reviewer` account and fixture analyses from the end-to-end run, local only. The reviewer's password was written to a temp file outside the repo and was never printed or committed.

## Recovery / rollback

Phase 04 is one commit on top of `f9f19a3`. To undo it without rewriting history, run `git revert <phase-04-commit>`. Don't use `git reset --hard` without explicit approval. Migrations 0003 and 0004 are applied to the local dev and test databases; to roll back locally, recreate the volume (`docker compose down -v`) or drop the new tables with the owner role.

## Next session must verify

- `git log` shows the Phase 04 commit and `git status` is clean.
- `npm run db:migrate`, `npm test`, `npm run test:db` and `npm run build` pass.
- Sign in through the browser at `/login` (create a reviewer with `npm run reviewer:add`, a fixture analysis with `npm run analysis:run`, and a grant with `npm run reviewer:grant`).

## Next phase prerequisites

- Phase 04 is PASS and committed (done).
- **Phase 05 requirements from the Phase 04 security check (also in docs/07):**
  - **Before any write:** refuse fixture-sourced repositories; compare the binding against GitHub's current head and the blob at that head; recompute and compare `patch_sha256`; re-check the reviewer's grant; require a fresh approval. Decisions don't expire and are accepted on superseded heads today.
  - **Binding:** add the GitHub repository and installation id to it.
  - **Logging:** wrap page loaders and Server Actions so errors log only codes.
  - **Operator tooling:** disable, reset-password and revoke-grant commands; a narrower operator role than the owner; no password on stdout.
  - **Housekeeping:** prune expired sessions and cap sessions per reviewer.
  - **Audit trail:** decide whether it must be unforgeable (a separate decision-writing role, or signed decisions).
- **Phase 05 (GitHub workflow):**
  - **Approval and authorization:** require a fresh explicit approval, and authorize the GitHub write separately from local reviewer accounts.
  - **Revision checks:** re-check head SHA, blob SHA (GitHub's, at `headSha`) and the patch hash against the recorded decision.
  - **Writes:** use narrow write permissions and idempotency (`github_outputs`), and never merge.
  - **Live data:** live analyses still need doc fetching (Contents: read, symlinks refused) and a runner.

## Correction (2026-10-12, during Phase 06)

This handoff says GitHub CI was not run because there was no remote. That was wrong: `origin` (github.com/PrathmeshNikhare/DocuSync-AI) existed, and GitHub Actions ran on this phase's commit. The run failed at `npm ci`: the lockfile, generated on Windows, lacked the optional `@emnapi` packages npm on Linux expects, so no check ran in CI. Fixed in Phase 06 by commit `ff5222e`, which also fixed a build failure hidden behind the install step. Local checks were unaffected.
