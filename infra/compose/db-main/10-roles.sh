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
# Connection caps (T-0207) cover each role's pools and add up to 37, the 40 of max_connections less
# the 3 superuser slots, so no role can starve another:
#   ob_owner 4 (migrate 2, room for a test's own pool) | ob_app 13 (web 10 + queue 2) | ob_worker 15 (jobs 8 + bookkeeping 2
#   + pg-boss 4) | ob_ops 3 (seed 2, rewrap-keys 1) | ob_platform 2 (fan-out 1, rewrap-keys 1)
# tests/config/compose.test.ts checks the sum. A cap changes on a live cluster with ALTER ROLE.
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
  CONNECTION LIMIT 4 PASSWORD :'owner_pw';
-- The groups hold no login. INHERIT on the members below, so a group's grants and the RLS
-- policies written TO a group apply to them without SET ROLE.
CREATE ROLE ob_tenant_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ob_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ob_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  IN ROLE ob_tenant_rw, ob_auth CONNECTION LIMIT 13 PASSWORD :'app_pw';
CREATE ROLE ob_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  IN ROLE ob_tenant_rw CONNECTION LIMIT 15 PASSWORD :'worker_pw';
CREATE ROLE ob_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  IN ROLE ob_tenant_rw CONNECTION LIMIT 3 PASSWORD :'ops_pw';
CREATE ROLE ob_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 2 PASSWORD :'platform_pw';

ALTER DATABASE :"db" OWNER TO ob_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO ob_owner, ob_app, ob_worker, ob_ops, ob_platform;
SQL
