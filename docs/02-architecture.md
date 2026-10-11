# Architecture

## Intended shape

- Next.js App Router: UI, authenticated dashboard routes and thin Route Handlers.
- Core modules under `src/lib/`: framework-independent business logic.
- GitHub adapter: verifies webhooks, fetches PR metadata/diffs, and later creates branches/PRs.
- Diff analyzer: parses diff metadata and extracts deterministic signals; never executes repository code.
- Impact engine: ranks documentation candidates and attaches evidence.
- LLM provider: interface with Ollama implementation and strict input/output schemas.
- Patch validator: validates allowed paths, patch boundaries and resulting Markdown.
- PostgreSQL: review sessions, candidates, proposals, decisions and idempotency records.
- Worker interface: long-running analysis can be moved out of request lifecycle; don't assume serverless handlers can run indefinitely.

## Data flow

1. Verify webhook signature using raw request body.
2. Record an idempotency key and enqueue/dispatch analysis.
3. Fetch bounded metadata and diffs with least-privilege credentials.
4. Parse changed files and deterministic evidence.
5. Select candidates; preserve reasons and evidence references.
6. Optionally ask the configured model for analysis and patch proposals.
7. Validate all model output against schemas and patch policy.
8. Persist proposals for human review.
9. On explicit approval, re-check authorization and source revision before GitHub writes.
10. Create a new documentation branch and pull request; never merge automatically.

## Module boundaries

Keep these concepts independently testable:
- `github/`: external API adapter.
- `diff-analyzer/`: parsing and deterministic signals.
- `impact-engine/`: candidate selection and ranking.
- `llm/`: provider interface, prompts and output validation.
- `patch-validator/`: safe patch rules.
- `review/`: decisions and state transitions.
- `db/`: migrations and repositories.
- `security/`: webhook validation, authz, redaction and path policy.

## Design principles

- Route Handlers are thin: parse, authenticate, validate, call services, map errors.
- Do not let UI components call GitHub or Ollama directly.
- Do not couple the impact engine to Next.js request/response types.
- Avoid adding infrastructure without a measured requirement.

## Implemented so far (Phase 00)

- Next.js 16.4 App Router under `src/app/`. `cacheComponents` is enabled, so `GET` handlers that read no request or runtime data are prerendered at build time.
- `src/app/api/health/route.ts`: static liveness endpoint. It does not check the database or the model.
- `src/lib/schemas.ts`: framework-independent Zod contracts for evidence references, impact candidates, analysis state and its transitions, patch proposals, review decisions (a client input schema and a separate server-built record schema) and the API error envelope.
- `src/lib/env.ts`: lazy, server-only environment validation, in groups (database, webhook secret, GitHub App, migrations), each validated only where it's used.
- `src/lib/db/pool.ts`: lazy, server-only `pg` pool with connection, idle and statement timeouts.

## Implemented so far (Phase 01)

- `POST /api/webhooks/github` (`src/app/api/webhooks/github/route.ts`) is a thin wrapper around `src/lib/github/webhook-handler.ts`. The handler reads at most 1 MiB, verifies the HMAC signature over the raw bytes, then validates headers and payload. Supported `pull_request` actions are `opened`, `synchronize`, `reopened` and `ready_for_review`; drafts are ignored. The handler only queues work: it never fetches from GitHub or runs a model inline.
- `src/lib/db/analyses.ts`: `enqueueAnalysis` upserts the repository and PR and inserts a `queued` analysis keyed on `github:pr:<repoId>:<number>:<headSha>`, all in one transaction. Redeliveries and concurrent duplicates return the existing analysis (D-009).
- **Nothing consumes queued analyses yet (D-009).** Ingestion is a separate service, `ingestPullRequest(reader, ref, { expectedHeadSha? })` in `src/lib/ingest.ts`, run by `npm run ingest`. It fails with `GITHUB_STALE_HEAD` if the PR head or base moves during ingestion, or if the head isn't the expected commit. A future runner must pass the analysis's `head_sha` as `expectedHeadSha`. A runner that connects the queue to ingestion is decided in a later phase.
- `src/lib/github/reader.ts` defines the `GitHubReader` interface: `getPullRequest` and `listFiles` only, no writes. There are two implementations. `octokit-reader.ts` is the live GitHub App reader: its installation token is requested with `pull_requests: read` only, a request hook refuses any non-GET call and adds a 10 s timeout, file listing stops at 300 files, and errors are mapped to safe codes. `fixture-reader.ts` serves `fixtures/github/*.json`.
- `src/lib/diff-analyzer/normalize.ts` validates every file path and parses hunks. Unsafe files are rejected by index. Oversized, binary or malformed patches keep the file but drop the hunks (`patchState`). That includes patch text Postgres can't store and hunk numbers outside the safe-integer range, both marked `malformed`. The result is a `PullRequestSnapshot` (Zod) and is not persisted.
- `src/lib/db/migrate.ts` and `scripts/migrate.ts` form the migration runner (D-007). `migrations/0001_ingestion.sql` creates `repositories`, `pull_requests` and `analyses`.
- `src/lib/log.ts`: structured JSON logs with a closed set of fields.
- Not created yet: `review/` and `security/`. (Phase 03 added `llm/`, `patches/` and `assist/`; see below.)

## Implemented so far (Phase 02)

- `src/lib/impact-engine/`: the deterministic impact engine (`analyzeImpact`), its rule config, and the evaluation harness. It is pure TypeScript with no framework, database, GitHub or model imports (tested). Details in docs/05.
- `npm run analyze -- --fixture <scenario>` runs the engine on a labelled fixture, and `npm run eval:impact` writes `docs/evaluation/impact-baseline.md`.
- Still not connected end to end (D-009, D-010): nothing fetches documentation from GitHub, results are not persisted, and queued analyses are not processed.

## Implemented so far (Phase 03)

- `src/lib/llm/`: the `LlmProvider` transport interface, `generateStructured` (JSON data in, Zod-validated JSON out, one retry for invalid output), the Ollama transport, and the versioned prompts and output schemas.
- `src/lib/patches/`: the allowed-documentation-path policy, git blob SHA, edit placement and unified-diff rendering, a strict diff applier, and `validatePatch`. Pure string code: no file system, network, GitHub, database or model imports (tested).
- `src/lib/assist/`: `assistImpact` runs the deterministic engine, then asks the model to assess flagged candidates and propose edits, and returns only validated proposals. Also the bounded context builder and evaluation helpers.
- The model gets no tools and no credentials and never chooses a file (D-011). Details in docs/06.
- `npm run propose` and `npm run eval:llm` work on fixtures only. Proposals are not persisted and are never applied.
