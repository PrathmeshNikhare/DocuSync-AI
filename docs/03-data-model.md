# Data Model

Use PostgreSQL with `pg` and checked-in SQL migrations. Do not use Prisma.

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
- `created_at`

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
