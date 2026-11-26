-- migrate: no-transaction
-- 0057 one open line per channel line ID (T-1004: F-M10-end-05; ADR-047). Runs as ob_owner, outside a
-- transaction, one statement at a time. Idempotent; the runner rebuilds an index a failed run left
-- invalid, so a repeat is safe. 0058 drops the wider rule it replaces.

SET lock_timeout = '1s';
-- A CONCURRENTLY build waits for running transactions and scans the table twice: a wide limit.
SET statement_timeout = '15min';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS order_lines_external_live
  ON app.order_lines (workspace_id, order_id, external_line_id) WHERE removed_at IS NULL;
