-- Phase 05: approval-gated GitHub writes (docs/13, D-013).

-- The live path records the source PR's branch names. NULL for fixture rows and
-- for rows created only by the webhook; a write needs both.
ALTER TABLE pull_requests
  ADD COLUMN head_ref text CHECK (length(head_ref) BETWEEN 1 AND 255),
  ADD COLUMN base_ref text CHECK (length(base_ref) BETWEEN 1 AND 255);

-- One GitHub output per approved decision. The binding columns are a snapshot
-- taken when the output is first requested; only the progress columns change.
CREATE TABLE github_outputs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id      uuid NOT NULL UNIQUE REFERENCES review_decisions (id) ON DELETE RESTRICT,
  proposal_id      uuid NOT NULL REFERENCES patch_proposals (id) ON DELETE RESTRICT,
  repository_id    uuid NOT NULL REFERENCES repositories (id) ON DELETE RESTRICT,
  github_repo_id   bigint NOT NULL CHECK (github_repo_id > 0),
  installation_id  bigint NOT NULL CHECK (installation_id > 0),
  head_sha         text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  base_blob_sha    text NOT NULL CHECK (base_blob_sha ~ '^[0-9a-f]{40}$'),
  patch_sha256     text NOT NULL CHECK (patch_sha256 ~ '^[0-9a-f]{64}$'),
  branch           text NOT NULL CHECK (branch ~ '^docusync/pr-[0-9]+-[0-9a-f]{12}$'),
  -- The docs PR's base: the source PR's head ref (not pull_requests.base_ref).
  docs_pr_base_ref text NOT NULL CHECK (length(docs_pr_base_ref) BETWEEN 1 AND 255),
  created_by       uuid NOT NULL REFERENCES reviewers (id) ON DELETE RESTRICT,
  step             text NOT NULL DEFAULT 'pending'
                   CHECK (step IN ('pending', 'branch_created', 'committed', 'pr_opened')),
  error_code       text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  commit_sha       text CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  pr_number        integer CHECK (pr_number > 0),
  pr_url           text CHECK (pr_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$'),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  lease_token      uuid,
  lease_until      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_outputs_pr_iff_opened
    CHECK ((step = 'pr_opened') = (pr_number IS NOT NULL AND pr_url IS NOT NULL)),
  CONSTRAINT github_outputs_commit_after_branch
    CHECK (step IN ('pending', 'branch_created') OR commit_sha IS NOT NULL),
  CONSTRAINT github_outputs_no_error_when_opened
    CHECK (step <> 'pr_opened' OR error_code IS NULL)
);

-- Who pressed "Create documentation PR" each time.
CREATE TABLE github_output_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  output_id    uuid NOT NULL REFERENCES github_outputs (id) ON DELETE RESTRICT,
  reviewer_id  uuid NOT NULL REFERENCES reviewers (id) ON DELETE RESTRICT,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_output_attempts_output_id_idx ON github_output_attempts (output_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docusync_app') THEN
    -- A column-level revoke does nothing while table-level UPDATE remains, so
    -- revoke the table privilege and grant back only what the webhook upsert sets.
    -- The repository's GitHub identity and source can't be repointed by the app.
    REVOKE UPDATE ON repositories FROM docusync_app;
    GRANT UPDATE (owner, name, installation_id, updated_at) ON repositories TO docusync_app;

    -- Binding columns are fixed after insert; only progress columns change.
    REVOKE UPDATE, DELETE, TRUNCATE ON github_outputs FROM docusync_app;
    GRANT UPDATE (step, error_code, commit_sha, pr_number, pr_url, attempts,
                  lease_token, lease_until, updated_at) ON github_outputs TO docusync_app;
    -- The attempt log is append-only.
    REVOKE UPDATE, DELETE, TRUNCATE ON github_output_attempts FROM docusync_app;
  END IF;
END
$$;
