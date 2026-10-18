#!/bin/sh
# Creates the db-pii roles (ADR-007). Runs once, when the PostgreSQL image initialises an empty
# volume, as the image's bootstrap superuser. Only pii-vault ever connects to this cluster.
#   vault_owner  owns the database and every object; runs migrations only
#   vault_app    pii-vault; DML only; NOBYPASSRLS
# Passwords are read inside psql from Docker secret files (SEC-5), so they never appear in argv.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" <<'SQL'
\set owner_pw `cat /run/secrets/vault_owner_password`
\set app_pw `cat /run/secrets/vault_app_password`

CREATE ROLE vault_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'owner_pw';
CREATE ROLE vault_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 8 PASSWORD :'app_pw';

ALTER DATABASE :"db" OWNER TO vault_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO vault_owner, vault_app;
SQL
