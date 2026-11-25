-- migrate: no-transaction
-- 0060 the order search indexes (T-1004: ORD-2, CAP-7; ADR-047). Runs as ob_owner, outside a
-- transaction, one statement at a time. Idempotent; the runner rebuilds an index a failed run left
-- invalid, so a repeat is safe.

SET lock_timeout = '1s';
-- A CONCURRENTLY build waits for running transactions and scans the table twice: a wide limit.
SET statement_timeout = '15min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_search_ref
  ON app.orders (workspace_id, search_ref);
CREATE INDEX CONCURRENTLY IF NOT EXISTS order_lines_search_sku
  ON app.order_lines (workspace_id, search_sku);
CREATE INDEX CONCURRENTLY IF NOT EXISTS master_skus_search
  ON app.master_skus (workspace_id, search_sku);
-- The orders of a Master SKU that a search found.
CREATE INDEX CONCURRENTLY IF NOT EXISTS order_lines_master_sku
  ON app.order_lines (workspace_id, master_sku_id) WHERE master_sku_id IS NOT NULL;
