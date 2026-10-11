# Handoff — Phase 03: Ollama analysis and patch proposals

- Date: 2026-10-11
- Status: PASS (user-confirmed 2026-10-11). Implementation, tests, the live evaluation and docs are done, and all local checks PASS, re-run on the final tree before the commit. `/review` done, with M1-M4, L1-L3, T1-T3 and the doc claims fixed. `/security-check` done, with M1-M4, L1-L3, I1, I3 and the doc claims fixed. Phase changes not committed.
- Branch: `main` (no remote)
- HEAD commit: the Phase 03 checkpoint commit (the commit containing this handoff; see `git log`), on top of `65d3b0f` (Phase 02 PASS).
- Working tree: clean after the commit (local only, not pushed). Ignored local files: `.env` and `.env.local`.
- Active phase after handoff: 03 is complete; Phase 04 is NOT STARTED and waits for user direction

## Outcome

A replaceable LLM provider with an Ollama implementation assesses the deterministic engine's flagged candidates and proposes documentation edits. The server owns the patch (D-011): the model returns `{find, replace}` edits for a file it doesn't choose. The server drops edits it can't place, renders a unified diff, and validates it against the doc-path allowlist, the base blob SHA, strict application, size and breadth limits, relatedness and unsafe content. Only validated proposals are returned, with evidence, `headSha`, `baseBlobSha` and model metadata. Without a model, or when it fails, the result is deterministic-only with an explicit `modelStatus`. Measured on all 21 fixtures with `llama3.2:3b` (run 7): 8 valid proposals out of 12 requests, 7 of 12 labels passed. Model-assisted flagging equals the deterministic baseline, because the model never demoted a doc.

## What was implemented and why

- `src/lib/llm/provider.ts`: `LlmProvider` (a transport with one `chat` method; no tools or credentials) and `generateStructured`: JSON data in, Zod-validated JSON out, one retry for invalid output and none for transport failures; metadata-only logging.
- `src/lib/llm/ollama.ts`: `/api/chat`, non-streaming, schema-constrained (`format`), temperature 0, seed 42, configurable `num_ctx`; timeout covers the body; 256 KiB reply cap; redirects refused; clear failure codes.
- `src/lib/llm/prompts.ts`: `assess-v1` and `patch-v1` system prompts (data is untrusted) and the output schemas. The patch schema has no path field.
- `src/lib/patches/`: `policy.ts` (allowed doc paths), `blob-sha.ts` (git blob SHA-1), `diff.ts` (`placeableEdits`, `renderEdits`, strict `applyUnifiedDiff` reusing `parseHunks`), `validate.ts` (`validatePatch`). Pure string code, meant to validate reviewer-edited patches in Phase 04 too.
- `src/lib/assist/`: `assistImpact` (orchestration and fallbacks, at most 10 candidates per PR, no patch without change facts), `context.ts` (bounded context), `evaluate.ts` (assisted scoring, patch-label checks, percentiles, report).
- `src/lib/read-body.ts`: `readBodyLimited` moved out of `github/webhook.ts` (now also used for Ollama replies), with its type widened to anything with headers and a body. Behaviour unchanged; its tests still pass.
- `src/lib/env.ts`: `getOllamaEnv` (lazy; undefined without `OLLAMA_MODEL`; URL must be http(s) without credentials; timeout and context bounds). `src/lib/log.ts`: `model`, `promptVersion` and `durationMs` fields.
- `src/lib/schemas.ts`: `modelMetaSchema`; `patchProposalSchema` gains `headSha` and `validationIssues` (consistent with `validationStatus`), and `candidateId` becomes optional until persistence; new `modelAssessmentSchema`.
- `scripts/propose.ts` (`npm run propose`), `scripts/eval-llm.ts` (`npm run eval:llm`), `npm run test:ollama` (new Vitest project `ollama`), `fixtures/patches/labels.json` (`patch-v1`).

## Files changed

Modified: `.env.example`, `README.md`, `docs/02-architecture.md`, `docs/05-impact-engine.md`, `docs/06-llm-and-patches.md`, `docs/07-security.md`, `docs/08-testing-and-evaluation.md`, `package.json`, `progress/DECISIONS.md`, `progress/PHASE-LOG.md`, `progress/STATUS.md`, `src/lib/env.ts`, `src/lib/env.test.ts`, `src/lib/github/webhook.ts`, `src/lib/github/webhook-handler.ts`, `src/lib/github/webhook.test.ts`, `src/lib/log.ts`, `src/lib/schemas.ts`, `src/lib/schemas.test.ts`, `vitest.config.mts`.

