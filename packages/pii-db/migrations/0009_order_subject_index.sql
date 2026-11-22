-- migrate: no-transaction
-- 0009 one buyer record per order (T-1001: ORD-4, ADR-079 3). Runs as vault_owner.
-- A retried or repeated ingest of the same order finds this record and adds none. The canary is
-- left out (its subject is the fixed 'canary').
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS records_order_subject
  ON vault.records (workspace_id, kind, subject_type, subject_id)
  WHERE subject_type = 'order' AND NOT canary;
