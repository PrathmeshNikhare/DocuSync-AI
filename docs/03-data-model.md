# Data Model

Use PostgreSQL with `pg` and checked-in SQL migrations. Do not use Prisma.

## Migration convention (decision D-007)

- Migrations are plain SQL files in `migrations/`, named `NNNN_short_description.sql` (for example `0001_create_repositories.sql`), and are applied in lexical order.
- A migration that has been applied anywhere is never edited. Write a new migration to change it.
- Each file runs in one transaction. The runner records applied files in a `schema_migrations` table (`name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ`) and skips files already recorded.
- The runner is a small script built on `pg`, not a migration framework. It is written together with the first migration (expected in Phase 01). Phase 00 has no migrations, no runner and no tables.

## Suggested entities

### repositories
- `id` UUID primary key
- `github_repo_id` BIGINT unique
- `owner`, `name`
- `created_at`

### pull_requests
- `id` UUID primary key
- `repository_id` FK
- `github_pr_number` integer
- `head_sha`, `base_sha`
- `status`
- `created_at`, `updated_at`
- Unique `(repository_id, github_pr_number, head_sha)` where suitable for revision-specific analysis.

### analyses
- `id` UUID primary key
- `pull_request_id` FK
- `idempotency_key` unique
- `status` (`queued`, `running`, `completed`, `failed`, `cancelled`)
- `started_at`, `completed_at`
- `error_code` nullable; do not store secrets or raw credential-bearing errors.

### impact_candidates
- `id` UUID primary key
- `analysis_id` FK
- `doc_path`
- `impact_status` (`likely_affected`, `verify`, `unlikely_affected`)
- `reason`
- `evidence` JSONB validated by application schema
- `rank_score` nullable; do not label uncalibrated values as probabilities.

### patch_proposals
- `id` UUID primary key
- `candidate_id` FK
- `base_blob_sha` or equivalent source revision
- `patch_text`
- `validation_status`
- `model_id` and prompt version where safe/useful
- `created_at`

### review_decisions
- `id` UUID primary key
- `proposal_id` FK
- `reviewer_id`
- `decision` (`accepted`, `edited`, `rejected`)
- `edited_patch` nullable
- `repository_id`, `head_sha`, `base_blob_sha`: the exact repo and revision the reviewer saw
- `patch_sha256`: SHA-256 of the approved patch text (`edited_patch` when edited)
- `decided_at`
- `created_at`
- Every column except `decision` and `edited_patch` is set by the server, never taken from the request body. Before any GitHub write, the stored binding must match the current head SHA, blob SHA and patch hash; otherwise the approval is stale (docs/07 controls 9 and 10).

### github_outputs
- `id` UUID primary key
- `analysis_id` FK
- `github_pr_url`
- `head_branch`
- `status`
- Unique idempotency reference to prevent duplicate output PRs.

## Invariants

- Never store access tokens or webhook secrets in application tables.
- Enforce valid state transitions in service code and, where practical, constraints.
- All queries use parameterized SQL.
- Validate JSONB on read and write.
- A write operation must bind approval to the exact proposal and source revision.
- Retention and deletion policy must be documented before production deployment.
