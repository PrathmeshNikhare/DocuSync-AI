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
