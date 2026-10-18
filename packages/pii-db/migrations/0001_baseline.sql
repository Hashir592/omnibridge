-- 0001 baseline for db-pii (T-0101). No PII tables yet: those start in M04.
-- Runs as vault_owner. Only pii-vault ever connects to this cluster.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS vault AUTHORIZATION vault_owner;
GRANT USAGE ON SCHEMA vault TO vault_app;

-- vault_app reads and writes rows in tables vault_owner creates; it can never create or alter tables.
ALTER DEFAULT PRIVILEGES FOR ROLE vault_owner IN SCHEMA vault
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vault_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vault_owner IN SCHEMA vault
  GRANT USAGE, SELECT ON SEQUENCES TO vault_app;
