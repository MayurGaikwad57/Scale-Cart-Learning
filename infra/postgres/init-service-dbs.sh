#!/bin/sh
# Runs ONCE when the postgres container starts with an empty data volume (docker-entrypoint-initdb.d).
# One database + one database user per service; each user can connect ONLY to its own database.
# Passwords come from the environment (docker-compose.yml); the defaults are for local use only.
set -eu

for svc in identity catalog order inventory payment notification; do
  var="$(echo "$svc" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
  pw="$(eval "echo \${$var:-${svc}-dev-password}")"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE ${svc}_svc WITH LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE scalecart_${svc} OWNER ${svc}_svc;
REVOKE CONNECT ON DATABASE scalecart_${svc} FROM PUBLIC;
GRANT CONNECT ON DATABASE scalecart_${svc} TO ${svc}_svc;
SQL
  echo "created scalecart_${svc} (owner ${svc}_svc)"
done
