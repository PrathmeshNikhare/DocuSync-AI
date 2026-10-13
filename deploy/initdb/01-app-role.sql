-- Reference deployment only (docs/10). Like db/init/01-app-role.sql (which dev
-- and CI keep using), but:
-- * the app role starts WITHOUT login. 02-app-password.sh grants LOGIN with a
--   real password, so a failed first start fails closed instead of leaving the
--   committed placeholder password usable (security-check L-3);
-- * no docusync_test database in production.
-- Runs once, against POSTGRES_DB (docusync), when the data volume is created.

CREATE ROLE docusync_app NOLOGIN;

REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE docusync FROM PUBLIC;
GRANT CONNECT ON DATABASE docusync TO docusync_app;
GRANT USAGE ON SCHEMA public TO docusync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE docusync IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docusync_app;
