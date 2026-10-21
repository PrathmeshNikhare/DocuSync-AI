# Engineering Decisions

The material architecture and scope decisions for DocuSync AI (D-001 to D-016), recorded as they were made. Source comments and the other documents cite these IDs. The IDs are stable; new decisions take the next number. Each entry gives context, decision, alternatives and consequences. "Phase" in an entry refers to the project's original build order (foundation, ingestion, impact engine, model patches, review UI, GitHub workflow, evaluation and hardening).
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

## D-010 — Rule-based deterministic impact engine; live analysis deferred
- Status: Accepted (user-approved 2026-10-10)
- Date: 2026-10-10
- Context: Phase 02 needs explainable candidate selection with a measurable baseline before any model is involved (D-005, docs/05).
- Decision: The impact engine is a pure function from a `PullRequestSnapshot` plus doc files to candidates. It uses regex signal extraction, whole-word and link matching, and fixed integer rule points with thresholds (config in `src/lib/impact-engine/config.ts`). The candidate schema gains `rankPoints` (documented as not a probability) and `rules`, and evidence gains an optional `side` (`base`/`head`). Phase 02 is limited to the engine, labelled fixtures, the evaluation harness and a fixture CLI. Fetching docs from GitHub (Contents: read), persisting results and processing queued analyses stay deferred.
- Alternatives: An AST parser (more precise, but a new dependency and per-language work); embeddings for doc retrieval (ruled out by D-005 until evaluation shows a need); including live doc fetching or a runner now (larger scope, and it revisits D-009).
- Consequences: The baseline is cheap and reproducible but blind to behaviour-only changes and noisy on generic names. Rule changes must be followed by `npm run eval:impact`, and the committed report is checked by a test. The live path (Contents permission, doc fetching at the head SHA, a runner) must be planned explicitly in a later phase.

## D-011 — Model proposes edits; the server renders, validates and owns the patch
- Status: Accepted (user-approved 2026-10-11)
- Date: 2026-10-11
- Context: Phase 03 adds an Ollama model that assesses deterministic candidates and proposes documentation patches. Model output is untrusted, and small local models produce malformed unified diffs.
- Decision: The model never chooses a file and never writes a diff. It returns structured JSON (Zod-validated, with one retry for invalid output): a verdict for assessments, and `{find, replace}` edits for patches. The target doc comes from the deterministic candidate. The server drops edits that can't be placed exactly once (`placeableEdits`), renders a unified diff, and validates it with `validatePatch`: allowed doc paths (root `*.md`/`*.markdown` and `docs/**`, excluding AI-agent instruction files; narrowed on 2026-10-11 after the security check, with the user's approval, from an earlier allowlist that also had `.mdx` and `.txt`), base blob SHA, strict application, size and breadth limits, relatedness to evidence, and unsafe-content checks. The same validator is meant for reviewer-edited patches in Phase 04. No patch is requested without concrete change facts. The model's assessment is stored apart from the deterministic candidate and never changes it. In model-assisted evaluation, the model sees only flagged candidates and can only demote them. `patchProposalSchema.candidateId` is optional until proposals are persisted, and the schema gains `headSha` and `validationIssues`.
- Alternatives: The model writes the unified diff (more malformed output on small models); the model screens unflagged docs too (could recover behaviour-only misses, but costs more calls and context); a third-party diff library (a dependency for about 150 lines of strict code).
- Consequences: Proposals are narrow and reproducible from the doc and the edits. A model can't widen a patch's reach, but it can still write wrong prose that passes validation, so human review stays mandatory. Model-assisted mode can't raise recall. Persistence and the runner remain deferred (D-010).

## D-012 — Review UI: local reviewer accounts, fixture-sourced data, one final decision, CSP without nonce
- Status: Accepted (user-approved 2026-10-11)
- Date: 2026-10-11
- Context: Phase 04 needs authenticated reviewers, persisted analyses to review, a decision model and security headers. No GitHub App or OAuth app is available here, no runner exists (D-009, D-010), and the project runs with Cache Components (Phase 00).
- Decision:
  - **Authentication:** local reviewer accounts (scrypt passwords, created by an operator with the owner role), database sessions (random token stored as SHA-256, `HttpOnly`, `SameSite=Strict`, 12 hours) and per-repository grants. No auth library.
  - **Data:** analyses come from `npm run analysis:run -- --fixture <name>`, which runs the real pipeline and saves it under a repository marked `source = 'fixture'`. Fixture rows have no GitHub ids, and the UI labels them.
  - **Decisions:** one final decision per proposal (accepted, edited or rejected), enforced in code under a row lock and by a unique constraint. Accepting is not a GitHub write.
  - **CSP:** set statically in `next.config.ts` with `script-src 'self' 'unsafe-inline'` instead of the planned nonce, because nonce CSP is incompatible with Cache Components' static shell (user choice). So there is no `proxy.ts`. Authorization lives in the data layer.
  - **Tests:** UI tests use React Testing Library with jsdom.
- Alternatives:
  - **Authentication:** GitHub OAuth (real identity, but not verifiable here); an auth library (a dependency on top of accounts or OAuth anyway).
  - **Data:** building the live runner now (much larger scope; revisits D-009 and D-010).
  - **Decisions:** re-decide until written (more states).
  - **CSP:** turning Cache Components off for a nonce CSP; experimental SRI.
  - **Tests:** Playwright.
- Consequences: The review flow is real and testable end to end with fixture data. Reviewers are not GitHub identities, so Phase 05 must authorize GitHub writes separately and compare the recorded binding (head SHA, blob SHA, patch hash) against GitHub before writing. The script CSP relies on never rendering untrusted HTML. Login rate limiting is per username only.

