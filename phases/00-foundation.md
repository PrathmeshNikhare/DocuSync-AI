# Phase 00 — Foundation

## Goal

Create a coherent, reproducible Next.js repository foundation. Do not build product functionality beyond testable shared contracts and minimal scaffolding.

## Tasks

- Inspect repository, branch, git status, Node/npm versions and existing user changes.
- Present plan before file changes.
- Initialize Next.js App Router with TypeScript strict mode and Tailwind CSS if not already initialized.
- Configure linting, formatting, Vitest and scripts.
- Create the planned source directories without creating empty layers that serve no purpose.
- Add Zod and initial schemas for analysis state, impact candidate, evidence reference, patch proposal and review decision.
- Add PostgreSQL connection module using `pg`, environment validation and migration conventions; do not require a live DB for unit tests.
- Add `.env.example`, `.gitignore`, CI workflow and project docs.
- Add smoke tests for schemas and basic application behavior.
- Confirm no Express, Vite, Prisma, Zustand or Django dependencies.
- Do not add GitHub write operations or live model calls.

## Exit criteria

- Dependencies install reproducibly.
- Lint, type-check, tests and production build pass, or blockers are explicitly recorded.
- Runtime schemas have meaningful positive and negative tests.
- Secrets are excluded from Git.
- README setup commands are verified.
- Architecture and security docs match implementation.
- Status, phase log and handoff are updated.

## Stop conditions

Stop and ask before adding a database migration framework, queue, auth provider, external hosted service, or dependency with significant architectural implications.
