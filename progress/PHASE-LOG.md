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

### 2026-10-10 — Phase 02 — IN PROGRESS (local checks PASS)
- Scope: deterministic impact engine, labelled fixtures, evaluation harness and fixture CLI (user-approved scope: engine and fixtures only; live doc fetching, persistence and a runner deferred, D-010).
- Changes: `src/lib/impact-engine/` (config, signals, match, engine, evaluate, plus tests); schema additions (evidence `side`; candidate `rankPoints` and `rules`; `docFileSchema`); 13 labelled scenarios in `fixtures/impact/`; `scripts/eval-impact.ts` and `scripts/analyze.ts`; `docs/evaluation/impact-baseline.md`; docs 02, 05 and 08, README, D-010.
- Commands run (all exit 0): Phase 01 gate re-check; `npm run format:check`, `lint`, `typecheck`, `test` (312 passed), `build`, `test:db` (18 passed), `eval:impact`, `analyze -- --fixture linked-file-renamed`. Also three mutation checks, each caught (one only after adding a pinning test).
- Test results: 312 unit and 18 database tests passed. Baseline on `impact-v1`: TP 9, FP 1, FN 1, TN 15 (precision 90.0%, recall 90.0% on these 26 docs only).
- Blockers/limitations: synthetic dataset by the engine's author; regex extraction; not connected to live repositories. Labels written before the engine; one evidence-only matching bug fixed after the first run, with no metric change and no weight tuning.
- Decisions: D-010.
- Git state: `main`, HEAD `55989bf`, Phase 02 uncommitted.
- Handoff path: `progress/handoffs/phase-02-impact-engine.md`

### 2026-10-11 — Phase 02 — IN PROGRESS (review fixes applied)
- Scope: the user-selected `/review` fixes: M1-M6, L1-L5 and the nits.
- Process: 8 `impact-v2` regression scenarios were labelled first and run on the unfixed engine (TP 2, FP 6, FN 1, TN 5). Then the fixes were applied. Only one fixture was corrected before recording: a missing context-space prefix that made a patch parse as malformed; no label changed.
- Changes:
  - **M1:** bounded, surrogate-safe clipping of every message and excerpt.
  - **M2:** PR-level notes for truncated and rejected files.
  - **M3:** docs the PR edits count as mentioning a new var or script.
  - **M4:** config keys only from app config files; `package.json` classified by block, with a value heuristic when the header is out of view.
  - **M5:** docs split and tokenized once, matchers compiled once per signal with token pre-checks, a 300-signal cap with a note, and a linear Markdown-link regex.
  - **M6:** docs edited in place emit no path signal.
  - **L1:** block state resets per hunk.
  - **L2:** root route not matchable; dynamic segments match across notations; routes don't match inside external URLs.
  - **L3:** cap only when the analyzed evidence is below the likely threshold.
  - **L4:** hits sorted by points before the caps.
  - **L5:** the scenario schema rejects labelling PR-edited docs.
  - **Nits:** cap rule first, `.json` filter in tests, `escapeRegExp` escapes `-`, and docs/05 says `unlikely_affected` needs a custom config.
  - Engine version bumped to `deterministic-0.2.0`; docs 05 and 08 updated.
- Commands run (all exit 0 unless noted): `npm run format:check`, `lint`, `typecheck`, `test` (341 passed), `build`, `eval:impact`. `test:db` first failed with `ECONNREFUSED` (Docker Desktop had stopped), then passed (18) after `docker desktop start` and `docker compose up`. Also six mutation checks (all caught) and a re-run of the reviewer probes.
- Test results: 341 unit and 18 database tests passed. Baseline on `deterministic-0.2.0`: `impact-v1` TP 9, FP 1, FN 1, TN 15 (unchanged); `impact-v2` TP 3, FP 0, FN 0, TN 11.
- Blockers/limitations: v2 scenarios target the fixed findings; the package.json heuristic can misclassify; work is bounded but has no time budget.
- Decisions: none new (D-010 stands).
- Git state: `main`, HEAD `55989bf`, Phase 02 uncommitted.
- Handoff path: `progress/handoffs/phase-02-impact-engine.md` (updated)

### 2026-10-11 — Phase 02 — IN PROGRESS (security-check fixes applied)
- Scope: the user-selected `/security-check` fixes: H1, H2, M1, M2, L1-L5 and the inaccurate doc claims.
- Changes:
  - **H1:** unambiguous dynamic-route pattern.
  - **H2:** `package.json` line patterns run on trimmed text with no ambiguous trailing quantifiers.
  - **M1:** 200-character name cap; 200-name context caps; related docs computed once per kind; per-doc link index; 10,000,000-character doc budget and 20,000,000-line scan budget, each with notes.
  - **M2:** separate README fallback rule with honest wording; `likely_affected` requires doc-side evidence (`no_doc_evidence_cap`).
  - **L1:** removed lines of renamed files point at the old path.
  - **L2:** renames, deletions and removals are matched first under the signal cap.
  - **L3:** duplicate doc paths are rejected.
  - **L4:** excerpts are a window around the match on long lines.
  - **L5:** names and paths in engine-written text are reduced to plain characters.
  - **Docs:** docs/05 rewritten for accuracy, a docs/07 Phase 02 section added, a docs/08 version row, the report wording ("written", not "committed"), and the handoff baseline and scenario counts corrected.
  - Engine version `deterministic-0.3.0`. The 2026-10-10 Phase 02 entry above says "13 labelled scenarios"; that was accurate then, and there are now 21.
  - Two literal invisible characters a quoting layer had put into `engine.test.ts` were replaced with `\u` escapes; all sources were scanned and are clean.