New: `src/lib/llm/` (provider, ollama, prompts, `llm.test.ts`, `ollama.ollama.test.ts`), `src/lib/patches/` (policy, blob-sha, diff, validate, `patches.test.ts`), `src/lib/assist/` (assist, context, evaluate, `assist.test.ts`), `src/lib/read-body.ts`, `scripts/propose.ts`, `scripts/eval-llm.ts`, `fixtures/patches/labels.json`, `docs/evaluation/llm-assisted.md`, this handoff.

## Checks and outcomes

| Command / check | Outcome | Result |
|---|---|---|
| Phase 02 gate re-check before starting | `65d3b0f`, clean tree; checks recorded at the Phase 02 commit | PASS |
| `npm run format:check`, `lint`, `typecheck` | exit 0 | PASS |
| `npm test` | 19 files, 505 passed (was 353); 532 after the review fixes; 567 after the security-check fixes | PASS |
| `npm run test:db` | 18 passed | PASS |
| `npm run test:ollama` (`OLLAMA_MODEL=llama3.2:3b`) | 4 passed; without `OLLAMA_MODEL` it exits 1 instead of skipping | PASS |
| `npm run build` | exit 0 | PASS |
| `npm run eval:impact` | TP 12, FP 1, FN 1, TN 26; `impact-baseline.md` unchanged | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities | PASS |
| Mutation checks (path policy, stale base, new-URL rule, strict context match, removal share, change-facts guard, cited-evidence range, bounded retry, longest overlapping edit, line-less evidence hunks) | all 10 caught; sources restored | PASS |
| `npm run eval:llm`, 7 runs | see docs/08; the committed report is run 7 (its latency roughly doubled for an unidentified reason) | Recorded |
| Security-check probes (read-only, before fixing) | accepted: escaped/entity slashes, `http:host`, `\\host`, dotless hosts, `smb://`, `mailto:`, bare e-mail, image beacon, quoted `>` handler, zero-padded reference, entity `data:`, HTML comment; allowed paths: `requirements.txt`, `CLAUDE.md`, `AGENTS.md`, `*.mdx`; `toTerminalSafeJson` did not round-trip U+E0041. All rejected or fixed after the changes | PASS |
| Security-fix mutation checks (link resolution, unknown references, new raw HTML, zero-padded references, agent files, no `.txt`, prose withheld, prompt-size guard, evidence budget, https beyond loopback, surrogate pairs, body timeout) | all 12 caught; sources restored | PASS |
| Link/HTML extraction on 1 MB hostile known text | worst about 230 ms (`href="` repeated) | PASS |
| Review probes (run read-only before fixing) | empty `OLLAMA_*` values threw; `//host`, `www.`, host-prefix links, reference `javascript:` links, `<img/onerror>`, split tags and mid-line CR were accepted; the same request returned a byte-identical reply (retry no-op); `linked-file-renamed` cited `[1, 2]` of 2 items. All rejected or fixed after the changes | PASS |
| Review-fix mutation checks (protocol-relative links, exact URL match, entity decoding, slash before handler, reference definitions, mid-line CR, empty env values, retry seed, citation bound, no-op edits, throwing provider) | all 11 caught (exact URL match only after adding a host-prefix test); sources restored | PASS |
| Validator timing on 7,900-character hostile lines | worst 39 ms (a run of `<`) | PASS |
| Final gate re-run before the PASS commit: format:check, lint, typecheck, test, test:db, build, eval:impact | all exit 0; 567 unit and 18 DB tests; baseline unchanged. `test:ollama` (4 passed) and `eval:llm` (run 7) were last run after the security-check fixes, with no code change since | PASS |
| `npm run propose -- --fixture env-var-renamed` | with and without `OLLAMA_MODEL`; an unknown fixture gives `FIXTURE_NOT_FOUND` | PASS |

## Acceptance criteria

