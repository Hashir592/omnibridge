-- 0045 an order line's own reservation (F-M09-T0901-01, T-0901: INV-1, INV-3, CAT-5, CAT-6).
-- Runs as ob_owner. Expand only; 0046 validates the two NOT VALID rules.
--
-- Release and dispatch must work from the line's live reservation (where it is reserved now,
-- and how much), not from the listing's current mapping. Every movement of a line now names
-- the line, and a remap moves a line's open reservation to the new SKU with two movements of
-- source kind `remap` (a release on the old SKU and a reserve on the new one).
-- No row needs back-filling: no order line has moved stock yet (M10 brings the first), and the
-- engine reads `source_id` as the line for order_line rows without one.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.stock_movements ADD COLUMN order_line_id text;
ALTER TABLE app.stock_movements ADD CONSTRAINT stock_movements_order_line
  CHECK (char_length(order_line_id) BETWEEN 1 AND 200) NOT VALID;

-- The wider rule goes on first, so the table is never without one.
ALTER TABLE app.stock_movements ADD CONSTRAINT stock_movements_source
  CHECK (source_kind IN ('order_line', 'refund_line', 'user', 'stock_take', 'allocation',
                         'remap')) NOT VALID;
-- Contract: the 0043 rule is the new one minus remap, so dropping it removes no guarantee.
-- waiver: replaced by stock_movements_source; F-M09-T0901-01
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_source_kind_check;

-- The index on order_line_id is built CONCURRENTLY by 0047 (ADR-047).
