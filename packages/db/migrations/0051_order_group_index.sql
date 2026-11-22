-- migrate: no-transaction
-- 0051 the same-buyer group index (T-1002: ORD-9; ADR-047). Runs as ob_owner, outside a
-- transaction, one statement at a time. Idempotent; the runner rebuilds an index a failed run left
-- invalid, so a repeat is safe.

SET lock_timeout = '1s';
-- A CONCURRENTLY build waits for running transactions and scans the table twice: a wide limit.
SET statement_timeout = '15min';

-- A group's members: the list's group size and place, the detail panel, the group actions.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_by_group
  ON app.orders (workspace_id, order_group_id) WHERE order_group_id IS NOT NULL;
