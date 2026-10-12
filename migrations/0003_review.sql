-- Phase 04: persisted analysis results, reviewers, sessions and review decisions.
-- Constraints mirror the Zod contracts in src/lib/schemas.ts. JSONB columns are
-- validated by the application on write and on read.

-- Fixture-sourced data is labelled, never disguised as GitHub data (D-012).
ALTER TABLE repositories
  ADD COLUMN source text NOT NULL DEFAULT 'github'
    CHECK (source IN ('github', 'fixture')),
  ALTER COLUMN github_repo_id DROP NOT NULL,
  ALTER COLUMN installation_id DROP NOT NULL,
  ADD CONSTRAINT repositories_github_ids_iff_github
    CHECK ((source = 'github') = (github_repo_id IS NOT NULL AND installation_id IS NOT NULL));
CREATE UNIQUE INDEX repositories_fixture_name_key
  ON repositories (owner, name) WHERE source = 'fixture';

-- An analysis created by a fixture run has no webhook delivery.
ALTER TABLE analyses
  ALTER COLUMN delivery_id DROP NOT NULL,
  ADD COLUMN pr_title text CHECK (length(pr_title) <= 1000),
  ADD COLUMN changed_files jsonb,
  ADD COLUMN engine_version text CHECK (length(engine_version) BETWEEN 1 AND 64),
  ADD COLUMN model_status text
    CHECK (model_status IN ('ok', 'partial', 'unavailable', 'not_configured')),
  ADD COLUMN missing_context jsonb;

CREATE TABLE impact_candidates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id      uuid NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
  doc_path         text NOT NULL CHECK (length(doc_path) BETWEEN 1 AND 512),
  impact_status    text NOT NULL
                   CHECK (impact_status IN ('likely_affected', 'verify', 'unlikely_affected')),
  reason           text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  evidence         jsonb NOT NULL,
  missing_context  jsonb NOT NULL,
  -- Sum of fixed rule points: an ordering aid, not a probability.
  rank_points      integer NOT NULL CHECK (rank_points BETWEEN 0 AND 10000),
  rules            jsonb NOT NULL,
  engine_version   text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 64),
  -- Model output is stored apart from the deterministic fields above (D-011).
  model_assessment jsonb,
  assist_outcome   jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, doc_path)
);

CREATE TABLE patch_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id       uuid NOT NULL UNIQUE REFERENCES impact_candidates (id) ON DELETE CASCADE,
  target_path        text NOT NULL CHECK (length(target_path) BETWEEN 1 AND 512),
  head_sha           text NOT NULL CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  base_blob_sha      text NOT NULL CHECK (base_blob_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- The doc the patch applies to: shown side by side and used to re-validate edits.
  base_content       text NOT NULL CHECK (length(base_content) <= 200000),
  patch_text         text NOT NULL CHECK (length(patch_text) BETWEEN 1 AND 100000),
  rationale          text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  evidence           jsonb NOT NULL,
  validation_status  text NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  validation_issues  jsonb NOT NULL,
  -- relatedLines, relatedTerms and knownLinks for validating a reviewer's edit.
  validation_context jsonb NOT NULL,
  model              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reviewers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{1,38}$'),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$'),
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Only a SHA-256 of the session token is stored, so a database leak can't be replayed.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  reviewer_id uuid NOT NULL REFERENCES reviewers (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_reviewer_id_idx ON sessions (reviewer_id);

-- Failed logins per username, for rate limiting. The username is not trusted to exist.
CREATE TABLE login_failures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username     text NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_username_time_idx ON login_failures (username, attempted_at);

-- Which reviewer may see and decide on which repository's analyses.
CREATE TABLE repository_reviewers (
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  reviewer_id   uuid NOT NULL REFERENCES reviewers (id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, reviewer_id)
);
CREATE INDEX repository_reviewers_reviewer_id_idx ON repository_reviewers (reviewer_id);

-- One final decision per proposal (D-012), bound to what the reviewer saw.
CREATE TABLE review_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   uuid NOT NULL UNIQUE REFERENCES patch_proposals (id) ON DELETE RESTRICT,
  reviewer_id   uuid NOT NULL REFERENCES reviewers (id) ON DELETE RESTRICT,
  decision      text NOT NULL CHECK (decision IN ('accepted', 'edited', 'rejected')),
  edited_patch  text CHECK (length(edited_patch) BETWEEN 1 AND 100000),
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE RESTRICT,
  head_sha      text NOT NULL CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  base_blob_sha text NOT NULL CHECK (base_blob_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  patch_sha256  text NOT NULL CHECK (patch_sha256 ~ '^[0-9a-f]{64}$'),
  decided_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_decisions_edited_patch_iff_edited
    CHECK ((decision = 'edited') = (edited_patch IS NOT NULL))
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docusync_app') THEN
    -- The audit trail is append-only for the app.
    REVOKE UPDATE, DELETE, TRUNCATE ON review_decisions FROM docusync_app;
    -- Accounts and grants are managed by an operator (owner role), never by the app,
    -- so a compromised app can't create a reviewer or grant itself access.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON reviewers, repository_reviewers FROM docusync_app;
    REVOKE TRUNCATE ON sessions, login_failures FROM docusync_app;
  END IF;
END
$$;
