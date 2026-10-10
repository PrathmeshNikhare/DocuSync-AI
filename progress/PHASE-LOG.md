# Phase Log

Append one entry per phase attempt. Preserve failed attempts and corrections.

## Template

### YYYY-MM-DD — Phase NN — STATUS
- Scope:
- Changes:
- Commands run:
- Test results:
- Acceptance criteria:
- Blockers/limitations:
- Decisions:
- Git state:
- Handoff path:

### 2026-10-10 — Phase 00 — IN PROGRESS (local checks PASS)
- Scope: Next.js foundation, tooling, shared Zod contracts, env validation, lazy `pg` pool, CI, docs.
- Changes: baseline harness commit `7045a66` (user-authorized). Then, uncommitted: `package.json` and lockfile, `tsconfig.json` (strict + `noUncheckedIndexedAccess`), `next.config.ts` (`agentRules: false`), ESLint, Prettier and Vitest configs, `.nvmrc`, `.gitattributes`, `src/app/{layout,page}.tsx`, `src/app/api/health/route.ts`, `src/lib/{schemas,env}.ts`, `src/lib/db/pool.ts`, plus tests. Edited CI (Node from `.nvmrc`, format check added), `.env.example` (DB password now matches compose), `.gitignore`, README, AGENTS.md and docs 02, 03 and 07.
- Commands run, after `rm -rf node_modules .next` and `npm ci`. All exited 0: `npm run format:check`, `npm run lint` (0 problems), `npm run typecheck`, `npm test`, `npm run build`. Also ran `npm run dev` (GET `/api/health` returned `{"status":"ok"}`; `/` returned 200), `next start` (`/api/health` 200, POST 405), `docker compose up -d --wait postgres` (Healthy).
- Test results: 3 files and 53 tests passed (Vitest 5.0.3).
- Acceptance criteria: all met locally (see handoff). GitHub Actions CI NOT RUN because there's no remote.
- Blockers/limitations: native PostgreSQL 18 on host port 5432 shadows the container from the host. `.env.example` credentials were checked over the container's network IP instead. `npm audit` reports 5 high-severity issues in dev dependencies only (`braces` chain); production dependencies have 0.
- Decisions: D-006 (Node 24 / toolchain), D-007 (SQL migration convention).
- Git state: `main`, HEAD `7045a66`, Phase 00 changes uncommitted.
- Handoff path: `progress/handoffs/phase-00-foundation.md`

### 2026-10-10 — Phase 00 — IN PROGRESS (review fixes applied)
- Scope: fixes requested by the user from the `/review` findings: M1, M2, L1, L3, L4 and the Nits.
- Changes: `schemas.ts` checks that text is storable in Postgres (no NUL, valid Unicode), trims and requires non-blank labels, and hardens paths (Unicode control, format and surrogate characters, `:`, trailing-dot and trailing-space segments). Review decisions are split into `reviewDecisionInputSchema` (no reviewer or proposal id) and `reviewDecisionRecordSchema`. Analysis timestamps are checked against status and order. The schema tests check which field failed. Pool tests moved to `src/lib/db/pool.test.ts`. The Vitest glob now includes `.tsx`. `docker-compose.yml` binds `127.0.0.1` only. CI gets `persist-credentials: false` and `timeout-minutes: 15`. README and docs 02, 04 and 07 updated.
- Commands run (all exit 0): `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Also `docker compose config --quiet`. Two mutation checks, each caught by exactly 1 failing test.
- Test results: 4 files, 86 tests passed.
- Blockers/limitations: `docker compose up` on this machine fails to bind `127.0.0.1:5432` because of the native PostgreSQL 18 service. It worked through a temporary `127.0.0.1:55432` override, including a host `pg` query with the `.env.example` credentials. L2, L5, L6 and L7 are deferred (see handoff).
- Decisions: none new.
- Git state: `main`, HEAD `7045a66`, changes uncommitted.
- Handoff path: `progress/handoffs/phase-00-foundation.md` (updated)

### 2026-10-10 — Phase 00 — IN PROGRESS (security-check fixes applied)
- Scope: the user-selected `/security-check` fixes: M1 (approval binding), L5 (`X-Powered-By`), L8 (`.gitignore`), and the docs/07 claim corrections.
- Changes: `reviewDecisionRecordSchema` now requires `repositoryId`, `headSha`, `baseBlobSha`, `patchSha256` and `decidedAt`. `next.config.ts` sets `poweredByHeader: false`. `.gitignore` adds `*.key`, `*.p12`, `*.pfx`, `.envrc` and `.npmrc`. docs/07 lists what the path schema still accepts and which claims are untested, with no overstated server behaviour. docs/03 `review_decisions` adds the binding columns.
- Commands run (all exit 0): `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Also `next start` + `curl -I` (no `X-Powered-By`) and `git check-ignore` on the new patterns.
- Test results: 4 files, 96 tests passed.
- Blockers/limitations: the remaining security findings are deferred to Phases 01, 03, 04 and 06 (see handoff). This was a read-only review, not a formal audit.
- Decisions: none new.
- Git state: `main`, HEAD `7045a66`, changes uncommitted.
- Handoff path: `progress/handoffs/phase-00-foundation.md` (updated)

