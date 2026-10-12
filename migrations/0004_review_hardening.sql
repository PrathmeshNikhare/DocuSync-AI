-- Phase 04 security-check fixes. 0003 is already applied, so this is a new migration.

-- Pruning old login failures filters on attempted_at alone; without this index
-- every sign-in attempt scanned the whole table (security M-A).
CREATE INDEX login_failures_attempted_at_idx ON login_failures (attempted_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docusync_app') THEN
    -- A proposal is what a reviewer approves: once stored it must not change, so
    -- the recorded patch hash always matches what was shown (security L-A).
    REVOKE UPDATE, DELETE ON patch_proposals, impact_candidates FROM docusync_app;
    -- The app only ever revokes a session; it can't extend, un-revoke or delete
    -- one (security L-C).
    REVOKE UPDATE, DELETE ON sessions FROM docusync_app;
    GRANT UPDATE (revoked_at) ON sessions TO docusync_app;
  END IF;
END
$$;