- Commands run: `npm run format:check`, `lint`, `typecheck`, `test` (353 passed), `build`, `eval:impact` (no metric change), all exit 0. `test:db` failed with `ECONNREFUSED` (Docker Desktop had stopped), then passed (18) after restarting it. Also eight mutation checks, all caught (H1 and H2 reverted made the suite hang until a 120 s timeout), and a re-run of the security probes.
- Test results: 353 unit and 18 database tests passed. Baseline unchanged: TP 12, FP 1, FN 1, TN 26.
- Blockers/limitations: no wall-clock timeout or memory limit yet (runner phase); snapshot and config inputs are not validated by the engine (runner phase).
- Decisions: none new (D-010 stands).
- Git state: `main`, HEAD `55989bf`, Phase 02 uncommitted.
- Handoff path: `progress/handoffs/phase-02-impact-engine.md` (updated)

### 2026-10-11 — Phase 02 — PASS
- Scope: gate closure, confirmed by the user, plus the local checkpoint commit.
- Changes: `STATUS.md` and the handoff mark Phase 02 as PASS. No code changes since the security-check fixes.
- Commands run (all exit 0), re-run on the final working tree before marking PASS: `npm run format:check`, `lint`, `typecheck`, `test` (16 files, 353 passed), `test:db` (18 passed), `build`, `eval:impact` (21 scenarios: TP 12, FP 1, FN 1, TN 26; report unchanged, checked by test).
- Acceptance criteria: all Phase 02 exit criteria met locally on labelled fixtures. Live doc fetching, persistence and the runner are out of scope (D-010). GitHub Actions CI NOT RUN (no remote).
- Blockers/limitations: deferred items (worker-thread timeout and memory limit; snapshot and config validation by the runner) are listed in the handoff.
- Decisions: none new.
- Git state: `main`; Phase 02 committed locally on top of `55989bf`; not pushed.
- Handoff path: `progress/handoffs/phase-02-impact-engine.md`

### 2026-10-11 — Phase 03 — IN PROGRESS (local checks PASS)
- Scope: the approved Phase 03 plan (D-011): LLM provider interface and Ollama transport, versioned prompts, structured output validation, patch path policy and validator, model-assisted orchestration, opt-in live tests and model-assisted evaluation. Assisted mode sees deterministic candidates only. Allowed patch targets are root `*.md` and `docs/**`.
- Changes: new `src/lib/llm/`, `src/lib/patches/`, `src/lib/assist/`, `src/lib/read-body.ts` (moved from `github/webhook.ts`); Ollama env group; log fields for model calls; proposal and assessment schemas; `propose`, `eval:llm` and `test:ollama` scripts; patch labels `patch-v1`; docs 02, 05, 06, 07, 08, README and `.env.example`.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (505 passed), `test:db` (18), `test:ollama` with `OLLAMA_MODEL=llama3.2:3b` (4; exits 1 without a model), `build`, `eval:impact` (baseline unchanged), `npm audit --omit=dev` (0). `eval:llm` ran 5 times. 10 mutation checks were all caught.
- Test results: see the handoff. Evaluation: run 1 (untuned) produced 0 valid patches out of 12. After three assist-policy changes made on the same fixtures (documented in docs/08): 8 valid out of 11, with 7 label passes out of 12 labels. Run 5 repeated run 4 exactly, apart from latency. Model-assisted flagging equals the deterministic baseline in every run.
- Blockers/limitations: tuned on the evaluation fixtures; the model never demotes a doc; validation can't judge prose; no total time budget per PR; no persistence or runner.
- Decisions: D-011.
- Git state: `main`, HEAD `65d3b0f`, Phase 03 uncommitted.
- Handoff path: `progress/handoffs/phase-03-llm-patches.md`

### 2026-10-11 — Phase 03 — IN PROGRESS (review fixes applied)
- Scope: the user-selected `/review` fixes M1-M4, L1-L3, T1-T3 and doc claims. The reviewer agent hit an API rate limit, so the review ran in the main session; every finding was probed before fixing.
- Changes:
  - **M1:** links (absolute, `//host`, `www.`) must exactly match known links.
  - **M2:** `javascript:`/`vbscript:` rejected anywhere after decoding character references and removing whitespace; `data:`/`file:` also as reference-definition targets; event handlers after `/`; HTML and link checks run on all added lines joined.
  - **M3:** empty `OLLAMA_*` values mean the default.
  - **M4:** retries carry `attempt` and Ollama uses seed `41 + attempt`; citation indexes are bounded in the output schema (`assess-v2`).
  - **L1:** no-op edits are dropped. **L2:** a throwing provider maps to `LLM_UNAVAILABLE`. **L3:** carriage returns are allowed only at the end of a line.
  - **Tests (T1-T3):** insertion-only hunks, empty docs, the throwing provider, empty env values and the `.env.example` file, and every probed bypass.
  - **Docs:** docs 05, 06, 07 and 08 corrected; `assist-v4`.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (532 passed), `test:db` (18), `test:ollama` (4), `build`, `eval:impact` (baseline unchanged), `eval:llm` (run 6). Also 11 mutation checks (all caught, one only after adding a host-prefix test), validator timing on hostile input (worst 39 ms), and an invisible-character scan (clean).
