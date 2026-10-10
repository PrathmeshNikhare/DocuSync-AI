# Handoff — Phase 01: GitHub diff ingestion

- Date: 2026-10-10
- Status: PASS (user-confirmed 2026-10-10). All local checks PASS. `/review` done, with M1, L1, L4, L5, L6, T1–T4 and the code nits fixed. `/security-check` done, with M1, M2 (docs), L1, L2, L4, L6 and the doc corrections fixed. Committed locally; not pushed.
- Branch: `main` (no remote)
- HEAD commit: the Phase 01 checkpoint commit (the commit containing this handoff; see `git log`), on top of `2f60dcc` (Phase 00 PASS).
- Working tree: clean after the commit (local only, not pushed). Ignored local files: `.env` and `.env.local`.
- Active phase after handoff: 01 is complete; Phase 02 is NOT STARTED and waits for user direction

## Outcome

This phase delivers secure, read-only PR ingestion:
- A signed webhook receiver that queues one analysis per repository, PR and head commit, idempotently.
- A read-only GitHub reader: a live GitHub App reader and a fixture reader that needs no credentials.
- A diff normalizer that validates paths, parses hunks and enforces limits, producing a Zod-validated `PullRequestSnapshot`.
- The first SQL migration and the migration runner.
- A least-privilege database user for the app.
- CI database tests.

Queued analyses are not processed yet, and snapshots are not persisted (D-009).

## Files changed

- **Webhook:** `src/app/api/webhooks/github/route.ts` (thin), `src/lib/github/webhook-handler.ts` (status codes, logging), `src/lib/github/webhook.ts` (HMAC verification, 1 MiB body reader, header and payload schemas, idempotency key).
- **GitHub reading:** `src/lib/github/reader.ts` (interface, raw response schemas, `GitHubReadError` codes), `octokit-reader.ts` (App token with `pull_requests: read`, non-GET block plus per-request timeout hook, pagination limit, error mapping), `fixture-reader.ts`.
- **Normalization:** `src/lib/diff-analyzer/normalize.ts`, `src/lib/ingest.ts`, and new snapshot schemas plus `DIFF_LIMITS` in `src/lib/schemas.ts`.
- **Database:** `migrations/0001_ingestion.sql`, `src/lib/db/migrate.ts`, `src/lib/db/analyses.ts`, pool timeouts in `src/lib/db/pool.ts`, `db/init/01-app-role.sql`.
- **Shared types:** `src/lib/analysis-work.ts` (`PullRequestWork`, `EnqueueResult`), used by both the webhook and the database layer.
- **Config and environment:** `src/lib/env.ts` (webhook secret, App credentials and migration URL, each validated lazily), `src/lib/log.ts`.
- **Scripts:** `scripts/migrate.ts`, `scripts/ingest.ts`, plus the package scripts `test` (unit project), `test:db`, `db:migrate` and `ingest`.
- **Fixtures:** `fixtures/github/*.json` (6 synthetic PRs) and `fixtures/webhooks/pull_request.opened.json`.
- **Tests:** `src/app/api/webhooks/github/route.test.ts`, `normalize.test.ts`, `webhook.test.ts`, `webhook-handler.test.ts`, `octokit-reader.test.ts`, `ingest.test.ts`, `env.test.ts` additions, `migrate.db.test.ts`, `analyses.db.test.ts`, `src/test/db.ts`.
- **Config files:** `vitest.config.mts` (`unit` and `db` projects), `docker-compose.yml` (`POSTGRES_HOST_PORT`, init script mount), `.env.example`, `.github/workflows/ci.yml` (Postgres service, init step, `test:db`).
- **Docs:** README, docs 02, 03, 04, 07 and 10, and D-008 and D-009 in `progress/DECISIONS.md`.

## Verification

Run on Windows 11, Node v24.11.0, Docker 29.8.2, with Postgres 16 on `127.0.0.1:55432`.

