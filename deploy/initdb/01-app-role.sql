-- Reference deployment only (docs/10). Like db/init/01-app-role.sql (which dev
-- and CI keep using), but:
-- * the app role starts WITHOUT login. 02-app-password.sh grants LOGIN with a
--   real password, so a failed first start fails closed instead of leaving the
--   committed placeholder password usable (security-check L-3);
-- * no docusync_test database in production;
-- * migrations and operator commands run as docusync_owner, a login role that
--   owns the database but is not a superuser and cannot create roles or
--   databases. POSTGRES_USER (a superuser) is only the bootstrap account that
--   runs this init; its password is not in migrate.env.
-- Runs once, against POSTGRES_DB (docusync), when the data volume is created.

CREATE ROLE docusync_app NOLOGIN;
CREATE ROLE docusync_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DATABASE docusync OWNER TO docusync_owner;

REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE docusync FROM PUBLIC;
GRANT CONNECT ON DATABASE docusync TO docusync_app;
GRANT USAGE ON SCHEMA public TO docusync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE docusync_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docusync_app;
