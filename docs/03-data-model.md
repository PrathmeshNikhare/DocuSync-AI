# Data Model

Use PostgreSQL with `pg` and checked-in SQL migrations. Do not use Prisma.

## Migration convention (decision D-007)

- Migrations are plain SQL files in `migrations/`, named `NNNN_short_description.sql` (for example `0001_create_repositories.sql`), and are applied in lexical order.
- A migration that has been applied anywhere is never edited. Write a new migration to change it.
- Each file runs in one transaction. The runner records applied files in a `schema_migrations` table (`name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ`) and skips files already recorded.
- The runner is a small script built on `pg`, not a migration framework (`src/lib/db/migrate.ts`, `npm run db:migrate`). It takes a Postgres advisory lock so concurrent runs serialize, and it refuses `.sql` files that don't follow the naming pattern.
- Migrations run as the schema owner (`MIGRATION_DATABASE_URL`). The app connects as `docusync_app` (`DATABASE_URL`), which can only read and write rows. Locally and in CI, that role and the `docusync_test` database are created by `db/init/01-app-role.sql`. In production, create an equivalent role outside of migrations.

## Implemented tables (Phase 01, `0001_ingestion.sql`)

- `repositories`: `github_repo_id` (unique), `owner`, `name`, `installation_id`, timestamps.
- `pull_requests`: unique `(repository_id, github_pr_number, head_sha)`, plus `base_sha`. There is no `status` or `updated_at` column yet.
- `analyses`: unique `idempotency_key`, `delivery_id` (the first delivery that created the row), `status`, `started_at`, `completed_at`, `error_code`. CHECK constraints mirror `analysisStateSchema`: valid statuses, `error_code` set only when failed and in safe upper-snake form, timestamps consistent with the status and in chronological order.
- `0002_restrict_app_role.sql` (no tables): revokes the app role's access to `schema_migrations` and TEMP, and CREATE on `public` from PUBLIC (see docs/07, control 12).
- The other entities below are still planned, apart from those added in Phase 04.

## Implemented tables (Phase 04, `0003_review.sql`)

- `repositories` gains `source` (`github` or `fixture`). `github_repo_id` and `installation_id` are required exactly when `source = 'github'`, so fixture data never carries made-up GitHub ids. Fixture repositories are unique by `(owner, name)`.
- `analyses` gains `pr_title`, `changed_files`, `engine_version`, `model_status` and `missing_context`, and `delivery_id` becomes nullable (fixture runs have no webhook delivery).
- `impact_candidates`: one row per document candidate (unique per analysis and path), holding the deterministic status, reason, evidence, missing context, rule points (not a probability) and rules. The model's assessment and the per-candidate outcome are stored in separate JSONB columns (D-011).
- `patch_proposals`: one per candidate. It holds the target path, head SHA, base blob SHA, the base document text (for the side-by-side view and for re-validating edits), the patch, the model's rationale, the evidence, the validation status and issues, the validation context (related lines, related terms, known links; bounded by `VALIDATION_CONTEXT_LIMITS` where it is built, and checked with the same schema before it is saved and when it is read for an edit) and the model metadata.
- `reviewers`: username, display name and scrypt password hash (`scrypt$N$r$p$salt$hash`), plus `disabled_at`.
- `sessions`: the SHA-256 of a random 32-byte token, the reviewer, and `expires_at` (12 hours) and `revoked_at`.
- `login_failures`: failed sign-ins per username, for rate limiting. Rows older than a day are pruned on insert.
- `repository_reviewers`: which reviewer may see which repository.
- `review_decisions`: one row per proposal (`UNIQUE (proposal_id)`). It records the decision, `edited_patch` (present exactly when the decision is `edited`), and the binding: `repository_id`, `head_sha`, `base_blob_sha` and `patch_sha256` of the approved text, plus `decided_at`. Foreign keys use `ON DELETE RESTRICT`.
- **App-role grants (control 12):** the app role cannot UPDATE, DELETE or TRUNCATE `review_decisions` (an append-only audit trail), cannot write `reviewers` or `repository_reviewers` (operators manage accounts with the owner role), and cannot TRUNCATE `sessions` or `login_failures`. Migration `0004_review_hardening.sql` adds that it cannot UPDATE or DELETE `patch_proposals` or `impact_candidates` (stored proposals are immutable), and on `sessions` can only INSERT and update `revoked_at`. It also adds an index on `login_failures (attempted_at)` for pruning. All of this is tested (permission-denied checks for each statement).
- `0003_review.sql` was edited once before it was ever committed: `login_failures.id` changed from `bigserial` to `uuid`, because the app role has no sequence privileges. It had only been applied to the throwaway test database, whose schema was reset.

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
