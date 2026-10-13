# Handoff — Phase 05: GitHub workflow

- Date: 2026-10-12
- Status: PASS (user-confirmed 2026-10-12). All local checks pass on the final tree. `/review` done (M1–M4, L1, L2, L4, L5, L10 fixed). `/security-check` done (no High; M-1 fixed). The remaining Low and Info items are recorded below. Writes are verified against a fetch-level fake of GitHub only: no live GitHub App was available. Committed locally; not pushed.
- Branch: `main` (no remote)
- HEAD commit: the Phase 05 checkpoint commit (the commit containing this handoff; see `git log`), on top of `e37fd24` (Phase 04 PASS).
- Working tree: clean after the commit (local only, not pushed). Ignored local files: `.env` and `.env.local`.
- Active phase after handoff: 05 is complete; Phase 06 is NOT STARTED and waits for user direction.

## Outcome

After a reviewer accepts or edits a proposal on a live analysis, a granted reviewer can press **Create documentation PR…**. They confirm the exact approval (hashes and the diff), and the server re-checks everything against the database and GitHub's current state. It then creates one `docusync/…` branch at the reviewed head, one commit with exactly the approved change, and one PR into the source PR's head branch, never merged. Writes are off unless `GITHUB_WRITES_ENABLED=true`. Live analyses come from a new CLI path that reads docs at the PR head through git trees and blobs.

## Design gate (phase prerequisite)

- **docs/13 was reviewed by the security-reviewer agent before any write code existed.**
  - **First verdict:** approve with required changes (H1, M1–M6, L1–L4).
  - **Revision:** all applied, with the user's choices:
    - accept the bounded app-database-role trust, without signed decisions;
    - display names in PR bodies;
    - one GitHub App.
  - **Re-review:** approved, with two wording fixes (column-level grants, refs backfill), also applied together with its low items.
- **Recorded as D-013.**

## What was implemented

- **`migrations/0005_github_writes.sql`:**
  - `pull_requests.head_ref` and `base_ref`;
  - `github_outputs` (binding, `step`, `error_code`, lease, attempts, checks);
  - `github_output_attempts`;
  - grants: repository identity, output bindings and the attempt log are fixed for the app role.
- **`src/lib/github/writer.ts`:**
  - `openGitHubWriter`: a fresh token per operation, scoped to one repository id and checked, then revoked;
  - a hook layer (`hookAllows`) and a fetch layer (`fetchAllowed`), with exact routes and parameters and no redirects;
  - no merge or delete;
  - refuses to mint a token or mutate anything while writes are off.
- **Live path:**
  - `src/lib/github/docs.ts` and `doc-bytes.ts`;
  - the reader's `contents: read` permission scoped by repository name, plus `getTree`/`getBlob`;
  - `livePullSchema`;
  - `saveAnalysis` in `store.ts` (upserts by GitHub id and backfills branch names);
  - `npm run analysis:run -- --live owner/repo#N --installation <id>`.
- **`src/lib/review/publish.ts`:** `createDocsPr` runs the checks in docs/13 order:
  - the H1 check that the fetched blob is the reviewed text;
  - a random-token lease with a 45 s deadline;
  - persisted, resumable steps;
  - lost-commit adoption only after `compare`, and bot-only PR adoption;
  - 5 attempts, 30 s apart.
- **`src/lib/review/pr-content.ts`:** the title, body and commit message, with untrusted values only in code, server-built autolinks, display names and a 60,000-character cap.
- **Route:** `POST /api/reviews/[id]/create-pr` (`handleCreatePr`).
- **UI:** `src/components/create-pr-panel.tsx` and the review-view states; `getReview` returns `output`, `writesEnabled` and `pr.headRef`.
- **Env and logging:** `GITHUB_WRITES_ENABLED` and `GITHUB_APP_SLUG` (`.env.example`); log fields `outputId`, `reviewerId`, `step`. `mapGitHubError` now unwraps our own codes from Octokit's fetch-error cause.
- **Phase 04 follow-ups (user-selected):**
  - `reviewer:revoke`, `reviewer:disable`, `reviewer:enable` and `sessions:prune`;
  - `reviewer:add --password-file` (refuses an existing file; `*.pw` git-ignored);
  - at most 10 live sessions per reviewer;
  - `codeOnlyErrors` (`src/lib/review/safe.ts`) around page loaders and Server Actions.
