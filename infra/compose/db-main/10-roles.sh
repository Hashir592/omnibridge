#!/bin/sh
# Creates the db-main roles (ADR-006, ARCHITECTURE.md invariant 2). Runs once, when the
# PostgreSQL image initialises an empty volume, as the image's bootstrap superuser.
#   ob_owner      owns the database and every object; runs migrations only
#   ob_tenant_rw  NOLOGIN group: the table, sequence and helper grants and the tenant RLS
#                 policies (ADR-051)
#   ob_auth       NOLOGIN group: EXECUTE on the auth, session and platform-key definers (ADR-051)
#   ob_app        web: ob_tenant_rw and ob_auth; NOBYPASSRLS
#   ob_worker     worker: ob_tenant_rw, plus the few definers its jobs call and the audit purge
#                 (ADR-049, ADR-051); NOBYPASSRLS
#   ob_ops        rewrap-keys and the dev seed: ob_tenant_rw, plus the platform-key and seed
#                 definers (ADR-051); NOBYPASSRLS
#   ob_platform   scheduler fan-out; reads the workspace list only
# Grants are given by the migrations (0013 for the groups); this script only makes the roles.
# Passwords are read inside psql from Docker secret files (SEC-5), so they never appear in argv.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" <<'SQL'
\set owner_pw `cat /run/secrets/ob_owner_password`
\set app_pw `cat /run/secrets/ob_app_password`
\set platform_pw `cat /run/secrets/ob_platform_password`
\set worker_pw `cat /run/secrets/ob_worker_password`
\set ops_pw `cat /run/secrets/ob_ops_password`

CREATE ROLE ob_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'owner_pw';
-- The groups hold no login. INHERIT on the members below, so a group's grants and the RLS
-- policies written TO a group apply to them without SET ROLE.
CREATE ROLE ob_tenant_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ob_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ob_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  IN ROLE ob_tenant_rw, ob_auth CONNECTION LIMIT 30 PASSWORD :'app_pw';
CREATE ROLE ob_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  IN ROLE ob_tenant_rw CONNECTION LIMIT 20 PASSWORD :'worker_pw';
CREATE ROLE ob_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  IN ROLE ob_tenant_rw CONNECTION LIMIT 2 PASSWORD :'ops_pw';
CREATE ROLE ob_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 4 PASSWORD :'platform_pw';

ALTER DATABASE :"db" OWNER TO ob_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO ob_owner, ob_app, ob_worker, ob_ops, ob_platform;
SQL
