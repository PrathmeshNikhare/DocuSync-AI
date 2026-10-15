# DocuSync AI — Claude Code Harness

A phase-gated Markdown harness for building DocuSync AI with Claude Code.

## Project goal

Build a GitHub-integrated documentation maintenance assistant that:
1. Analyzes pull-request diffs.
2. Identifies potentially affected documentation.
3. Explains recommendations with evidence from code changes.
4. Generates proposed documentation patches.
5. Supports human accept/edit/reject review.
6. Creates a separate documentation PR only after explicit human approval.

## Local setup

Requires Node.js 24 (see `.nvmrc`) and Docker for PostgreSQL.

```bash
npm ci
cp .env.example .env.local      # placeholders only; never commit real values
                                # set GITHUB_WEBHOOK_SECRET (20+ chars) and
                                # GITHUB_ALLOWED_INSTALLATION_IDS to receive webhooks
docker compose up -d --wait postgres   # first start creates docusync_app and docusync_test
npm run db:migrate              # applies migrations/ as the schema owner
npm run format:check
npm run lint
npm run typecheck
npm test                        # unit tests; no database, GitHub or model required
npm run test:db                 # database tests against docusync_test (needs Postgres)
npm run build                   # no .env needed at build time
npm run dev                     # http://localhost:3000, health: /api/health
```

The container binds `127.0.0.1` only. If another PostgreSQL already listens on port 5432, `docker compose up` fails with "ports are not available". Put `POSTGRES_HOST_PORT=55432` (or any free port) in an ignored `.env` file, which docker compose reads, and use the same port in the URLs in `.env.local`.

The init script in `db/init/` runs only when the data volume is first created. If you created the volume before it existed, recreate it with `docker compose down -v` (this deletes all local data in it).

### Pull request ingestion without GitHub credentials (fixture mode)

```bash
npm run ingest -- --fixture env-var-change   # prints the normalized snapshot as JSON
```

The fixtures in `fixtures/github/` are synthetic. Live mode (`npm run ingest -- --live owner/repo#123 --installation <id>`) needs a GitHub App; see `docs/10-deployment-and-operations.md`.

### Impact analysis on labelled fixtures (Phase 02)

```bash
npm run analyze -- --fixture env-var-renamed   # candidate docs with evidence, as JSON
npm run eval:impact                            # regenerates docs/evaluation/impact-baseline.md
```

The engine is deterministic and does not run on live repositories yet. The baseline numbers describe the synthetic fixtures only.

### Model assessment and patch proposals (Phase 03)

```bash
npm run propose -- --fixture env-var-renamed   # deterministic result + model assessment + validated patch, as JSON
npm run eval:llm                               # model-assisted vs deterministic; writes docs/evaluation/llm-assisted.md
npm run test:ollama                            # opt-in tests against a real Ollama
```

These need a local Ollama and `OLLAMA_MODEL` (for example `llama3.2:3b`) in `.env.local`. Without `OLLAMA_MODEL`, `propose` prints a deterministic-only result. Proposals are printed, never applied or written anywhere; see `docs/06-llm-and-patches.md`.

### Reviewing proposals in the browser (Phase 04)

```bash
npm run db:migrate                                                      # applies 0003_review.sql
npm run reviewer:add -- --username alice --name "Alice Example" --password-file ./alice.pw   # writes a generated password to a new file
npm run analysis:run -- --fixture env-var-renamed                       # runs the pipeline on a fixture and saves it
npm run reviewer:grant -- --username alice --repo fixture/env-var-renamed
npm run dev                                                             # sign in at http://localhost:3000/login
```

`reviewer:add` and `reviewer:grant` (and `reviewer:revoke`, `reviewer:disable`, `reviewer:enable`, `reviewer:unlock`, `sessions:prune`) use the owner role (`MIGRATION_DATABASE_URL`): the app's own role can't create accounts or grant access. `analysis:run` uses the model when `OLLAMA_MODEL` is set; without it the analysis is deterministic-only and has no patches to review. Fixture analyses are labelled as fixture data everywhere in the UI. Accepting a patch records a decision; nothing is written to GitHub.

### Documentation pull requests (Phase 05, off by default)

GitHub writes need `GITHUB_WRITES_ENABLED=true`, `GITHUB_APP_SLUG`, and an App with Contents and Pull requests read and write (docs/10). Only live analyses can be published:

```bash
npm run db:migrate                                                       # applies 0005_github_writes.sql
npm run analysis:run -- --live owner/repo#123 --installation 987654      # same-repository PRs only
```

After a reviewer accepts or edits a proposal, **Create documentation PR…** opens one PR with that change against the source PR's head branch, after re-checking the approval and GitHub's current state (docs/13). It is never merged automatically. This path has been tested against a fetch-level fake of GitHub only, not a live App.

### Evaluation, deployment and demo (Phase 06)

```bash
npm run eval:impact        # deterministic precision/recall per dataset -> docs/evaluation/impact-baseline.md
npm run eval:latency       # engine latency and failure counts -> docs/evaluation/impact-latency.md
OLLAMA_MODEL=llama3.2:3b npm run eval:llm   # model-assisted comparison -> docs/evaluation/llm-assisted.md
npm run db:check-grants    # verify the app role's database limits (run after every restore)
npm run screenshots        # real UI screenshots with Playwright (see docs/11)
docker compose -f deploy/compose.yml up -d --build --wait   # reference private-network deployment (docs/10)
```

**Changing dependencies on Windows:** `npm install` on Windows drops Linux-only optional packages from `package-lock.json`, which makes `npm ci` fail in CI. After changing dependencies, regenerate the lockfile on Linux:

```bash
docker run --rm -v "$PWD":/app -w /app node:24 npm install --package-lock-only
```

