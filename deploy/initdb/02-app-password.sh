#!/bin/sh
# Runs once, after 01-app-role.sql, when the data volume is first created:
# refuses placeholder or short passwords, then gives the app role LOGIN with
# its real password. Until this succeeds the app role cannot log in at all.
# The Postgres entrypoint *sources* scripts that are not executable (a checkout
# can lose the bit), so the body runs in a subshell: `set -eu` and a failure stay
# here, and the entrypoint's own `set -e` still stops initdb if this fails.
(
  set -eu
  refuse() {
    echo "02-app-password: $1. Fix deploy/postgres.env, then recreate the volume: docker compose -f deploy/compose.yml down -v" >&2
    exit 1
  }
  for name in POSTGRES_PASSWORD APP_DB_PASSWORD; do
    eval "value=\${$name:-}"
    case "$value" in
      "" | REPLACE_*) refuse "$name is unset or still a placeholder (security-check L-5)" ;;
    esac
    [ "${#value}" -ge 16 ] || refuse "$name must be at least 16 characters"
  done
  # The password is read from the environment inside psql (\getenv), never
  # passed as an argument, and statements in this session are not logged on
  # error. :'pw' is psql's quoted, escaped substitution.
  printf '%s\n' \
    "SET log_min_error_statement = panic;" \
    '\getenv pw APP_DB_PASSWORD' \
    "ALTER ROLE docusync_app LOGIN PASSWORD :'pw';" |
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
)
