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

### Sending a test webhook locally

With `GITHUB_ALLOWED_INSTALLATION_IDS=987654` (the fixture's installation), sign `fixtures/webhooks/pull_request.opened.json` with your `GITHUB_WEBHOOK_SECRET` (HMAC-SHA256 of the exact file bytes), and POST it to `/api/webhooks/github` with the headers `x-github-event: pull_request`, `x-github-delivery: <uuid>` and `x-hub-signature-256: sha256=<hex>`. The first delivery returns 202 `queued`; sending it again returns 200 `duplicate`.

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
