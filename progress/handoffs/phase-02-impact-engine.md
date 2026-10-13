# Handoff — Phase 02: Evidence-backed impact engine

- Date: 2026-10-10 (updated 2026-10-11)
- Status: PASS (user-confirmed 2026-10-11). All local checks PASS, re-run on the final tree before the commit. `/review` done, with M1-M6, L1-L5 and the nits fixed (engine `deterministic-0.2.0`). `/security-check` done, with H1, H2, M1, M2, L1-L5 and the doc claims fixed (engine `deterministic-0.3.0`). Committed locally; not pushed.
- Branch: `main` (no remote)
- HEAD commit: the Phase 02 checkpoint commit (the commit containing this handoff; see `git log`), on top of `55989bf` (Phase 01 PASS).
- Working tree: clean after the commit (local only, not pushed). Ignored local files: `.env` and `.env.local`.
- Active phase after handoff: 02 is complete; Phase 03 is NOT STARTED and waits for user direction

## Outcome

This phase delivers a deterministic, explainable impact engine: `analyzeImpact(snapshot, docs, config?)` in `src/lib/impact-engine/`. It extracts signals from the changed lines of a Phase 01 `PullRequestSnapshot`: env vars, exported names, API routes, npm scripts, config keys and file paths. It finds docs that mention them, scores each doc with fixed integer rule points, and returns `likely_affected`, `verify` or `unlikely_affected` candidates with bounded evidence quoting exact source and doc lines.

Labelled datasets `impact-v1` (13 synthetic scenarios) and `impact-v2` (8 regression scenarios added after the review, labelled before the fixes) and an evaluation harness produce the baseline in `docs/evaluation/impact-baseline.md`: **TP 12, FP 1, FN 1, TN 26** over 40 scored docs on engine `deterministic-0.3.0` (`impact-v1` 9/1/1/15; `impact-v2` 3/0/0/11). The FP and the FN are the two deliberately adversarial scenarios in `impact-v1`.

Scope is the engine plus fixtures only, as the user chose. Nothing fetches docs from GitHub, persists results or processes queued analyses (D-009, D-010).

## Files changed

- **Engine:** `src/lib/impact-engine/config.ts` (rule weights, thresholds, `ENGINE_VERSION`), `signals.ts` (file classification, diff line numbering, extractors), `match.ts` (symbol, route and path mentions; Markdown link resolution), `engine.ts` (`analyzeImpact`), `evaluate.ts` (scenario schema, scoring, precision/recall, report).
- **Tests:** `signals.test.ts`, `match.test.ts`, `engine.test.ts`, `evaluate.test.ts`.
- **Schemas** (`src/lib/schemas.ts`): evidence `side`; candidate `rankPoints` and `rules`; `docFileSchema` plus `DOC_LIMITS`. `schemas.test.ts` candidate fixture updated for the new required fields.
- **Data:** `fixtures/impact/*.json` (21 labelled scenarios: 13 `impact-v1`, 8 `impact-v2`).
- **Generated report:** `docs/evaluation/impact-baseline.md`.
- **Scripts:** `scripts/eval-impact.ts`, `scripts/analyze.ts`, plus the package scripts `eval:impact` and `analyze`.
- **Docs:** docs 02, 05 and 08, README, and D-010 in `progress/DECISIONS.md`.

## Verification

Run on Windows 11, Node v24.11.0.

| Command | Observed | Result |
|---|---|---|
| Phase 01 gate re-check: format:check, lint, typecheck, test, test:db | all exit 0; 227 unit and 18 DB tests | PASS |
| Fixture patch check (Phase 01 normalizer on every scenario) | all `included`, except 2 intentionally `omitted` | PASS |
| `npm run format:check` | exit 0, after formatting the fixture JSON; parsed fixture content verified identical before and after | PASS |
| `npm run lint`, `npm run typecheck` | exit 0 | PASS |
| `npm test` | 16 files, 312 passed at first; 341 after the review fixes (114 in the impact engine) | PASS |
| `impact-v2` on the unfixed engine (`deterministic-0.1.0`), recorded before any fix | TP 2, FP 6, FN 1, TN 5 | Recorded |
| Reviewer probes re-run after fixes | long path and emoji no longer throw; truncated and rejected files reported; self-documented var, version bump, workflow `run:`, doc typo and root route no longer flagged; hostile link line 80,000 characters: 4.5 s before, 0 ms after | PASS |
| Review-fix mutation checks (M3, M6, L1, M5, M1, L4) | each caught (2, 3, 3, 1, 2 and 1 failing tests); sources restored | PASS |
| `npm run build` | exit 0 | PASS |
| `npm run test:db` | 18 passed | PASS |
| Security probes re-run after fixes | route matcher at 16 segments: 8.8 s before, 2 ms after; JSON key/value at 8,000 spaces: 70 s before, 0 ms after; README fallback capped at verify; rename evidence at the old path; rename matched under the signal cap; duplicate doc paths rejected | PASS |
| Security-fix mutation checks (H1, H2, M2, L1, L2, L3, L5, work budget) | all caught. H1 and H2 reverted made the suite hang until the timeout, which reproduces the original denial of service | PASS |
| `npm test` after security fixes | 16 files, 353 passed (126 in the impact engine) | PASS |
| `npm run test:db` after security fixes | 18 passed (after restarting Docker Desktop, which had stopped again) | PASS |
| `npm run eval:impact` | 21 scenarios on `deterministic-0.2.0` and again on `0.3.0`: TP 12, FP 1, FN 1, TN 26 (v1 9/1/1/15 unchanged; v2 3/0/0/11); report matches the committed file (tested) | PASS |
| `npm run test:db` after review fixes | first run failed with `ECONNREFUSED` because Docker Desktop had stopped; after `docker desktop start` and `docker compose up`, 18 passed | PASS |
| Final gate re-run before the PASS commit: format:check, lint, typecheck, test, test:db, build, eval:impact | all exit 0; 353 unit and 18 DB tests; TP 12, FP 1, FN 1, TN 26 | PASS |
| `npm run analyze -- --fixture linked-file-renamed` | `docs/architecture.md` `likely_affected`, evidence quotes the link line | PASS |
| Mutation checks: removal multiplier set to 1; missing-patch cap removed; script word characters removed | caught by 4, 1 and 1 failing tests. The third was first missed, so a pinning test was added. Sources restored | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities | PASS |

