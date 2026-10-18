#!/bin/sh
# Creates the db-main roles (ADR-006, ARCHITECTURE.md invariant 2). Runs once, when the
# PostgreSQL image initialises an empty volume, as the image's bootstrap superuser.
#   ob_owner     owns the database and every object; runs migrations only
#   ob_app       web and worker; DML only; NOBYPASSRLS
#   ob_platform  scheduler fan-out; reads the workspace list only (grants arrive with T-0201)
# Passwords are read inside psql from Docker secret files (SEC-5), so they never appear in argv.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" <<'SQL'
\set owner_pw `cat /run/secrets/ob_owner_password`
\set app_pw `cat /run/secrets/ob_app_password`
\set platform_pw `cat /run/secrets/ob_platform_password`

CREATE ROLE ob_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'owner_pw';
CREATE ROLE ob_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 30 PASSWORD :'app_pw';
CREATE ROLE ob_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 4 PASSWORD :'platform_pw';

ALTER DATABASE :"db" OWNER TO ob_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO ob_owner, ob_app, ob_platform;
SQL
