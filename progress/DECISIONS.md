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
