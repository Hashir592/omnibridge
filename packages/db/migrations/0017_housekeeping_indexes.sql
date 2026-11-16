-- migrate: no-transaction
-- 0017 housekeeping indexes (T-0207: F-M01-end-05, F-M01-end-06, F-M02h-06; ADR-047). Runs as
-- ob_owner, outside a transaction, one statement at a time. Each statement is idempotent, and
-- the runner rebuilds an index a failed run left invalid, so a repeat is safe.

SET lock_timeout = '1s';
-- A CONCURRENTLY build waits for running transactions and scans the table twice: a wide limit.
SET statement_timeout = '15min';

-- F-M01-end-06: the credential purge filters on delete_after (0005), not expires_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS credentials_purge_due
  ON app.credentials (workspace_id, delete_after) WHERE NOT is_active;
DROP INDEX CONCURRENTLY IF EXISTS app.credentials_purge;

-- F-M01-end-05: JobRecordRepository.purge deletes finished records and expired leases.
CREATE INDEX CONCURRENTLY IF NOT EXISTS job_records_finished
  ON app.job_records (workspace_id, updated_at) WHERE state IN ('completed', 'failed');
CREATE INDEX CONCURRENTLY IF NOT EXISTS job_leases_expires
  ON app.job_leases (workspace_id, expires_at);

-- F-M02h-06: app.auth_purge() deletes by these expressions.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_ended
  ON app.sessions ((least(revoked_at, expires_at)));
CREATE INDEX CONCURRENTLY IF NOT EXISTS password_resets_ended
  ON app.password_resets ((least(used_at, expires_at)));