- [x] Invalid model output is rejected: non-JSON, wrong types, extra keys (including a self-chosen `targetPath`), out-of-range evidence citations and oversized replies, after one bounded retry (tested).
- [x] Timeout or unavailable Ollama gives a clear failure or a deterministic-only result: mocked 404, 5xx, refused connection, timeout and a hung server; live missing model and unreachable server; `modelStatus` `not_configured`, `unavailable` or `partial` (tested).
- [x] Path traversal and unrelated or broad patches are rejected: the path-attack table, header mismatch, size, hunk, line and removal limits, relatedness, unsafe content, and an injection-obeying mock model (tested).
- [x] Valid proposals include evidence and source revision: `headSha`, `baseBlobSha` (git blob SHA, checked against `git hash-object` vectors), the deterministic evidence unchanged, and model metadata (tested).
- [x] Model-assisted evaluation is compared with the deterministic baseline: `npm run eval:llm` against a real Ollama, with all 5 runs and the tuning disclosed in docs/08.
- [x] Docs, status and handoff updated.
- [x] `/review`: done (the reviewer agent hit an API rate limit, so it was done in the main session). Fixed M1 (URL bypasses), M2 (link and HTML bypasses), M3 (empty env values), M4 (no-op retry, out-of-range citations), L1 (no-op edits), L2 (throwing provider), L3 (mid-line CR), T1-T3, and doc claims. Not fixed, documented: L4 (links in the PR diff count as known), L5 (weak relatedness), L6 (latency counts requests).
- [x] `/security-check`: done (read-only, not an audit). Fixed M1 (links resolved like a browser, exact match), M2 (new raw HTML rejected, references decoded without a digit cap), M3 (allowlist narrowed to `.md`/`.markdown`, agent instruction files denied; D-011 updated with the user's approval), M4 (unsafe model prose withheld), L1 (evidence budget, smaller budgets, prompt-size guard), L2 (new HTML comments rejected; look-alike letters still not detected), L3 (https beyond loopback unless opted in; hardened version check), I1 (surrogate pairs), I3 (body-timeout test). Deferred: L4 (stale-base check is tautological until docs come from GitHub at `headSha`; Phase 04/05), I2 (Windows superscript device names), I5 (CI actions pinned to tags).

## Decisions

D-011 (the model proposes edits; the server renders, validates and owns the patch; candidates-only assisted mode; root and `docs/**` Markdown allowlist, narrowed after the security check to `.md`/`.markdown` without agent instruction files; schema changes), approved by the user with the plan.

## Risks and limitations

- **Evaluation is small and tuned:** 21 synthetic scenarios. The assist policy was changed four times, and the assessment prompt once (citation bound), after reading output on these fixtures. Only run 1 (0 valid patches) is untuned. Labels did not change.
- **The assessment step adds nothing with `llama3.2:3b`:** it said `needs_update` for every assessed doc, including the known false positive. Assisted mode also can't recover docs the engine missed.
- **Validation bounds patches; it doesn't judge them:** one run-2 patch duplicated a line and dropped formatting yet passed. `label_pass` checks a few strings. Human review stays mandatory.
- **Dropping unplaceable edits is a policy choice:** the reviewer sees only the edits that survive, and the outcome lists what was dropped, so a proposal can be a partial update.
- **The relatedness rule is heuristic:** it can block a valid far-away edit or allow an off-topic one that names a PR term.
- **Time:** worst case about 80 minutes per PR at the default timeout (10 candidates × 4 calls). There is no total budget or per-repository quota yet (runner phase).
- **Not wired up:** no persistence, no runner, no live doc fetching (D-009, D-010). The stale-base check can't fire in the current flow (security L4): docs aren't tied to `headSha` and the hash is over a JS string. Phase 04/05 must use GitHub's blob SHA at `headSha`, hash raw bytes and re-check before writing.
- **Validator limits:** it narrows what a patch can carry but is not a sanitizer. Look-alike letters are not detected, links planted in the PR diff count as known, and new `<…>` text inside code spans is rejected (a deliberate false positive).
- **Model-written text** (explanations, rationales) may contain invisible characters. The CLIs escape them; the Phase 04 UI must render them as plain text.

## Recovery / rollback

Phase 03 is one commit on top of `65d3b0f`. To undo it without rewriting history, run `git revert <phase-03-commit>`. Don't use `git reset --hard` without explicit approval. No database or external state was changed; the evaluation only read from the local Ollama.

## Next session must verify

- `git log` shows the Phase 03 commit and `git status` is clean.
- `npm test` passes and `npm run eval:impact` leaves `docs/evaluation/impact-baseline.md` unchanged.
- With Ollama running and `OLLAMA_MODEL` set, `npm run test:ollama` passes.

## Next phase prerequisites

- Phase 03 is PASS and committed (done).
- Phase 04 (review UI) must persist proposals (`candidateId`), render model text and patches as plain text with invisible characters made visible, and run `validatePatch` on reviewer-edited patches. It must also bind approvals to `headSha`, `baseBlobSha` and the patch hash (docs/07 controls 9 and 10).
- Live use still needs doc fetching (the Contents permission, symlink entries refused) and a runner with a total time budget (D-009, D-010).
