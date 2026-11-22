-- 0046 validates the stock movement rules 0045 added NOT VALID (F-M09-T0901-01). Runs as
-- ob_owner, in its own transaction so the checks do not hold 0045's locks. Every row meets them:
-- order_line_id is new, and the source rule is the 0043 one plus remap.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.stock_movements VALIDATE CONSTRAINT stock_movements_order_line;
ALTER TABLE app.stock_movements VALIDATE CONSTRAINT stock_movements_source;
