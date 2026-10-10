-- Phase 01: pull request ingestion and idempotent analysis queueing.
-- Constraints mirror the Zod contracts in src/lib/schemas.ts so invalid state
-- cannot be stored even if application validation is bypassed.

CREATE TABLE repositories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_repo_id  bigint NOT NULL UNIQUE CHECK (github_repo_id > 0),
  owner           text NOT NULL CHECK (owner ~ '^[A-Za-z0-9_.-]{1,100}$'),
  name            text NOT NULL CHECK (name ~ '^[A-Za-z0-9_.-]{1,100}$'),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pull_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id    uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  github_pr_number integer NOT NULL CHECK (github_pr_number > 0),
  head_sha         text NOT NULL CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  base_sha         text NOT NULL CHECK (base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, github_pr_number, head_sha)
);

CREATE TABLE analyses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id  uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  -- The delivery that first created this analysis; later duplicates are not recorded.
  delivery_id      uuid NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at       timestamptz,
  completed_at     timestamptz,
  error_code       text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analyses_error_code_iff_failed
    CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT analyses_started_at_matches_status
    CHECK (CASE status
             WHEN 'queued' THEN started_at IS NULL
             WHEN 'running' THEN started_at IS NOT NULL
             WHEN 'completed' THEN started_at IS NOT NULL
             ELSE true
           END),
  CONSTRAINT analyses_completed_at_iff_terminal
    CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
  CONSTRAINT analyses_time_order
    CHECK (started_at IS NULL OR completed_at IS NULL OR started_at <= completed_at)
);

CREATE INDEX analyses_pull_request_id_idx ON analyses (pull_request_id);
