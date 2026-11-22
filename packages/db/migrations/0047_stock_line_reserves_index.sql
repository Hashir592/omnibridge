-- migrate: no-transaction
-- 0047 the order-line index of the stock change log (F-M09-T0901-01; ADR-047). Runs as ob_owner,
-- outside a transaction, one statement at a time. The statement is idempotent, and the runner
-- rebuilds an index a failed run left invalid, so a repeat is safe.

SET lock_timeout = '1s';
-- A CONCURRENTLY build waits for running transactions and scans the table twice: a wide limit.
SET statement_timeout = '15min';

-- An order line's movements, for its live reservation (release, dispatch, remap).
CREATE INDEX CONCURRENTLY IF NOT EXISTS stock_movements_by_line
  ON app.stock_movements (workspace_id, order_line_id) WHERE order_line_id IS NOT NULL;