**Process notes, for honesty:**
- The labels were written before any engine code.
- After the first run I fixed one matching bug (`fix` was matched inside `lint:fix`). It corrected an evidence entry and changed no metric.
- No weights or thresholds were changed after seeing results.

## Acceptance criteria

- [x] Candidate results satisfy shared schemas: every candidate from every scenario passes `impactCandidateSchema` (tested), and the engine validates its own output.
- [x] Evidence points to actual fixture source and is bounded: a test checks each evidence excerpt against the exact doc line or the exact changed line at its side and line number. Excerpts are 300 characters or less, with at most 12 pieces of evidence per candidate.
- [x] False-positive and false-negative cases are represented in tests: `false-positive-generic-word` and `false-negative-behaviour` are asserted and counted in the metrics.
- [x] Deterministic baseline metrics are calculated from labelled fixtures: `npm run eval:impact`, with a staleness test.
- [x] No uncalibrated score is presented as a probability: `rankPoints` is documented as rule points, the report states it, and a test rejects probability or confidence wording in reasons.
- [x] Docs, status and handoff updated.
- [x] `/review`: done. All findings fixed (M1-M6, L1-L5, nits). The new `impact-v2` scenarios were labelled before the fixes, and their before and after numbers are recorded in docs/08.
- [x] `/security-check`: done (read-only, not an audit). Fixed H1 (exponential route regex), H2 (polynomial `package.json` regex), M1 (value/context caps, related docs once per kind, per-doc link index, total doc and line-scan budgets), M2 (honest README fallback; `likely_affected` needs doc evidence), L1 (rename evidence path), L2 (removals first under the signal cap), L3 (duplicate doc paths rejected), L4 (excerpt window around the match), L5 (plain-text names in engine-written fields), and the doc claims. Deferred: worker-thread timeout and memory limit (runner phase), and validation of snapshot and config inputs (runner phase).

## Decisions

D-010 (rule-based deterministic engine; live analysis deferred), approved by the user together with the schema additions.

## Risks and limitations

- **Review fixes are validated on scenarios written for them:** `impact-v2` targets the fixed findings, so its perfect after-score shows the fixes work, not that the engine generalizes.
- **The package.json heuristic can guess wrong:** keys whose block header is out of view but which aren't scripts, with non-version string values (e.g. a custom field), are taken to be scripts.
- **Work is budgeted, time is not:** signals (300), doc characters (10,000,000) and scanned doc lines (20,000,000) are capped, with notes when hit, and the known super-linear regexes are fixed and regression-tested. There is no wall-clock timeout or memory limit yet; the runner must run analysis in a worker thread with `resourceLimits` and a timeout.

- **Small dataset with a shared author:** the labels and the engine have the same author, and the scenarios are synthetic. The metrics describe these 21 fixtures only.
- **Regex extraction misses things:** dynamic `process.env[name]`, re-exports, non-TS/JS languages, and multi-line export lists.
- **Matching is case-sensitive and whole-word.** It can't find paraphrased references, so behaviour-only changes are missed. Generic exported names (e.g. `config`) collide with prose.
- **README fallback:** a new env var or script that no doc mentions falls back to README.md when no doc lists related names. It is capped at `verify` (no doc evidence), but may still be noisy on real repositories.
- **Not connected end to end:** no live doc fetching (needs the Contents permission, with tree and blob limits), no persistence, no runner. `analyze` works on fixtures only.
- **Large docs:** at most 3 mentions per doc per signal are kept, and the doc input is capped (500 docs, 200,000 characters each). Docs over the cap make the engine throw instead of truncating.
- **Deferred items from Phase 01** remain as listed in that handoff.

## Recovery / rollback

Phase 02 is one commit on top of `55989bf`. To undo it without rewriting history, run `git revert <phase-02-commit>`. Don't use `git reset --hard` without explicit approval.

## Next session must verify

- `git log` shows the Phase 02 commit and `git status` is clean.
- `npm test` passes, and `npm run eval:impact` leaves `docs/evaluation/impact-baseline.md` unchanged (`git diff --exit-code docs/evaluation`).
- That the deferred items (worker-thread timeout and memory limit; snapshot and config validation) are still tracked.

## Next phase prerequisites

- Phase 02 is PASS and committed (done).
- Before Phase 03 can use the engine on real PRs, decide on live doc fetching (the Contents permission) and on persistence or a runner (D-009, D-010). Phase 03 (LLM patches) can still be built and evaluated on these fixtures without them.
- Phase 03 should compare LLM-assisted mode with this deterministic baseline on the same dataset (docs/05).

## Correction (2026-10-12, during Phase 06)

This handoff says GitHub CI was not run because there was no remote. That was wrong: `origin` (github.com/PrathmeshNikhare/DocuSync-AI) existed, and GitHub Actions ran on this phase's commit. The run failed at `npm ci`: the lockfile, generated on Windows, lacked the optional `@emnapi` packages npm on Linux expects, so no check ran in CI. Fixed in Phase 06 by commit `ff5222e`, which also fixed a build failure hidden behind the install step. Local checks were unaffected.