### 2026-10-10 — Phase 00 — PASS
- Scope: gate closure, confirmed by the user.
- Changes: `STATUS.md` and the handoff mark Phase 00 as PASS. No code changes.
- Commands run: none new. This relies on the checks recorded above (format:check, lint, typecheck, test with 96 passing, build) for the code in commit `8762d4f`.
- Acceptance criteria: all Phase 00 exit criteria met locally. GitHub Actions CI NOT RUN because there's no remote.
- Blockers/limitations: deferred review and security items are listed in the handoff. On this machine, the native PostgreSQL 18 service holds port 5432 and must be resolved before Phase 01 database work.
- Decisions: none new.
- Git state: `main`; Phase 00 checkpoint `8762d4f` on top of `7045a66`; this status update is committed separately. Not pushed.
- Handoff path: `progress/handoffs/phase-00-foundation.md`

### 2026-10-10 — Phase 01 — IN PROGRESS (local checks PASS)
- Scope: read-only GitHub diff ingestion. Plan approved by the user, including dependencies, D-009 enqueue-only dispatch, a configurable Postgres host port, and recreating the empty volume.
- Changes: signed webhook receiver with idempotent enqueue; read-only Octokit App reader and fixture reader; diff normalizer and `PullRequestSnapshot`; first migration and runner; `docusync_app` least-privilege database user; structured logging; ingest and migrate CLIs; CI Postgres service with database tests. Docs 02, 03, 04, 07 and 10, README, D-008 and D-009 updated.
- Commands run (all exit 0): `npm ci` (lockfile unchanged), `npm run format:check`, `lint`, `typecheck`, `test` (190 passed), `build`, `test:db` (17 passed), `db:migrate` (twice), `ingest -- --fixture unsafe-paths`. Also an end-to-end webhook run against `next dev`, and a CI database-init simulation on a fresh container.
- Test results: 190 unit and 17 database tests passed. Two bugs found by tests and fixed (Octokit timeout hook; timeout error mapping).
- Acceptance criteria: all met locally (see handoff). Live GitHub NOT RUN (no App); GitHub CI NOT RUN (no remote); review and security-check NOT RUN.
- Blockers/limitations: queued analyses are not processed (D-009); no auth; see the handoff for the full list.
- Decisions: D-008, D-009.
- Git state: `main`, HEAD `2f60dcc`, Phase 01 uncommitted.
- Handoff path: `progress/handoffs/phase-01-github-diff-ingestion.md`

