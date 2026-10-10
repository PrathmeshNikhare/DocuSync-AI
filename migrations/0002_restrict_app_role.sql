-- Narrow what the runtime role can do beyond row access (security review L1).
-- The role name `docusync_app` matches db/init/01-app-role.sql; where it does not
-- exist (e.g. a deployment with a differently named role), only the PUBLIC
-- revokes apply and the deployment must restrict its own role equivalently.

-- No one but the owner creates objects in public (already the PG15+ default;
-- stated explicitly so it does not depend on the server version).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  -- No temporary tables for PUBLIC in this database.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docusync_app') THEN
    -- The migration ledger is owner-only: the app must not be able to hide or
    -- fake applied migrations.
    REVOKE ALL ON schema_migrations FROM docusync_app;
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM docusync_app', current_database());
  END IF;
END
$$;
