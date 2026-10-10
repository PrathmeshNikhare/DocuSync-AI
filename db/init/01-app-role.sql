-- Local/CI only. Runs once, when the Postgres data volume is first created
-- (docker-entrypoint-initdb.d), or explicitly with psql in CI.
-- The owner role (POSTGRES_USER = docusync) runs migrations. The app role can only
-- read and write rows: it cannot create, alter or drop tables.
-- Passwords are well-known local placeholders; never reuse them elsewhere.

CREATE ROLE docusync_app LOGIN PASSWORD 'change-me-app-local-only';

CREATE DATABASE docusync_test OWNER docusync;

-- PUBLIC can connect to every database by default. Only named roles may connect
-- here; docusync_app gets exactly the two application databases.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE docusync FROM PUBLIC;
REVOKE CONNECT ON DATABASE docusync_test FROM PUBLIC;
-- Schema-level and TEMP revokes, and the schema_migrations revoke, live in
-- migrations/0002_restrict_app_role.sql so they also reach existing databases.

\connect docusync
GRANT CONNECT ON DATABASE docusync TO docusync_app;
GRANT USAGE ON SCHEMA public TO docusync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE docusync IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docusync_app;

\connect docusync_test
GRANT CONNECT ON DATABASE docusync_test TO docusync_app;
GRANT USAGE ON SCHEMA public TO docusync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE docusync IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docusync_app;