| Command | Observed | Result |
|---|---|---|
| Phase 00 gate re-check: format:check, lint, typecheck, test, build | all exit 0; 96 tests | PASS |
| `rm -rf node_modules .next && npm ci` | 562 packages; lockfile byte-identical before and after a second `npm ci` | PASS |
| `npm run format:check`, `lint`, `typecheck` | exit 0 | PASS |
| `npm test` | 9 files, 190 tests passed at first; 10 files, 213 passed after the review fixes | PASS |
| `npm test` after security fixes | 12 files, 227 passed | PASS |
| `npm run test:db` after security fixes (also on a fresh CI-style container) | 18 passed | PASS |
| Security-fix mutation checks: removed the silent Octokit logger, the repository no-change guard, the `schema_migrations` revoke, and the terminal escaping | each caught by its test; sources restored. The logger check only became meaningful after hoisting the console spies (Octokit binds `console.error` when it is first imported) | PASS |
| Live privileges after `db:migrate` (0002) | `docusync_app`: no access to `schema_migrations`, no TEMP, no CREATE on `public`, no CONNECT to `postgres`; keeps CONNECT to `docusync` and row access | PASS |
| End to end against `next dev` with the allowlist | allowed installation: 200 duplicate (existing analysis); other installation: 202 `installation_not_allowed`, no new row; secret appears 0 times in the log | PASS |
| Review-fix mutation checks: disabled the head re-check, the network-error branch, and the malformed fallback | each caught by its targeted tests (2, 1 and 2 failures); sources restored | PASS |
| `npm run db:migrate` with a wrong password, then an unknown host | `MIGRATE_FAILED (28P01)` and `MIGRATE_FAILED (ENOTFOUND)`; no user or host printed | PASS |
| `npm run build` | exit 0; `/api/webhooks/github` dynamic | PASS |
| `npm run test:db` | 2 files, 17 tests passed | PASS |
| `test:db` without the `TEST_*` variables | fails with a clear message (does not skip) | PASS |
| `npm run db:migrate`, run twice | `Applied: 0001_ingestion.sql`, then `No pending migrations` | PASS |
| `docker compose down -v` then `up` (user-approved; the volume had 0 tables) | init log shows CREATE ROLE, CREATE DATABASE, GRANTs; `docusync_app` is not superuser and can't create databases or roles | PASS |
| CI simulation: fresh `postgres:16-alpine`, `psql -f db/init/01-app-role.sql` over password-auth TCP, then `test:db` | psql exit 0; 17 passed | PASS |
| `npm run ingest -- --fixture unsafe-paths` | 1 safe file kept, 4 rejected by index, no raw paths in the output | PASS |
| End to end with `next dev` and signed fixture deliveries | valid: 202 queued; redelivery: 200 duplicate with the same id; bad signature: 401; push event: 202 ignored; 1 DB row written by `docusync_app`; secret appears 0 times in the server log | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities | PASS |
| Banned dependency check | none | PASS |
| Live GitHub App ingestion | no App configured | NOT RUN |
| GitHub Actions CI | no remote | NOT RUN |

Two bugs were found and fixed during testing:
1. The per-request timeout was never applied. Octokit's hook chain binds the original options object, so a modified copy was ignored; the hook now mutates options in place.
2. Timeouts were reported as `GITHUB_UPSTREAM_ERROR`. Octokit wraps the abort as `cause`; the mapper now checks it.

## Acceptance criteria

- [x] Valid webhook fixture accepted, invalid signature rejected: handler tests and the end-to-end run.
- [x] Unsupported events ignored safely: 202 `ignored`, nothing enqueued (tested).
- [x] Path traversal and oversized inputs rejected: path rejection by index; 413 for bodies over 1 MiB; patch, hunk and file limits (tested).
- [x] Duplicate delivery creates no duplicate work: redelivery and same-head tests, 8 concurrent deliveries giving 1 row (DB test), and the end-to-end run.
- [x] GitHub calls tested with mocks, no secrets in logs: mocked `fetch` covers token, pagination, errors, timeout and the write block; log tests check for the secret, signature, payload and database URL.
- [x] Only read operations enabled: interface, non-GET block (tested for POST, PATCH, PUT and DELETE) and token permissions (tested). Not checked against real GitHub.
- [x] Docs, status and handoff updated.
- [x] `/review`: done. Fixed: M1 (stale head check plus `expectedHeadSha`), L1 (unstorable or overflowing patches marked `malformed`, file kept), L4 (secondary rate limit and network-error codes), L5 (migrate CLI prints codes only), L6 (doc drift), T1–T4 (chunked body, pagination edges, route wiring, typed bad-ref error), and nits (PR number cap, idle-in-transaction timeout, `server-only` on the Octokit reader, shared types moved to `src/lib/analysis-work.ts`, ROLLBACK failure keeps the original error).
- [x] `/security-check`: done (read-only review by reading code, not an audit). Fixed:
  - M1: `GITHUB_ALLOWED_INSTALLATION_IDS` (fails closed) and a private App in docs/10.
  - M2: docs corrected; GitHub does not redeliver failed deliveries.
  - L1: migration 0002 plus init-script CONNECT revokes.
  - L2: silent Octokit and auth-app loggers.
  - L4: replays no longer rewrite repository or PR rows.
  - L6: terminal-safe CLI output.
  - The runtime field allowlist in `logEvent`.
  - The doc corrections (L5 and L7 wording, the six inaccurate claims).

