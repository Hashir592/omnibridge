-- migrate: no-transaction
-- 0009 one buyer record per order (T-1001: ORD-4, ADR-079 3). Runs as vault_owner, outside a
-- transaction, one statement at a time (ADR-047). A retried or repeated ingest of the same order
-- finds this record and adds none. The canary is left out (its subject is the fixed 'canary').

SET lock_timeout = '1s';
-- A CONCURRENTLY build waits for running transactions and scans the table twice: a wide limit.
SET statement_timeout = '15min';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS records_order_subject
  ON vault.records (workspace_id, kind, subject_type, subject_id)
  WHERE subject_type = 'order' AND NOT canary;