- **Docs:** 02, 03, 04, 07, 08, 09, 10, 11, 13 and the README.

## Verification (final tree)

| Command / check | Result | Status |
|---|---|---|
| `npm run format:check`, `npm run lint`, `npm run typecheck` | clean | PASS |
| `npm test` | 30 files, 715 passed | PASS |
| `npm run test:db` | 5 files, 109 passed | PASS |
| `npm run build` | compiled; `/api/reviews/[id]/create-pr` present | PASS |
| `npm run eval:impact` | 21 scenarios, TP 12 / FP 1 / FN 1 / TN 26; baseline file unchanged | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities | PASS |
| `npm run db:migrate` (dev) | applied `0005_github_writes.sql` | PASS |
| Operator commands on the dev database | add with a password file (and `PASSWORD_FILE_EXISTS` with no account), grant, idempotent revoke, disable and enable, `REVIEWER_NOT_FOUND`, prune; the test account removed | PASS |
| Mutation checks (30) | all caught: the original 20, 7 for the `/review` fixes, 3 for the security-check M-1 fix (the publish ones re-run after the M-1 refactor). The claim-lease mutation was first missed, because the 30 s retry interval also blocked it; a test where only the lease blocks now catches it | PASS |
| Production end to end (`next start`), create-PR route, re-run after the review fixes | writes off: 503 `WRITES_DISABLED` `no-store`, page explains fixture data; writes on without an App slug: 503 `WRITES_MISCONFIGURED`; writes on: 409 `FIXTURE_NOT_WRITABLE`, 403 cross-site, 401 no session, no output rows | PASS |
| Live GitHub App write | no App or credentials available | NOT RUN |
| `/review` | no High; M1–M4, L1, L2, L4, L5, L10 fixed (see below); L3, L6–L9 and Info open | DONE |
| `/security-check` | no High; M-1 (extra commits in the bot's PR) fixed; L-1 to L-3 and the Info items open | DONE |
| GitHub Actions CI | no remote | NOT RUN |

## Exit criteria (phases/05)

- **No GitHub write without explicit valid approval:** met locally. There are 15 refusal tests with zero GitHub requests, the flag is enforced in three places, and the matching mutations are caught.
- **Stale approvals rejected:** met locally (head, branch names, blob, tree, PR state, fork and repository id, the H1 blob content).
- **Rejected proposals excluded:** met (`PROPOSAL_REJECTED`, no request; the UI shows no button).
- **Duplicate requests create no duplicate PRs:** met locally (sequential, concurrent, and four partial-failure resumes).
- **Secrets server-side and logs redacted:** met (tests for tokens, keys and GitHub messages in logs and responses).
- **Security review passes:** the design review passed. The implementation `/security-check` found no High, and its one Medium (M-1) is fixed and tested. Its Low items are open (below).
- **Docs, status and handoff updated:** done.

## Security notes and limitations

- **Not live:** no real GitHub write has happened. The first live run should use a throwaway repository, with rulesets protecting other branches.
- **Bounded trust in the app database role (D-013):** whoever holds `DATABASE_URL` can trigger bounded docs PRs.
- **One App** for reading and writing. Contents write is repository-wide on GitHub's side, so a stolen private key is limited only by rulesets (docs/10).
- **CSP:** it still allows inline scripts (D-012), and a write action now exists.
- **Not built:**
  - decision expiry;
  - a commit-pinned PR file list;
  - a reset-password command and a narrower operator role.
- **Windows:** password-file mode 0600 is not enforced; protect the file with ACLs.

## Git

- Uncommitted on `main` (on top of `e37fd24`).
- **New files:**
  - `migrations/0005_github_writes.sql`;
  - `src/lib/github/{writer,docs,doc-bytes}.ts` with tests;
  - `src/lib/review/{publish,pr-content,safe}.ts` with tests;
  - `src/lib/review/api-create-pr.test.ts`;
  - `src/test/fake-github.ts`;
  - `src/components/create-pr-panel.tsx`;
  - `src/app/api/reviews/[id]/create-pr/route.ts`;
  - `docs/13-github-write-workflow.md`;
  - this handoff.
- **Suggested commit message, if authorized:** `feat: phase 05 approval-gated GitHub documentation PRs`.
- **Rollback:** the work is uncommitted. Migration 0005 is applied to the dev and test databases; to undo locally, recreate the volume or drop `github_output_attempts` and `github_outputs` and the two `pull_requests` columns with the owner role.

## Recommended next action

Phase 05 is PASS and committed. Before enabling writes anywhere: set up the `docusync/**` and default-branch rulesets (docs/10), then do a first live run on a throwaway repository. Phase 06 (evaluation and hardening) can pick up the open Low items. Do not start Phase 06 automatically.

## `/review` results and fixes

- **No High findings.**
- **Fixed:**
  - **M1:** the token revocation ignores the operation's deadline, so it still runs after a timeout.
  - **M2:** a live re-run refreshes the PR's branch names, and the retarget check uses the output's snapshot, so a retargeted PR can be reviewed and published without a new commit.
  - **M3:** unusable post-write responses are `GITHUB_AMBIGUOUS` and retried; refused tokens are `GITHUB_TOKEN_REFUSED`; redirects and token-scope errors are retryable; a refused PR creation is `PR_CREATE_REFUSED`; the API tells terminal and retryable 502s apart.
  - **M4:** tests for the token-client guard and the writer's method list, and corrected H1 wording in docs/13, docs/07 and docs/08.
  - **L1:** unexpected errors after the claim release the lease and record a code.
  - **L2:** a branch is recorded only once it exists.
  - **L4:** an opened PR is returned first; an adopted PR reports `created: false`.
  - **L5:** configuration is validated before any attempt (`503 WRITES_MISCONFIGURED`).
  - **L10:** the listed tests.
- **Open (not selected):**
  - **L3:** a resume doesn't re-check the output's stored hashes against the current approval.
  - **L6:** `api_create_pr` doesn't log the step.
  - **L7:** create-PR panel focus while pending and after success; docs/13 says "dialog" but it is inline.
  - **L8:** a truncated tree only adds a note; analyses have no partial status.
  - **L9:** `reviewer:add` can lose the password if writing the file fails after the insert.
  - **Info:** body-cap wording, the new GET review fields undocumented in docs/04, the lease margin, a source PR on the default branch, D-013 not listing the follow-ups.

## `/security-check` results and fixes

- **No High findings.** The `/review` fixes were checked and hold.
- **Fixed — M-1 (the bot's PR could carry commits DocuSync didn't make):**
  - our commit must have exactly the reviewed head as its parent;
  - before the PR, `compare` must show exactly our change;
  - the created PR's head must be our commit (`PR_HEAD_MISMATCH` otherwise, never recorded, the PR left for an operator to close);
  - the PR body names the commit;
  - docs/10 now requires the `docusync/**` and default-branch rulesets before writes are enabled. Pushes after the PR opens are stopped only by those rulesets, which the code can't verify.
- **Open:**
  - **L-1:** the live CLI doesn't verify its read token's repository, and stores the owner and name as typed.
  - **L-2:** hidden and bidi characters reach the PR body, title and commit message unmarked.
  - **L-3:** each create-PR request re-validates the approval before the attempt limits apply; there is no per-reviewer rate limit.
  - **Info:**
    - the writes flag is visible without a session;
    - `mediaType` is unchecked;
    - a token minted with a lost response is never revoked, and the live CLI's read token is never revoked;
    - there are no response-size caps;
    - the app role can still update `pull_requests` and insert prepared outputs (within D-013);
    - collaborators can permanently block an output;
    - the confirm panel shows the current head ref.
- **Controls absent (docs/07 list):**
  - signed decisions, decision expiry, a commit-pinned file list;
  - rulesets or a separate write App enforced in code;
  - reader token scope verification, bidi escaping in PR text, response-size caps, rate limits;
  - MFA, a nonce CSP, egress restriction;
  - a live GitHub run.

## Correction (2026-10-12, during Phase 06)

This handoff says GitHub CI was not run because there was no remote. That was wrong: `origin` (github.com/PrathmeshNikhare/DocuSync-AI) existed, and GitHub Actions ran on this phase's commit. The run failed at `npm ci`: the lockfile, generated on Windows, lacked the optional `@emnapi` packages npm on Linux expects, so no check ran in CI. Fixed in Phase 06 by commit `ff5222e`, which also fixed a build failure hidden behind the install step. Local checks were unaffected.