- Test results: 532 unit, 18 DB, 4 live. Run 6: 9 valid proposals out of 12 requests, labels 8 pass, 1 fail, 2 no valid patch, 1 not attempted; flagging unchanged.
- Blockers/limitations: L4-L6 documented, not fixed; evaluation tuned on its own fixtures; run 6 latency likely inflated by a concurrent build.
- Decisions: none new (D-011 stands).
- Git state: `main`, HEAD `65d3b0f`, Phase 03 uncommitted.
- Handoff path: `progress/handoffs/phase-03-llm-patches.md` (updated)

### 2026-10-11 — Phase 03 — IN PROGRESS (security-check fixes applied)
- Scope: the user-selected `/security-check` fixes M1-M4, L1-L3, I1, I3 and doc claims. The security-reviewer agent's findings were reproduced with read-only probes before fixing (one magnitude corrected: evidence is capped at 12 items, not 50).
- Changes:
  - **M1, M2, L2:** new `src/lib/patches/content.ts`. Link targets are extracted like a Markdown renderer, decoded (escapes, references without a digit cap), and resolved like a browser. External links must exactly match known ones; `javascript:`, `vbscript:`, `data:` and `file:` are rejected. Any added raw HTML not already in the doc byte-for-byte is rejected, including comments.
  - **M3:** allowlist narrowed to `.md` and `.markdown`; AI-agent instruction files are denied (D-011 updated).
  - **M4:** model explanations and rationales with links, HTML or hidden characters are replaced with a fixed notice.
  - **L1:** smaller context budgets, an evidence-excerpt budget, and a prompt-size guard (`LLM_CONTEXT_TOO_LARGE`).
  - **L3:** https required beyond loopback unless `OLLAMA_ALLOW_INSECURE_HTTP=true`; `eval:llm` version check hardened.
  - **I1:** `toTerminalSafeJson` escapes astral characters as surrogate pairs. **I3:** body-timeout test against a real local server.
  - `assist-v5`; docs 06, 07 and 08, D-011 and `.env.example` updated.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (567 passed), `test:db` (18), `test:ollama` (4), `build`, `eval:impact` (baseline unchanged), `eval:llm` (run 7), `npm audit --omit=dev` (0). Also 12 mutation checks (all caught), timing on 1 MB of hostile text (worst about 230 ms), and an invisible-character scan (clean). A first run-7 start was stopped because the assist policy version had not been bumped; it wrote nothing.
- Test results: 567 unit, 18 DB, 4 live. Run 7: 8 valid proposals out of 12 requests; labels 7 pass, 1 fail, 3 no valid patch, 1 not attempted. The `injection-in-doc` patch is now rejected because the model rewrote the injected HTML comment. Latency roughly doubled for an unidentified reason.
- Blockers/limitations: L4 (stale-base check tautological until GitHub-sourced docs), I2, I5 deferred; validator is not a sanitizer; evaluation tuned on its own fixtures.
- Decisions: D-011 updated (allowlist narrowed, user-approved).
- Git state: `main`, HEAD `65d3b0f`, Phase 03 uncommitted.
- Handoff path: `progress/handoffs/phase-03-llm-patches.md` (updated)

### 2026-10-11 — Phase 03 — PASS
- Scope: gate closure, confirmed by the user, plus the local checkpoint commit.
- Changes: `STATUS.md` and the handoff mark Phase 03 as PASS. No code changes since the security-check fixes.
- Commands run (all exit 0), re-run on the final tree before marking PASS: `npm run format:check`, `lint`, `typecheck`, `test` (19 files, 567 passed), `test:db` (18 passed), `build`, `eval:impact` (baseline unchanged). `test:ollama` (4 passed) and `eval:llm` (run 7) were last run after the security-check fixes, with no code change since.
- Acceptance criteria: all Phase 03 exit criteria met locally on fixtures with a local Ollama. Persistence, the runner and live doc fetching are out of scope (D-010). GitHub Actions CI NOT RUN (no remote).
- Blockers/limitations: deferred items (security L4, I2, I5; review L4-L6; total time budget per PR) are listed in the handoff.
- Decisions: none new (D-011 as updated).
- Git state: `main`; Phase 03 committed locally on top of `65d3b0f`; not pushed.
- Handoff path: `progress/handoffs/phase-03-llm-patches.md`