## D-013 — Approval-gated GitHub writes: stacked docs PR, echoed approval, bounded trust in the app role
- Status: Accepted (user-approved 2026-10-12; security design review approved 2026-10-12 after its required changes were applied in docs/13)
- Date: 2026-10-12
- Context: Phase 05 adds the first GitHub writes. Reviewers are local accounts (D-012), so GitHub can't attribute approvals to them. Until now, analyses came only from fixtures (D-012) and no runner exists (D-009, D-010).
- Decision:
  - **Live analyses:** a CLI path `analysis:run -- --live`, which fetches docs through git trees and blobs at the head SHA, so blob ids are GitHub's own.
  - **Writes off by default:** they need `GITHUB_WRITES_ENABLED=true`, enforced in the route and again inside the writer.
  - **Approval:** an explicit create-PR action echoes the decision's `headSha` and `patchSha256`. Any granted reviewer may press it. Every attempt is recorded, and the deciding reviewer must still be enabled and granted.
  - **Write-time re-checks:** every check is re-run at write time. The written file is the approved patch applied to the blob fetched from GitHub, which must match both `base_blob_sha` and the stored base text.
  - **Output:** one branch `docusync/pr-<n>-<id>`, one commit, and one PR whose base is the source PR's head branch, with `maintainer_can_modify: false`; never merged. Idempotent through `github_outputs` (one row per decision, a lease owned by a token, resumable steps).
  - **GitHub access:** one App for reading and writing. Writer tokens are minted per operation, scoped to one repository id, checked and then revoked. A two-layer allowlist guard runs on exact routes and parameters, with no redirects.
  - **Trust in the app database role:** accepted within bounds. A compromise allows bounded docs PRs only. Repository identity can't be updated by the app role, the binding snapshots `github_repo_id` and `installation_id`, and each decision is checked against its proposal chain.
  - **PR bodies:** reviewers appear by display name; untrusted text is rendered only in code spans or blocks.
- Alternatives: signed decisions or HMAC-keyed sessions (a secret outside the database; more work); a separate write App; a docs PR against the default branch; a background runner; writes on accept without a separate action.
- Consequences: no write without a fresh, explicit, server-recorded approval matching GitHub's current state. A stolen App private key is limited only by GitHub-side controls, so docs/10 recommends rulesets and optionally a separate write App. Writes are verified against mocks only until a live App is available.

## D-014 — Phase 06 scope: reference deployment, Playwright screenshots, live GitHub deferred
- Status: Accepted (user-approved 2026-10-12)
- Date: 2026-10-12
- Context: Phase 06 asks for deployment compatible with private Ollama, real screenshots and a truthful demo, rate limits and kill switches, and security evidence. There is no hosting target or GitHub App in this environment.
- Decision:
  - **Deployment:** a reference private-network setup only (app, Postgres and Ollama on one private network behind a TLS proxy), documented and verified locally with a production compose profile. Real hosting is NOT RUN.
  - **Screenshots:** `@playwright/test` is added as a devDependency, with a script that captures real screenshots of the local app. Fixture data and mocked GitHub states are labelled in them.
  - **Live GitHub:** a live write stays NOT RUN, and the demo marks GitHub steps as mocked.
  - **Phase 05 follow-ups fixed in this phase:** security-check L-1, L-2 and L-3, and `/review` L3, L6, L7, L8 and L9.
- Alternatives: deploying to user-provided infrastructure; screenshots with session-only browser tooling (not reproducible); setting up a live App now.
- Consequences: the demo and docs must label mocked steps. The GitHub write path remains verified against a fake only.

## D-015 — Non-superuser schema owner in the reference deployment
- Status: Accepted (user-approved 2026-10-16: role name `docusync_owner`, deployment only, include the check)
- Date: 2026-10-16
- Context: security-check L-4. Migrations, `db:check-grants`, the `reviewer:*` commands and restores ran as the Postgres bootstrap superuser, so a leaked `migrate.env` gave full server control. No migration needs superuser rights (no extensions, roles or system settings).
- Decision:
  - **Roles:** `docusync_owner` (LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS) owns the database `docusync` and runs migrations and operator commands. The bootstrap superuser is used only by the init scripts and the healthcheck.
  - **Init:** `deploy/initdb/01-app-role.sql` creates both roles without login; `02-app-password.sh` refuses placeholder, short or reused passwords and then grants login.
  - **Check:** `db:check-grants -- --require-non-superuser` also fails if the owner role is a superuser or can create roles or databases. The migrate job uses it.
  - **Scope:** the reference deployment only. Dev and CI keep a superuser owner.
- Alternatives: also moving dev and CI (more churn in shared test setup); leaving it documented.
- Consequences: an existing deployment volume must be recreated (init runs once). Dev and CI test less strictly than the deployment. The app still doesn't assert which URL it started with.

## D-016 — Beta scope: no hosted or paid deployment; larger model is future scope
- Status: Accepted (user-approved 2026-10-16)
- Date: 2026-10-16
- Context: Phase 06 is PASS and the post-gate hardening is done. The remaining items need paid services (a host, a GitHub plan for rulesets) or are open-ended (a larger model).
- Decision: release as a **beta** for local and private-network use. No hosted or paid deployment, no ruleset-protected live run, and no larger-model evaluation now; these are recorded as future scope in the README. The first live write stays documented as a single run without a ruleset.
- Alternatives: buying a plan or making a repository public to follow the ruleset requirement; evaluating a larger model now.
- Consequences: the README says beta. The docs keep listing what was never verified. Writes must stay off (`GITHUB_WRITES_ENABLED` not `true`) except in a throwaway repository.
