# Decision Log

Record material decisions. Do not use this file as a daily diary.

## D-001 — Next.js App Router
- Status: Accepted
- Context: The project needs a review UI and server endpoints.
- Decision: Use Next.js App Router with Route Handlers and server-side modules.
- Alternatives: Separate Express API and Vite frontend.
- Consequences: One app for UI/API; long-running jobs may need a separate worker.

## D-002 — PostgreSQL access
- Status: Accepted
- Decision: Use `pg` with SQL migrations; do not use Prisma.
- Consequences: More explicit SQL and migration ownership.

## D-003 — LLM provider
- Status: Accepted
- Decision: Use Ollama behind a replaceable provider interface.
- Consequences: Local development first; deployment must account for private model connectivity.

## D-004 — Human approval
- Status: Accepted
- Decision: No GitHub write operations without explicit approval; never auto-merge.
- Consequences: Approval must be authenticated, persisted and tied to the exact source revision.

## D-005 — No premature vector database
- Status: Accepted
- Decision: Start with diffs, deterministic references and repository conventions; add embeddings only if evaluation shows a measurable benefit.
- Consequences: Simpler initial system and measurable baseline.

## D-006 — Node.js 24 LTS and toolchain baseline
- Status: Accepted (user-approved 2026-10-10)
- Date: 2026-10-10
- Context: CI pinned Node 22 while the development machine runs Node 24.11.0.
- Decision: Pin Node 24 through `.nvmrc`, `engines` (`>=24 <25`) and CI (`node-version-file: .nvmrc`). Use the versions `create-next-app` chose: Next 16.4.0, React 19.3.0, TypeScript 5.9 (not 7.x), ESLint 9 and Tailwind 4 through `@tailwindcss/turbopack`. Use Vitest 5 for tests. It installs Vite as a transitive test-runner dependency only; Vite is not the app bundler, so the "no Vite" rule is not broken. Prettier formats code only, and Markdown docs are excluded.
- Alternatives: Node 22 (would mean switching Node locally); TypeScript 7 (newest, but not what the Next scaffold or `typescript-eslint` ecosystem targets).
- Consequences: Contributors need Node 24. `.gitattributes` forces LF line endings so Prettier checks pass on Windows checkouts with `core.autocrlf=true`.

## D-007 — SQL migration convention without a framework
- Status: Accepted (user-approved 2026-10-10)
- Date: 2026-10-10
- Context: The Phase 00 spec says to ask before adding a migration framework.
- Decision: Use plain numbered SQL files in `migrations/`, applied by a small `pg`-based runner that records them in a `schema_migrations` table. The runner is built along with the first migration (Phase 01). Details are in `docs/03-data-model.md`.
- Alternatives: Building the runner now with no tables (speculative code); `node-pg-migrate` (an extra dependency and its own DSL).
- Consequences: The runner will need its own tests when it is written. Rollbacks are done with forward-only fix migrations.

## D-008 — Read-only GitHub integration via Octokit and a GitHub App
- Status: Accepted (user-approved 2026-10-10)
- Date: 2026-10-10
- Context: Phase 01 needs authenticated, least-privilege read access to PR metadata and diffs, plus webhook verification.
- Decision: Add `@octokit/rest` and `@octokit/auth-app` as runtime dependencies, and `tsx` as a dev dependency for the TypeScript CLI scripts (`db:migrate`, `ingest`). Scripts run with `--conditions=react-server` so `server-only` modules resolve outside Next. Webhook signatures are verified with `node:crypto`, not a library. The `GitHubReader` interface has read methods only. Installation tokens are requested with `{ pull_requests: "read" }`, and a request hook blocks any non-GET call and adds a per-request timeout. There are no retry or throttling plugins.
- Alternatives: `octokit` (the all-in-one package, larger surface); `@octokit/webhooks` (unnecessary for one HMAC check); plain `fetch` (would mean reimplementing App JWT and token exchange).
- Consequences: The token exchange is the only non-GET request, and it runs on a separate client. Real GitHub is not exercised until someone creates a GitHub App (see docs/10). The Phase 02 permission change (Contents: read) must update `READ_ONLY_PERMISSIONS` and docs/10 together.

## D-009 — Webhook only enqueues; ingestion runs separately
- Status: Accepted (user-approved 2026-10-10)
- Date: 2026-10-10
- Context: Webhook handlers must return quickly, and serverless hosts may cut off work that continues after the response. There is no worker yet, and no measured need for queue infrastructure.
- Decision: The webhook records a `queued` analysis (one per repository, PR and head commit) and returns. `ingestPullRequest` is a pure service, used today through `npm run ingest` (fixture or live). The ingestion snapshot is not persisted. How queued analyses get processed (an in-process runner, a worker, or similar) is decided when a later phase first consumes the snapshot.
- Alternatives: Running ingestion inline after the response with Next's `after()` (simple, but no retries and fragile on serverless hosts); adding a job queue now (infrastructure without a measured need).
- Consequences: In Phase 01, queued analyses stay `queued`. The demo path is the webhook check plus a separate `npm run ingest`. A future runner must move analyses through the states that the CHECK constraints allow.