### 2026-10-11 — Phase 04 — IN PROGRESS (local checks PASS)
- Scope: the approved Phase 04 plan, with the user's choices: local reviewer accounts, labelled fixture runs as the data source, React Testing Library with jsdom, one final decision (D-012). During implementation the user also chose a CSP without a nonce, keeping Cache Components.
- Changes:
  - `migrations/0003_review.sql`;
  - `src/lib/review/` (sessions, passwords, authorized queries, decisions, saving fixture runs, API logic, auth helpers, diff rows, visible text);
  - pages `/login`, `/`, `/analyses/[id]`, `/reviews/[id]` and the API routes;
  - components with tests;
  - the security headers via `next.config.ts`;
  - the `analysis:run`, `reviewer:add` and `reviewer:grant` scripts;
  - `validatePatch` now takes a known-link set (`knownLinksIn`), and `assistImpact` returns each proposal's validation context.
  - Docs 02, 03, 04, 07, 08, 09, 10 and README; D-012.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (600 passed, twice), `test:db` (42), `build`, `eval:impact` (baseline unchanged), `test:ollama` (4), `npm audit --omit=dev` (0). Also 13 mutation checks (all caught; see docs/08) and an end-to-end run against `next dev` (all steps passed after one fix).
- Test results: 600 unit, 42 DB, 4 live.
- Fixes made along the way:
  - **Migration:** `login_failures` used `bigserial`, which the app role couldn't use. It became `uuid`; the migration was uncommitted, and the test schema was reset.
  - **Next.js invariant:** the end-to-end run hit an invariant when the login page re-rendered after a failed no-JavaScript sign-in while the layout read cookies. The signed-in nav moved to a `(review)` route group.
  - **Test timeout:** the Phase 01 webhook route test's timeout was raised to 20 seconds because its cold import got slower with jsdom in the suite.
- Blockers/limitations:
  - `npm audit` reports 5 high findings in dev-only lint tooling (`eslint-config-next` → `braces`). They were already present, have no non-breaking fix, and production dependencies show 0.
  - Script CSP allows `'unsafe-inline'`.
  - No MFA or per-IP rate limit.
  - Reviewers are not GitHub identities.
- Decisions: D-012.
- Git state: `main`, HEAD `f9f19a3`, Phase 04 uncommitted.
- Handoff path: `progress/handoffs/phase-04-review-ui.md`

### 2026-10-12 — Phase 04 — IN PROGRESS (review fixes applied)
- Scope: the user-selected `/review` fixes M1-M3, L1-L3, L5, L6, L8 and the testable parts of L9. The reviewer agent's findings were reproduced first: the Zod double `.max`, scrypt throwing, Next's cookie delete without `Secure`, and 20 parallel logins all being checked.
- Changes:
  - **M1:** `VALIDATION_CONTEXT_LIMITS` and `validationContextSchema` live in `assist.ts`; the context is capped where it is built and checked on save and read.
  - **M2:** a `guarded` wrapper in `api.ts` returns `500 INTERNAL_ERROR` with a request id.
  - **M3:** `reserveAttempt` takes `pg_advisory_xact_lock` and records the attempt before the password check.
  - **L1:** the validation claim shows only for valid proposals. **L2:** a separate `PROPOSAL_NOT_VALID` code.
  - **L3:** sign-out sets the cookie with its options and `maxAge: 0`.
  - **L5:** focus returns to the opener, or moves to the success notice.
  - **L8:** `parseStoredHash` accepts only N of 2^14 or 2^15, r = 8, p of 1 or 2.
  - **Tests:** a new `api.test.ts` and `actions.test.ts`, plus additions to the DB, UI and helper tests.
  - **Docs:** 03, 04, 07 and 08, including L4 and L7 documented as accepted.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (615), `test:db` (46), `build`, `eval:impact` (unchanged), `npm audit --omit=dev` (0). Also 10 mutation checks (all caught), a race probe (5 checked, 15 refused), and an end-to-end run against `next dev` (passed). Docker Desktop had stopped overnight and was restarted.
- Test results: 615 unit, 46 DB.
- Blockers/limitations: L4 and L7 accepted and documented; the nits are not fixed.
- Decisions: none new.
- Git state: `main`, HEAD `f9f19a3`, Phase 04 uncommitted.
- Handoff path: `progress/handoffs/phase-04-review-ui.md` (updated)

### 2026-10-12 — Phase 04 — IN PROGRESS (security-check fixes applied)
- Scope: the user-selected `/security-check` fixes M-A, L-A, L-B, L-C, L-E, L-F and L-G; L-D documented with an unlock command; Info 3 checked in an end-to-end run; Info 1, 2, 4 and 5 recorded as Phase 05 requirements. The reviewer's privilege, character and HSTS findings were reproduced first.
- Changes:
  - **Migration 0004:** an index on `login_failures (attempted_at)`; revokes UPDATE and DELETE on proposals and candidates; sessions revoke-only through a column grant.
  - **Sign-in:** malformed usernames refused at once; `MAX_CONCURRENT_LOGINS = 4` with `BUSY`; `auth_login` and `auth_logout` log events.
  - **Decisions:** accepting re-validates the stored patch; the row lock was removed (it needs UPDATE privilege) in favour of immutability plus the unique constraint.
  - **Characters:** default-ignorable code points and U+2800 added to both checks and to the path policy.
  - **Headers:** HSTS in production.
  - **CLI:** `reviewer:unlock`.
  - **Docs:** 03, 07, 08 and 10.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (634), `test:db` (49), `build`, `eval:impact` (unchanged), `npm audit --omit=dev` (0), `db:migrate` (0004 applied to dev). Also 10 mutation checks (all caught), and end-to-end runs against `next dev` earlier and against a production build (`next start`): cache headers, HSTS and the `__Host-` cookie verified.