## Decisions

D-008 (read-only Octokit and GitHub App integration, `tsx`) and D-009 (webhook only enqueues; ingestion runs separately). Both were approved by the user.

## Risks and limitations

- **Queued analyses are never processed** in Phase 01 (D-009). The snapshot is printed by the CLI, not stored.
- **Live GitHub is untested.** App auth and token permissions are checked only with mocks, until a GitHub App exists (setup in docs/10).
- **No authentication or authorization** on any endpoint yet. The webhook relies on the HMAC signature only.
- **Retries:** none automatic. GitHub does **not** redeliver failed deliveries automatically. A delivery that gets 5xx or times out is lost unless redelivered by hand within 3 days (docs/10). Reconciliation is runner-phase work (security M2).
- **Draft PRs are ignored** until `ready_for_review`.
- **`base_sha`** keeps its first value for a given head commit.
- **Deferred review items (documented, not fixed):** L2: the installation token is cached for the reader's lifetime and expires after 1 h, which is fine for the one-shot CLI but a long-running runner must refresh it. L3: a late, out-of-order redelivery can overwrite newer repository `owner`, `name` or `installation_id`. A `reopened` event for an already-queued head returns `duplicate`, so a failed analysis can't be retried through the webhook. All three matter only once a runner exists (D-009).
- **Fixture mode always uses PR #1.**
- **Database privileges:** `docusync_app` also gets DML on `schema_migrations` through default privileges. It can't change the schema, but it could edit migration records.
- **Deferred from Phase 00:** security M2, L2, L3 and L4 (Phase 03/04), L5 headers (Phase 04), L6 Action pinning (Phase 06), the review items, and the untested `server-only` client-import guard.
- **Local config:** an ignored `.env` (`POSTGRES_HOST_PORT=55432`) and `.env.local` (local placeholder URLs plus a randomly generated webhook secret) exist on this machine. Neither is committed.

## Recovery / rollback

Phase 01 is one commit on top of `2f60dcc`. To undo it without rewriting history, run `git revert <phase-01-commit>`. Don't use `git reset --hard` without explicit approval. The Docker volume can be reset with `docker compose down -v`; it contains only local test data.

## Next session must verify

- `git log` shows the Phase 01 commit and `git status` is clean.
- `docker compose up -d --wait postgres && npm run db:migrate && npm test && npm run test:db` all pass.
- `npm run ingest -- --fixture env-var-change` prints a snapshot.
- That the deferred review items (L2, L3, reopened retry) and the deferred security items are still tracked. The deferred security items are:
  - L3: repository-scoped tokens and resolving by id.
  - L5: a commit-pinned diff via the compare API.
  - L7: owner credentials kept out of the deployed web process.
  - L8: a body-read timeout and server timeouts.
  - L9: SHA-pinned Actions, a digest-pinned image, token refresh.
  - Delivery reconciliation and per-repository quotas.
  - A GraphQL write-guard test.
- `GITHUB_ALLOWED_INSTALLATION_IDS` is set wherever the webhook should accept deliveries.

## Next phase prerequisites

- Done: `/review` and `/security-check` (selected findings fixed, the rest deferred above), and the local commit.
- Decide whether Phase 02 needs the snapshot persisted or a runner for queued analyses (this revisits D-009).
- Phase 02 is expected to need Contents read permission to fetch documentation files.
