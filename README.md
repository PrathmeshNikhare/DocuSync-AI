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

Requires Node.js 24 (see `.nvmrc`) and, from Phase 01 onward, Docker for PostgreSQL.

```bash
npm ci
cp .env.example .env.local      # placeholders only; never commit real values
npm run format:check
npm run lint
npm run typecheck
npm test                        # unit tests; no database or model required
npm run build                   # no .env needed at build time
npm run dev                     # http://localhost:3000, health: /api/health
```

PostgreSQL (not used by any code path yet; no migrations exist in Phase 00):

```bash
docker compose up -d --wait postgres
docker compose stop
```

The container binds `127.0.0.1:5432` only. If another PostgreSQL already listens on port 5432, `docker compose up` fails with "ports are not available". Either stop the other server, or change the host port in `docker-compose.yml` and `DATABASE_URL` together (for example `127.0.0.1:55432:5432` with `localhost:55432`).

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