- Observed: one `analysis:run` got `LLM_UNAVAILABLE` on its patch call. The re-run was fine, and the saved outcome recorded the code, so the pipeline handled it as designed.
- Test results: 634 unit, 49 DB.
- Blockers/limitations: an upstream per-IP rate limiter is required before exposing `/login`; the audit trail is tamper-evident, not unforgeable; Phase 05 requirements are recorded.
- Decisions: none new.
- Git state: `main`, HEAD `f9f19a3`, Phase 04 uncommitted.
- Handoff path: `progress/handoffs/phase-04-review-ui.md` (updated)

### 2026-10-12 — Phase 04 — PASS
- Scope: gate closure, confirmed by the user, plus the local checkpoint commit.
- Changes:
  - `STATUS.md` and the handoff mark Phase 04 as PASS.
  - The unit project's test timeout is now 20 seconds. The final gate re-run hit a cold-import timeout in the pool test (`creates one pool lazily`, 5,032 ms), the same cause as the earlier webhook test, so the per-file override was replaced by one project setting. The Phase 01 test files are unchanged from HEAD.
  - No product code changes since the security-check fixes.
- Commands run (all exit 0), re-run on the final tree: `npm run format:check`, `lint`, `typecheck`, `test` (26 files, 634 passed, twice), `test:db` (49 passed), `build`, `eval:impact` (baseline unchanged). `npm audit --omit=dev` (0), the production-mode end-to-end run and the mutation checks were last run after the security-check fixes.
- Acceptance criteria: all Phase 04 exit criteria met locally on fixture data. GitHub writes are out of scope (Phase 05). GitHub Actions CI NOT RUN (no remote).
- Blockers/limitations: an upstream per-IP rate limiter is required before exposing `/login`; the audit trail is tamper-evident, not unforgeable; Phase 05 requirements are listed in the handoff and docs/07.
- Decisions: none new (D-012).
- Git state: `main`; Phase 04 committed locally on top of `f9f19a3`; not pushed.
- Handoff path: `progress/handoffs/phase-04-review-ui.md`

### 2026-10-12 — Phase 05 — IN PROGRESS (implementation complete, gates pending)
- Scope: the approval-gated GitHub write workflow (docs/13, D-013), the live CLI analysis path, and the Phase 04 follow-ups chosen by the user (operator commands, code-only error logging, session housekeeping, no password on stdout).
- **Design gate:** the security reviewer reviewed docs/13 before any write code existed. The verdict was approve with required changes (H1, M1–M6, L1–L4). The changes were applied, and the user chose: accept the bounded app-DB-role trust; display names in PR bodies; one App. A re-review approved, with two wording fixes applied (column-level grants, refs backfill) plus its low items.
- Changes:
  - **Migration 0005:**
    - `pull_requests.head_ref` and `base_ref`;
    - `github_outputs` (binding, step, lease) and `github_output_attempts`;
    - repository identity and output bindings fixed for the app role.
  - **Writer:** `src/lib/github/writer.ts` (per-operation scoped token, two guard layers, no merge).
  - **Live path:** `docs.ts` and `doc-bytes.ts`; reader `contents: read` scoped by repository name; `livePullSchema`; `saveAnalysis` in `store.ts`; `analysis:run --live`.
  - **Publish:** `publish.ts` (write-time re-checks, H1 blob check, leases, resumable steps, adoption rules), `pr-content.ts`.
  - **Route and UI:** `POST /api/reviews/[id]/create-pr`, `CreatePrPanel` and the review view states.
  - **Env:** `GITHUB_WRITES_ENABLED` (off by default) and `GITHUB_APP_SLUG`; log fields `outputId`, `reviewerId`, `step`.
  - **Phase 04 follow-ups:** `reviewer:revoke`, `reviewer:disable`, `reviewer:enable`, `sessions:prune`; `--password-file` (with `*.pw` git-ignored); a cap of 10 sessions per reviewer; `codeOnlyErrors` around page loaders and Server Actions.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (704), `test:db` (94), `build`, `eval:impact` (baseline unchanged), `npm audit --omit=dev` (0), `db:migrate` (0005 applied to dev). Also the operator-command smoke test on the dev database, 20 mutation checks (all caught; one first missed and fixed with a new test), and a production-mode end-to-end run of the create-PR route (6 checks PASS).
- Not run: any live GitHub App or GitHub write; `/review`; `/security-check`; GitHub CI (no remote).
- Decisions: D-013.
- Git state: `main`, HEAD `e37fd24`, Phase 05 uncommitted.
- Handoff path: `progress/handoffs/phase-05-github-workflow.md`

