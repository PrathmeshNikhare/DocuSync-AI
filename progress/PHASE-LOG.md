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
