-- 0001 baseline for db-main (T-0101). No business tables: those start in T-0201.
-- Runs as ob_owner. The migrate job installs the pg-boss schema before this file runs.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Application schema. Every tenant table added later lives here, owned by ob_owner.
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ob_owner;
GRANT USAGE ON SCHEMA app TO ob_app, ob_platform;

-- ob_app reads and writes rows in tables ob_owner creates; it can never create or alter tables.
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO ob_app;

-- Queue schema (pg-boss, ADR-009): the worker and web enqueue and consume as ob_app.
GRANT USAGE ON SCHEMA pgboss TO ob_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ob_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ob_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO ob_app;
