-- migrate: no-transaction
-- 0053 provisional order lines by external SKU (T-1001: CAT-6, VAT-2; ADR-047). Runs as ob_owner,
-- outside a transaction, one statement at a time. Idempotent; the runner rebuilds an index a failed
-- run left invalid, so a repeat is safe.

SET lock_timeout = '1s';
-- A CONCURRENTLY build waits for running transactions and scans the table twice: a wide limit.
SET statement_timeout = '15min';

-- Lines stored before their listing was discovered or mapped, found by the code that was sold.
CREATE INDEX CONCURRENTLY IF NOT EXISTS order_lines_provisional_sku
  ON app.order_lines (workspace_id, external_sku) WHERE vat_type IS NULL;
