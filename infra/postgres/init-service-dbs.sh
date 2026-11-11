#!/bin/sh
# Runs ONCE when the postgres container starts with an EMPTY data volume (docker-entrypoint-initdb.d).
# One database + one database user per service; each user can connect ONLY to its own database.
# Passwords come from the environment (docker-compose.yml passes <SVC>_DB_PASSWORD to this container
# too); the defaults are for local use only. Use URL-safe passwords (letters, digits, - _ .): they
# also go into the services' postgresql:// connection URLs.
set -eu

for svc in identity catalog order inventory payment notification; do
  var="$(echo "$svc" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
  eval "pw=\"\${$var:-${svc}-dev-password}\""
  # The password is passed as a psql VARIABLE and quoted by psql itself (:'pw'), never pasted into
  # the SQL text - a quote or space in it can't break (or inject into) the statement.
  psql -v ON_ERROR_STOP=1 -v pw="$pw" --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE ${svc}_svc WITH LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE scalecart_${svc} OWNER ${svc}_svc;
REVOKE CONNECT ON DATABASE scalecart_${svc} FROM PUBLIC;
GRANT CONNECT ON DATABASE scalecart_${svc} TO ${svc}_svc;
SQL
  echo "created scalecart_${svc} (owner ${svc}_svc)"
done