### 2026-10-12 — Phase 05 — IN PROGRESS (`/review` fixes applied)
- Scope: the user-selected `/review` fixes M1–M4, L1, L2, L4, L5 and L10.
- Changes:
  - **Writer:** the token revocation has its own timeout; `guardedTokenClient` is exported; a refused token request becomes `GITHUB_TOKEN_REFUSED`.
  - **Publish:**
    - an opened PR is returned first;
    - configuration and stored data are validated before the claim;
    - the attempt log is inside the guarded block;
    - the branch is confirmed before it is recorded;
    - the retarget check uses the output snapshot;
    - unusable post-write responses become `GITHUB_AMBIGUOUS`, and a refused create becomes `PR_CREATE_REFUSED`;
    - the retryable list is extended;
    - `created` reflects adoption.
  - **Store:** branch names are refreshed when they differ.
  - **Route and API:** `503 WRITES_MISCONFIGURED`; distinct terminal and retryable 502 messages.
  - **Fake GitHub:** honours aborted signals and can return a chosen body.
  - **Docs:** 03, 04, 07, 08 and 13.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (715), `test:db` (105), `build`, `eval:impact` (unchanged), `npm audit --omit=dev` (0); 27 mutation checks (all caught); the production-mode end-to-end run of the create-PR route (7 checks PASS).
- Not run: `/security-check` (the first attempt stopped on an API session limit before reporting); live GitHub; GitHub CI (no remote).
- Git state: `main`, HEAD `e37fd24`, Phase 05 uncommitted.
- Handoff path: `progress/handoffs/phase-05-github-workflow.md` (updated)

### 2026-10-12 — Phase 05 — IN PROGRESS (`/security-check` done, M-1 fixed)
- Scope: `/security-check` (read-only, not an audit), and the user-selected fix for M-1.
- Result: no High. M-1: the bot-authored PR could carry commits pushed by someone with push access.
- Changes:
  - **Publish:** the commit's parent must be the reviewed head; `compare` runs before PR creation (shared `isOurCommit`); the created PR's head must be our commit (`PR_HEAD_MISMATCH`).
  - **PR body:** names the commit.
  - **API:** a message for `PR_HEAD_MISMATCH`.
  - **Fake GitHub:** commit parents in the `PUT` response, and a "before" fault for push races.
  - **Docs:** 04, 07, 08, 10 (rulesets now required before enabling writes) and 13.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (715), `test:db` (109), `build`, `eval:impact` (unchanged), `npm audit --omit=dev` (0). 3 new mutation checks were caught; the publish mutation set was re-run after the refactor.
- Open: L-1 to L-3 and the Info items (handoff).
- Git state: `main`, HEAD `e37fd24`, Phase 05 uncommitted.
- Handoff path: `progress/handoffs/phase-05-github-workflow.md` (updated)

