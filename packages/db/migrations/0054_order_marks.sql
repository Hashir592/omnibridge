-- 0054 order marks and closed lines (T-1004: DEL-1, VAT-3, FIN-1, ORD-6, ORD-9; ADR-081, ADR-083).
-- Runs as ob_owner. Expand only: new columns with constant defaults, no table rewrite. The previous
-- app version neither reads nor writes them. 0055 validates the NOT VALID rule.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- PS-036 (a): dispatched_at is a stand-in (the channel gave no dispatch time). The first real date
-- replaces it once and clears this.
ALTER TABLE app.orders ADD COLUMN dispatch_estimated boolean NOT NULL DEFAULT false;

-- F-M10-end-12: the buyer has asked to cancel and the channel has not decided. Never grouped.
ALTER TABLE app.orders ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;

-- ADR-081 (3): why the order's pence differ from the channel's, shown in its money breakdown.
--   channel_total  the stored pence do not add up to the total the channel states
--   late_change    the channel changed amounts or lines after they were fixed; nothing was changed
--   refund_above   refunds come to more than the order, so VAT was given back up to what was left
ALTER TABLE app.orders ADD COLUMN amounts_differ text[] NOT NULL DEFAULT '{}';
ALTER TABLE app.orders ADD CONSTRAINT orders_amounts_differ
  CHECK (amounts_differ <@ ARRAY['channel_total', 'late_change', 'refund_above']) NOT VALID;

-- ADR-081 (1): the channel dropped or changed this line before payment. It is out of totals, VAT,
-- stock demand and views; its movements stay in the log.
ALTER TABLE app.order_lines ADD COLUMN removed_at timestamptz;
