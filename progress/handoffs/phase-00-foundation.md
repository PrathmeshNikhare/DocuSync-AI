# Handoff — Phase 00: Foundation

- Date: 2026-10-10
- Status: PASS (user-confirmed 2026-10-10). All local checks PASS. `/review` done, and findings M1, M2, L1, L3, L4 and the Nits are fixed. `/security-check` done, with security M1, L5, L8 and the docs/07 claim corrections fixed. Committed locally; not pushed.
- Branch: `main` (no remote)
- HEAD commit: `8762d4f` (Phase 00 checkpoint) on top of harness baseline `7045a66`, plus a follow-up commit marking the phase PASS
- Working tree: clean after the Phase 00 checkpoint commit (local only, not pushed)
- Active phase after handoff: 00 is complete; Phase 01 is NOT STARTED and waits for user direction

## Outcome

This phase delivers a Next.js 16.4 App Router foundation using TypeScript 5.9 in strict mode, Tailwind 4, ESLint 9, Prettier, Vitest 5 and Node 24. It also adds shared Zod contracts, lazy server-only environment validation and `pg` pool, a static liveness route, CI, and docs updated to match the code. There is no product functionality, and no GitHub, Ollama or database query paths.

## Files changed

- `package.json` / `package-lock.json`: scripts `dev build start lint typecheck test format format:check`, plus `engines` set to Node `>=24 <25`.
- `.nvmrc` (24), `.gitattributes` (LF line endings), `.prettierrc.json`, `.prettierignore` (Markdown excluded).
- `tsconfig.json` (from the scaffold, plus `noUncheckedIndexedAccess`), `eslint.config.mjs`, `next.config.ts` (`agentRules: false` keeps `next dev` from editing AGENTS.md; `poweredByHeader: false`), `vitest.config.mts` (aliases `@/` and stubs `server-only`).
- `src/app/layout.tsx`, `page.tsx`, `globals.css`: a minimal page with no external fonts.
- `src/app/api/health/route.ts` and its test: static liveness check only.
- `src/lib/schemas.ts` and its test: repo path, git SHA, error code, evidence reference, impact candidate, analysis state (status, transitions and timestamp rules), patch proposal, review decision (client input schema plus server-built record schema), API error envelope. Text is checked to be storable in Postgres (no NUL, valid Unicode).
- `src/lib/env.ts` and its test: `DATABASE_URL` validation. Errors name the invalid keys and never their values.
- `src/lib/db/pool.ts` and `pool.test.ts`: a lazy pool whose error listener logs the error code only. The tests don't connect to a database.
- `src/test/server-only-stub.ts`: test-only alias target.
- Edited: `.github/workflows/ci.yml` (Node from `.nvmrc`, format check, `persist-credentials: false`, 15-minute timeout), `docker-compose.yml` (binds `127.0.0.1` only), `docs/04` (decision verbs, no client reviewer id), `.env.example` (password matches compose), `.gitignore` (`*.tsbuildinfo`, `next-env.d.ts`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.envrc`, `.npmrc`), `README.md` (verified setup commands), `AGENTS.md` (Next 16 docs pointer), `docs/02`, `docs/03` (migration convention, review-decision approval binding), `docs/07` (implemented controls, including what the path schema still accepts and which claims are untested), and the progress files.

## Verification

Commands run on Windows 11 with Node v24.11.0 and npm 11.6.1. The install, dev and start rows come from the first run (after `rm -rf node_modules .next`). The format, lint, typecheck, test, build and Docker rows were rerun after the review fixes (after `rm -rf .next`; dependencies unchanged).

| Command | Observed | Result |
|---|---|---|
| `npm ci` | 506 packages added; lockfile unchanged | PASS |
| `npm run format:check` | exit 0 | PASS |
| `npm run lint` | exit 0, 0 problems | PASS |
| `npm run typecheck` (`next typegen && tsc --noEmit`) | exit 0 | PASS |
| `npm test` | 4 files, 96 tests passed (rerun after the security fixes) | PASS |
| `next start -p 3126` + `curl -I` on `/` and `/api/health` | no `X-Powered-By` header (it was present before the fix); 200 and `{"status":"ok"}` | PASS |
| `git check-ignore` on `a.key a.p12 a.pfx .envrc .npmrc` | all ignored; `.env.example` still tracked; no tracked file newly matched | PASS |
| `npm run build` (no `.env` present) | exit 0; `/`, `/_not-found` and `/api/health` prerendered static | PASS |
| `npm run dev` with `.env.local` copied from `.env.example` | `/api/health` returned `{"status":"ok"}`, `/` returned 200; AGENTS.md hash unchanged | PASS |
| `next start -p 3123` | `/api/health` 200, POST 405, `/` 200 with the h1 | PASS |
| `npm ls express prisma @prisma/client zustand django vite --all` | none present except `vite@8.3.4`, pulled in by `vitest` | PASS (Vite is test-only, see D-006) |
| `git check-ignore -v .env .env.local key.pem next-env.d.ts` | all ignored; `.env.example` not ignored | PASS |
| `docker compose config --quiet` | valid | PASS |
| `docker compose up -d --wait postgres` (binds `127.0.0.1:5432`) | fails with "ports are not available", because native PostgreSQL 18 holds `0.0.0.0:5432` on this machine | BLOCKED (machine environment) |
| Same, with a temporary override mapping `127.0.0.1:55432:5432`, then a host `pg` query using the `.env.example` credentials on port 55432 | Healthy; `docusync`, PostgreSQL 16.15 | PASS |
| `psql` over container IP with the `.env.example` password (first run) | `ok`; the old password `change-me` is rejected | PASS |
| Mutation checks: disabled the `isWellFormed` check, then the timestamp-order check | 1 targeted test failed each time; source restored | PASS |
| Reviewer probe inputs re-run against the fixed schemas | all rejected except L2 (deferred to Phase 03) | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities | PASS |
| `npm audit` (all) | 5 high, all in the dev-only `braces` chain | Noted |
| GitHub Actions CI | no remote | NOT RUN |

## Acceptance criteria

- [x] Dependencies install reproducibly: a clean `npm ci` left the lockfile unchanged.
- [x] Lint, type-check, tests and production build pass: see the table.
- [x] Runtime schemas have meaningful positive and negative tests: 96 tests, including the required approval-binding fields on review records, each negative case also checking which field failed. They cover traversal, absolute, Unicode control, format and surrogate characters, ADS and trailing-dot paths, NUL in text, analysis timestamp rules, client-supplied reviewer ids, strict unknown keys, size limits, invalid transitions, `likely_affected` without evidence, `edited` without a patch, raw error text rejected as an error code, and env errors that never echo the secret.
- [x] Secrets are excluded from Git: checked with `git check-ignore`.
- [x] README setup commands are verified: all were run, with the host-port conflict documented.
- [x] Architecture and security docs match the implementation: "Implemented" sections added to docs 02 and 07.
- [x] Status, phase log and handoff are updated.
- [ ] GitHub Actions CI green: NOT RUN (no remote).
- [x] `/review`: done. M1, M2, L1, L3, L4 and the Nits are fixed; L2, L5, L6 and L7 are deferred (see risks).
- [x] `/security-check`: done (read-only, not a formal audit). Security M1, L5 (header only), L8 and the doc corrections are fixed; the rest are deferred (see risks).

## Decisions

D-006 (Node 24 LTS and toolchain baseline) and D-007 (SQL migration convention, runner deferred to the first migration). Both were approved by the user in this session.

## Risks and limitations

- The health route is prerendered at build time because `cacheComponents` is on. It proves the server responds and nothing more.
- `repoPathSchema` checks syntax only. Allowed-docs-path policy, symlink checks and percent-decoding rules belong to the Phase 03 patch validator.
- The analysis transition rules live in code only. A DB constraint will be added together with the tables.
- GitHub Actions use version tags (`@v4`), not commit SHAs. Pin them before production (Phase 06).
- 5 high-severity `npm audit` findings exist in dev-only tooling. Re-check them on dependency bumps.
- On this machine, a native PostgreSQL service holds port 5432, so `docker compose up` now fails loudly instead of starting a container that can't be reached. Phase 01 needs that service stopped, or a different host port.
- Security items deferred: M2 (= review L2, doc-path allowlist and model-output schema; Phase 03), L1 (`%?#` in paths, so pass paths as Octokit parameters; Phase 01), L2 (case and Unicode-form comparison; Phase 03), L3 (reserved names, leading `-`, segment length; Phase 03, only if the filesystem or git CLI is used), L4 (make invisible and bidi characters visible in the UI; Phase 04), L5 (CSP and security headers; Phase 04), L6 (pin Actions by SHA, install scripts, Dependabot; Phase 06), L7 (separate database users, pool timeouts; Phase 01), I2 (fixed messages in `apiError`), I4 (`isWellFormed` is ES2024, so take care if the schemas are imported client-side). No control from docs/07 is fully implemented and tested yet; most are out of Phase 00 scope.
- Review items deferred: L2 (a separate model-output schema with no `validationStatus` or evidence, plus the allowed-path policy; Phase 03), L5 (test for pool log redaction, keeping the pool on `globalThis` for dev reloads; when queries are first added), L6 (record `cacheComponents` and `partialPrefetching` as a decision), L7 (docs/03 `patch_proposals` columns: rationale, evidence, provider).
- `repoPathSchema` now rejects `:` and segments ending in `.` or a space. Legitimate POSIX filenames with those characters can't be analyzed. That's a deliberate conservative trade-off.
- `next build` was verified on Windows only. Linux CI is unverified.

## Recovery / rollback

The harness baseline is commit `7045a66`, and Phase 00 is commit `8762d4f` plus a status-only commit on top of it. To undo Phase 00 without rewriting history, run `git revert 8762d4f` (and the PASS status commit after it). Don't use `git reset --hard` without explicit approval.

## Next session must verify

- `git status`: Phase 00 changes are present (or committed, if the user has done so).
- Rerun `npm ci && npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`.
- `grep -n agentRules next.config.ts` still shows `false`, and AGENTS.md has no Next-managed block.
- That the deferred review and security items are still tracked, especially security L7 and L1 before Phase 01 writes its first migration or GitHub call.

## Next phase prerequisites

- Phase 00 changes committed, if the user authorizes it.
- Deferred review and security items acknowledged by the user.
- Ideally, CI green on GitHub once a remote exists.
- For Phase 01: decide how to resolve the port-5432 conflict, and create a GitHub App or test fixtures. Phase 01 is read-only ingestion, so no write permissions.

## Correction (2026-10-12, during Phase 06)

This handoff says GitHub CI was not run because there was no remote. That was wrong: `origin` (github.com/PrathmeshNikhare/DocuSync-AI) existed, and GitHub Actions ran on this phase's commit. The run passed. Local checks were unaffected.