### 2026-10-10 — Phase 01 — IN PROGRESS (review fixes applied)
- Scope: the user-selected `/review` fixes: M1, L1, L4, L5, L6, T1–T4 and the nits.
- Changes: `ingestPullRequest` re-reads PR metadata after listing files and takes `expectedHeadSha`, failing with `GITHUB_STALE_HEAD`. The normalizer marks unstorable or overflowing patches `malformed` and keeps the file. New codes `GITHUB_NETWORK_ERROR`, `GITHUB_STALE_HEAD` and `INVALID_PULL_REQUEST_REF`; secondary rate limits map to `GITHUB_RATE_LIMITED`. The migrate CLI prints only safe messages or codes, and `MigrationError` was added. Nits: PR number capped at `PG_INT_MAX`, `idle_in_transaction_session_timeout`, `server-only` on the Octokit reader, shared types moved to `src/lib/analysis-work.ts`, and a failed ROLLBACK keeps the original error. New tests: chunked body, pagination edges, route wiring, stale head, network error. docs/02 and docs/07 corrected. L2, L3 and the `reopened` retry are documented in the handoff, not fixed.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (213 passed), `build`, `test:db` (17 passed). Also three mutation checks (each caught), `db:migrate` with bad credentials and host (redacted output), and fixture `ingest`.
- Test results: 213 unit and 17 database tests passed.
- Blockers/limitations: the end-to-end webhook run against `next dev` was not repeated after these fixes; route wiring is now covered by `route.test.ts`.
- Decisions: none new.
- Git state: `main`, HEAD `2f60dcc`, Phase 01 uncommitted.
- Handoff path: `progress/handoffs/phase-01-github-diff-ingestion.md` (updated)

### 2026-10-10 — Phase 01 — IN PROGRESS (security-check fixes applied)
- Scope: the user-selected `/security-check` fixes: M1, M2, L1, L2, L4, L6 and the doc corrections.
- Changes: `GITHUB_ALLOWED_INSTALLATION_IDS` installation allowlist (fails closed, 503); other installations get 202 `ignored` with no DB write. Migration `0002_restrict_app_role.sql` (no `schema_migrations` access or TEMP for the app role; explicit REVOKE CREATE on `public`). Init script revokes PUBLIC CONNECT. Silent Octokit and auth-app loggers. The repository upsert skips no-op updates and the PR upsert never rewrites. `toTerminalSafeJson` for ingest CLI output. `logEvent` copies allowed fields at runtime. docs 02, 03, 04, 07 and 10, README and `.env.example` corrected (GitHub doesn't redeliver failed deliveries; precise privileges; stale-head limits; owner credentials kept out of the web process; private App).
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (227 passed), `build`, `test:db` (18 passed), `db:migrate` (applied 0002), CI-style fresh-container DB init plus `test:db` (18 passed), `npm audit --omit=dev` (0). Also an end-to-end webhook run with the allowlist, four mutation checks (each caught), and live privilege queries.
- Test results: 227 unit and 18 database tests passed.
- Blockers/limitations: the session was interrupted once; Docker Desktop had stopped and was restarted with `docker desktop start`. The deferred security items are listed in the handoff.
- Decisions: none new.
- Git state: `main`, HEAD `2f60dcc`, Phase 01 uncommitted.
- Handoff path: `progress/handoffs/phase-01-github-diff-ingestion.md` (updated)

### 2026-10-10 — Phase 01 — PASS
- Scope: gate closure, confirmed by the user, plus the local checkpoint commit.
- Changes: `STATUS.md` and the handoff mark Phase 01 as PASS. No code changes since the security-check fixes.
- Commands run: none new. This relies on the checks recorded above (227 unit and 18 database tests, build, lint, typecheck, format, end-to-end webhook run).
- Acceptance criteria: all Phase 01 exit criteria met locally. Live GitHub App NOT RUN (no App); GitHub Actions CI NOT RUN (no remote).
- Blockers/limitations: deferred review and security items are listed in the handoff.
- Decisions: none new.
- Git state: `main`; Phase 01 committed locally on top of `2f60dcc`; not pushed.
- Handoff path: `progress/handoffs/phase-01-github-diff-ingestion.md`