### Sending a test webhook locally

With `GITHUB_ALLOWED_INSTALLATION_IDS=987654` (the fixture's installation), sign `fixtures/webhooks/pull_request.opened.json` with your `GITHUB_WEBHOOK_SECRET` (HMAC-SHA256 of the exact file bytes), and POST it to `/api/webhooks/github` with the headers `x-github-event: pull_request`, `x-github-delivery: <uuid>` and `x-hub-signature-256: sha256=<hex>`. The first delivery returns 202 `queued`; sending it again returns 200 `duplicate`.

## Measured results and known limitations

Measured on 2026-10-12. Every number comes from a command in this repository, on small synthetic fixtures. **These are not estimates of real-world performance.**

| Measure | Result | Source |
|---|---|---|
| Impact flagging, all 35 scenarios (deterministic) | precision 90.5% (19/21), recall 82.6% (19/23) | `docs/evaluation/impact-baseline.md` |
| Impact flagging, held-out `impact-v3` (14 scenarios, labelled before any run) | precision 87.5% (7/8), recall 70.0% (7/10) | same; label hash in `progress/PHASE-LOG.md` |
| Model-assisted flagging (`llama3.2:3b`) | identical to deterministic: the model demoted nothing | `docs/evaluation/llm-assisted.md` |
| Patches (`llama3.2:3b`) | 20 requested, 14 passed validation, 6 rejected; 41 model calls, median 2.9 s, p95 7.8 s | same |
| Engine latency | median 0.06 ms, p95 0.18 ms; 0 failures in 700 runs (one laptop) | `docs/evaluation/impact-latency.md` |
| Tests | GitHub Actions green on `ff5222e`. Later Phase 06 changes passed locally and in a Linux container mirror of the CI pipeline; GitHub Actions runs them once they are pushed | `.github/workflows/ci.yml` |

**Known limitations:**
- **No runner:** webhooks only enqueue (D-009). Live analyses come from the CLI.
- **GitHub writes ran live once** (2026-10-15, a private sandbox repository, no ruleset, one PR; docs/10). Everything else is tested against a fake GitHub only. Before enabling them for real, set up the rulesets in docs/10.
- **Deterministic blind spots** (from the `known_` scenarios and the `impact-v3` misses):
  - behaviour-only changes;
  - CLI option names;
  - Dockerfiles and other unparsed languages;
  - newly added endpoints that docs don't mention yet;
  - generic words that collide with exported names.
- **The model can only demote flagged docs.** Its prose can be wrong even when the patch validates (docs/11), so human review is required.
- **Single-instance assumptions:** the decision and create-PR rate limits are in-process. A per-IP limiter at the proxy is required before exposure.
- **Accepted risks:** the trust in the app database role (D-013) and the inline-script CSP (D-012).
- **Reference deployment limitations** (docs/10):
  - the app doesn't assert its database role (migrations and operator commands run as a non-superuser owner in the deployment, a superuser in dev and CI);
  - Ollama has no authentication of its own (it shares an internal network with the app only);
  - Postgres and Ollama containers are not read-only or capability-dropped;
  - the reviewer UI must stay on a private network: no per-IP limiter is shipped.
- **Not built:** MFA, signed decisions and decision expiry.
- **Deployment:** the reference deployment was verified locally only, not on a hosted environment.

## Harness workflow

1. Open Claude Code from the repository root.
2. Read `CLAUDE.md`, `AGENTS.md`, and `docs/INDEX.md`.
3. Run `/status`, then `/start-phase <phase>`.
4. Review the plan before allowing implementation.
5. At phase completion, run `/test`, `/verify-phase`, `/review`, `/security-check`, then `/handoff`.
6. Do not begin the next phase until the current phase has a verified handoff.

The harness is the project's operating system. Phase specifications and project docs are the source of truth; prompts should orchestrate them rather than duplicate them.

## Stack and constraints

- Next.js App Router, React, TypeScript strict mode, Tailwind CSS.
- Next.js Route Handlers for HTTP endpoints.
- PostgreSQL accessed with `pg` and explicit SQL migrations.
- Zod for runtime validation.
- Ollama behind a provider interface.
- GitHub App / Octokit integration.
- Vitest; React Testing Library where useful; GitHub Actions CI.
- No Django, Express, Vite, Prisma, or Zustand.
- Keep AI pipeline modules independent of UI and framework details.
- Do not run untrusted pull-request code.
- No GitHub write operations without explicit human approval.
- Do not invent test results, benchmark numbers, or completed features.

## Directory map

- `CLAUDE.md`: primary instructions for Claude Code.
- `AGENTS.md`: engineering rules and agent coordination.
- `.claude/agents/`: specialist agent definitions.
- `.claude/commands/`: reusable slash commands.
- `docs/`: requirements, architecture, contracts, security, testing, UI/UX, deployment and demo.
- `phases/`: phase scope, tasks and exit gates.
- `progress/`: durable status, decisions, phase log and handoffs.
- `templates/`: reusable handoff and phase report templates.

## Phase sequence

| Phase | Name | Outcome |
|---|---|---|
| 00 | Foundation | Next.js foundation, CI, contracts, docs |
| 01 | GitHub diff ingestion | Secure read-only PR/diff ingestion |
| 02 | Impact engine | Evidence-backed affected-document detection |
| 03 | LLM patches | Ollama-assisted patch proposals and validation |
| 04 | Review UI | Review, edit, accept and reject proposals |
| 05 | GitHub workflow | Approval-gated documentation PR creation |
| 06 | Evaluation and hardening | Benchmark, security, deployment and demo |

## Definition of done

A phase is complete only when its exit criteria pass, tests were actually run, relevant docs are updated, known limitations are recorded, and a handoff is written. A generated plan or untested code is not completion.
