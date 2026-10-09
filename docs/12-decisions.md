# Architecture Decision Record Index

Record meaningful decisions in `progress/DECISIONS.md` using the format: context, decision, alternatives, consequences, date, and status.

Initial decisions:
- Use Next.js App Router for UI and HTTP endpoints.
- Use TypeScript strict mode.
- Use PostgreSQL via `pg` and SQL migrations; no Prisma.
- Use Zod for runtime validation.
- Keep Ollama behind a provider interface.
- Separate deterministic impact detection from LLM reasoning.
- Require human approval before GitHub writes.
- Defer vector databases and complex job infrastructure until evidence justifies them.