### 2026-10-12 — Phase 05 — PASS
- Scope: gate closure, confirmed by the user, plus the local checkpoint commit.
- Changes: `STATUS.md`, the handoff and docs/13's status mark Phase 05 as PASS. No product code changes since the security-check M-1 fix.
- Commands run on the final tree before the commit (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (715), `test:db` (109), `build`. The publish and fix mutation sets (17) were re-run after the M-1 refactor, all caught.
- Acceptance criteria: all Phase 05 exit criteria met locally against a fake GitHub. A live GitHub App run is NOT RUN (no App); GitHub Actions CI NOT RUN (no remote).
- Open: security-check L-1 to L-3, `/review` L3 and L6–L9, and the Info items (in the handoff).
- Decisions: D-013.
- Git state: `main`; Phase 05 committed locally on top of `e37fd24`; not pushed.
- Handoff path: `progress/handoffs/phase-05-github-workflow.md`

### 2026-10-12 — Phase 06 — IN PROGRESS (CI correction)
- Finding: earlier entries and handoffs say "GitHub CI NOT RUN (no remote)". In fact `origin` existed and GitHub Actions ran for every phase commit: Phase 00 passed, and Phases 01–05 failed at `npm ci`, so no check ever ran in CI after Phase 00. Found by querying the GitHub API at the start of Phase 06.
- Cause, reproduced in a `node:24` container: `package-lock.json` (generated on Windows) lacked `@emnapi/core` and `@emnapi/runtime`, which `npm ci` on Linux requires.
- Hidden behind it: `npm run build` failed without `DATABASE_URL`, because `getCurrentReviewer` evaluated `getPool()` before `await cookies()`, so prerendering threw. Reproduced locally with `DATABASE_URL=` and fixed by reading the cookie first.
- Fix: commit `ff5222e`, user-authorized and pushed. Lockfile regenerated on Linux (8 entries added, no version changes) plus the `auth.ts` order fix. The full pipeline passed locally in Linux containers (`node:24` and `postgres:16-alpine`): install, format, lint, typecheck, 715 unit tests, build, app-role setup, 109 DB tests.
- Records: STATUS rows and each handoff now carry the corrected CI result.
- Result: GitHub Actions run for `ff5222e` completed with **success**, the first passing CI run since Phase 00.

### 2026-10-12 — Phase 06 — IN PROGRESS (held-out dataset pre-registered)
- 14 new scenarios in `fixtures/impact/v3-*.json`, dataset `impact-v3`, written and labelled before the engine or the model was run on any of them.
- Label hash, recorded before the first run: `d8b4e802e6fc9c5943cb0950d8d2dc0df9f474cc7d7749238ed4284571779c25`. This is sha256 over each file's name, its `labels` JSON and its category, in sorted file order.
- Rule for this set: the engine, its config and the prompts are not changed in response to `impact-v3` results in this phase, and labels are not edited after the run. Any later change must be logged with its reason, and the set then counts as tuned.
- Caveat: the same author wrote the engine and these labels, so "held-out" means labelled before running, not independent.

### 2026-10-12 — Phase 06 — IN PROGRESS (all tasks implemented; gates pending)
- Scope: as planned and approved (D-014).
- Changes:
  - **CI fix:** `ff5222e`, pushed, GitHub Actions green.
  - **Evaluation:** held-out `impact-v3` (14 scenarios, pre-registered); `eval:latency`; `eval:llm` re-run on 35 scenarios.
  - **Security evidence:** a table in docs/07.
  - **Phase 05 Low items:** L-1, L-2, L-3, L3, L6, L7, L8 (migration 0006 `docs_partial`) and L9.
  - **Rate limits and kill switches:** per-reviewer limits on decisions and create-PR; kill switches documented.
  - **`db:check-grants`:** added, plus a verified restore procedure. This fixes the restore finding: `pg_restore` with default privileges re-granted `UPDATE`/`DELETE` to the app role.
  - **Reference deployment:** `Dockerfile`, `.dockerignore`, `deploy/`. Verification found and fixed two bugs: the app-role password init kept the placeholder, and every request through the TLS proxy was refused as cross-origin, now fixed by `APP_ORIGIN`.
  - **Playwright:** `@playwright/test` 1.63.0 (devDependency) and `npm run screenshots`, with 6 real screenshots.
  - **Docs:** an as-built Mermaid diagram (02), docs 03, 04, 07, 08, 09, 10, 11, 13 and INDEX, and the README's measured results and known limitations.
  - **Lockfile:** regenerated on Linux again after the Playwright install, which had dropped the `@emnapi` entries; README documents this for Windows contributors.
- Commands run (all exit 0):
  - `npm run format:check`, `lint`, `typecheck`, `test` (742), `test:db` (116), `build`, `npm audit --omit=dev` (0);
  - `eval:impact`, `eval:latency`, `eval:llm` (`llama3.2:3b`);
  - `db:migrate` (0006 applied to dev), `db:check-grants`;
  - the CI pipeline in `node:24` and `postgres:16-alpine` containers;
  - 12 mutation checks (all caught);
  - the fresh setup and restore check, the deployment check and the screenshot capture.
- Not run: `/review`, `/security-check`, a hosted deployment, a live GitHub App run, the `ollama` service in the reference deployment.
- Decisions: D-014.
- Git state: `main`, HEAD `ff5222e` (pushed); the rest of Phase 06 is uncommitted.
- Handoff path: `progress/handoffs/phase-06-evaluation-hardening.md`

### 2026-10-13 — Phase 06 — IN PROGRESS (`/review` fixes applied)
- Scope: the user-selected `/review` fixes M1–M3, L1–L3, L5 and L7.
- Changes:
  - **`src/lib/db/grants.ts`:** complete, column-aware checks, plus database and schema checks; tests extended.
  - **docs/10 restore:** re-applies `REVOKE TEMPORARY`, and dumps are written outside the repository.
  - **Ignore files:** `*.dump`, `*.backup` and `*.sql.gz` in both; `.dockerignore` gains the missing secret entries.
  - **`deploy/compose.yml`:** the serving `ollama` is on the internal network only, and a new one-shot `ollama-pull` service handles downloads.
  - **`APP_ORIGIN`:** normalized, with `503 CONFIG_INVALID` for invalid values.
  - **Init script:** runs in a subshell.
  - **Ollama URL:** guarded.
  - **Report generators:** data-driven scenario counts and adversarial list; reports regenerated (`eval:llm` re-run: counts unchanged, median 2.9 s, p95 7.8 s).
  - **Claims:** corrected in docs 07, 08, README and the handoff.
- Commands run (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (748), `test:db` (120), `build`, `npm audit --omit=dev` (0), `eval:impact`, `eval:llm`, `db:check-grants`. Also the Linux CI mirror (all steps pass), the restore re-check (fails before `REVOKE TEMPORARY`, OK after), the deployment re-verification (all checks pass), the sourced init-script check, and 7 mutation checks (all caught).
- Not run: `/security-check`.
- Git state: `main`, HEAD `ff5222e`; the rest of Phase 06 is uncommitted.

### 2026-10-13 — Phase 06 — IN PROGRESS (`/security-check` done, M-A and L-1 fixed)
- Result: no High; M-A (the proxy published `/login` with no per-IP limit) and L-1 (nested secrets could enter the build image) fixed. L-2 to L-6 and the Info items are open (handoff).
- Changes:
  - **Proxy:** `deploy/Caddyfile` has a webhook-only public site and a private reviewer-UI site on 8444; `deploy/compose.yml` publishes 8444 on loopback, and `APP_ORIGIN` is now `https://localhost:8444`.
  - **Images:** the `Dockerfile` copies an explicit file list; `.dockerignore` uses `**/` secret patterns.
  - **Migrate job:** the documented command uses `run --build`.
  - **Docs:** 07, 08 and 10.
- Verification (Docker):
  - **Public site:** gives 404 except for the webhook.
  - **UI site:** health, session, database and origin checks pass.
  - **Images:** dummy secrets planted in nested folders were absent from both rebuilt images; `/app` held only the listed files; a positive control confirmed the search works.
  - **Found and fixed:** the first build-stage check had used a stale migrate image (`up --build` skips profile services).
- Git state: `main`, HEAD `ff5222e`; the rest of Phase 06 is uncommitted.

### 2026-10-13 — Phase 06 — IN PROGRESS (security-check round 2: L-2, L-3, L-5, L-6, Info)
- Scope: the user-selected fixes L-2, L-3, L-5, L-6 and the cheap Info items; the rest documented.
- Changes:
  - **`db:check-grants` (L-2):** denied SELECT, INSERT and UPDATE are checked with `has_any_column_privilege`; 2 new DB tests (single-column INSERT on `reviewers`, UPDATE on `patch_proposals.patch_text`).
  - **Deployment init (L-3, L-5, Info):**
    - `deploy/initdb/01-app-role.sql` creates the app role `NOLOGIN`, with no `docusync_test`; dev and CI keep `db/init/01-app-role.sql`;
    - `02-app-password.sh` refuses unset, `REPLACE_…` or short passwords and only then grants `LOGIN`;
    - the password is read with `\getenv`, not passed as an argument.
  - **Screenshot script (L-6):** refuses non-fixture data before approving, requires https unless local, prints fixed codes only, and buffers captures until the run succeeds. Screenshots re-captured.
  - **Documented, not fixed:** L-4 (superuser for migrations and operator commands, no app-role assertion), Ollama without authentication, tag-pinned images and Actions, no compose hardening (docs/10, README).
  - **Docs:** 07, 08, 10, 11 and README.
- Verification:
  - **Init with the unedited env examples:** refused with the message; after the restart the app role was refused with both placeholder values.
  - **Full deployment re-check:** passed, including browser sign-in through the private UI site (`__Host-` cookie Secure, HttpOnly, Strict) with and without a spoofed `X-Forwarded-Host`.
  - **Screenshot guard:** `NOT_FIXTURE_DATA` on a temporary live-labelled analysis, no decision recorded, no file written; the temporary data was deleted.
  - **Mutation check:** reverting L-2 is caught by the new tests.
  - **Final gate:** format, lint, typecheck, `npm test` 748, `npm run test:db` 122, build, audit (0) and the Linux CI mirror (748 + 122) pass. One earlier full `npm test` run had an intermittent hang in `llm.test.ts` (handoff, open).
- Git state: `main`, HEAD `ff5222e`; the rest of Phase 06 is uncommitted.

### 2026-10-13 — Phase 06 — PASS
- Scope: gate closure, confirmed by the user, after the commit and push.
- Changes: `STATUS.md` and the handoff mark Phase 06 as PASS. No product code changes since `dacb02e`.
- Commands run on the final tree before `dacb02e` (all exit 0): `npm run format:check`, `lint`, `typecheck`, `test` (748), `test:db` (122), `build`, `npm audit --omit=dev` (0), and the Linux CI mirror (748 + 122).
- GitHub Actions: run 38354197107 on `dacb02e`, all steps green.
- Acceptance criteria: all Phase 06 exit criteria met (handoff). NOT RUN: a live GitHub App write, a hosted deployment, the `ollama` container in the reference deployment.
- Open: the documented deployment limitations (docs/10), L4, L6, L8 and Info from `/review` (handoff), the intermittent `llm.test.ts` hang.
- Decisions: D-014.
- Git state: `main`; Phase 06 committed as `dacb02e` and pushed; the PASS record is a follow-up commit.
- Handoff path: `progress/handoffs/phase-06-evaluation-hardening.md`

### 2026-10-15 — After Phase 06 (PASS) — deployment limitations fixed, live read run
- Scope: the user asked for the live GitHub App run and the documented deployment limitations. This is follow-up work after the Phase 06 gate, not a new phase.
- Changes:
  - **Compose and Dockerfile:** images pinned by `@sha256:` digest; Ollama on its own internal `model` network (app only); the proxy and app read-only, `cap_drop: ALL`, `no-new-privileges`.
  - **CI:** both Actions pinned by commit SHA; the Postgres service pinned by digest.
  - **`db:check-grants`:** reports app role attributes and memberships; 1 new DB test.
  - **Docs:** 07, 10, 13 and README.
- Verification:
  - **Deployment (Docker):** the full check passed again; read-only roots, `NoNewPrivs` and capabilities confirmed in the running containers; sign-in through the proxy still works.
  - **Commands:** `test:db` 123 passed; `lint`, `format:check` and `db:check-grants` pass.
  - **Live read run (sandbox repo, private App):** ingest and analysis worked; the engine flagged the right doc; with `llama3.2:3b` the patch was rejected by the validator in 3 runs.
- NOT RUN: GitHub writes against a live App (no validated proposal), the `ollama` container in the deployment, a non-superuser owner (needs a decision).
- Incident: part of the sandbox App's private key was printed into the chat transcript by a masking command. The user was told to rotate it, and did.
