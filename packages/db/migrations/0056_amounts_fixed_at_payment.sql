-- 0056 an order's amounts and lines are fixed at payment, not before (T-1004: VAT-3, VAT-6, FIN-1;
-- ADR-081 1, F-M10-end-05). Runs as ob_owner. Replaces two trigger functions and adds one trigger.
-- Until sale VAT is recorded, and while the order is not cancelled, the channel's newer amounts and
-- line prices may be written, and a line may be closed. A line's SKU and quantity never change.
-- Safe with the previous app version: it writes none of these after the insert, and it inserts lines
-- only before it records VAT.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.orders_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tax_point_date IS DISTINCT FROM OLD.tax_point_date
     OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.channel_account_id IS DISTINCT FROM OLD.channel_account_id
     OR NEW.external_order_id IS DISTINCT FROM OLD.external_order_id
     OR NEW.pii_subject IS DISTINCT FROM OLD.pii_subject
     OR (OLD.vat_recorded_at IS NOT NULL
         AND NEW.vat_recorded_at IS DISTINCT FROM OLD.vat_recorded_at) THEN
    RAISE EXCEPTION 'an order''s identity, placed time, tax point and VAT time never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.vat_recorded_at IS NOT NULL OR OLD.status = 'cancelled')
     AND (NEW.goods_pence IS DISTINCT FROM OLD.goods_pence
          OR NEW.discount_pence IS DISTINCT FROM OLD.discount_pence
          OR NEW.shipping_pence IS DISTINCT FROM OLD.shipping_pence
          OR NEW.gross_pence IS DISTINCT FROM OLD.gross_pence) THEN
    RAISE EXCEPTION 'an order''s amounts never change once it is paid or cancelled'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.order_lines_write_once() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL
     OR (OLD.vat_type IS NOT NULL AND NEW.vat_type IS DISTINCT FROM OLD.vat_type)
     OR (OLD.vat_rate_bp IS NOT NULL AND NEW.vat_rate_bp IS DISTINCT FROM OLD.vat_rate_bp)
     OR (OLD.cogs_pence IS NOT NULL AND NEW.cogs_pence IS DISTINCT FROM OLD.cogs_pence)
     OR (OLD.master_sku_id IS NOT NULL AND NEW.master_sku_id IS DISTINCT FROM OLD.master_sku_id)
     OR (OLD.snapshot_at IS NOT NULL AND NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at)
     OR NEW.provisional_rate_bp IS DISTINCT FROM OLD.provisional_rate_bp
     OR NEW.line_no IS DISTINCT FROM OLD.line_no
     OR NEW.external_line_id IS DISTINCT FROM OLD.external_line_id
     OR NEW.external_sku IS DISTINCT FROM OLD.external_sku
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.stored_unmapped IS DISTINCT FROM OLD.stored_unmapped THEN
    RAISE EXCEPTION 'order line snapshots are write-once (invariant 14)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.unit_gross_pence IS DISTINCT FROM OLD.unit_gross_pence
      OR NEW.line_gross_pence IS DISTINCT FROM OLD.line_gross_pence
      OR NEW.removed_at IS DISTINCT FROM OLD.removed_at)
     AND NOT EXISTS (SELECT 1 FROM app.orders o
                      WHERE o.workspace_id = OLD.workspace_id AND o.id = OLD.order_id
                        AND o.vat_recorded_at IS NULL AND o.status <> 'cancelled') THEN
    RAISE EXCEPTION 'order line prices are write-once when the order is paid or cancelled'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- No line joins an order whose VAT is recorded.
CREATE FUNCTION app.order_lines_open() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.orders o
              WHERE o.workspace_id = NEW.workspace_id AND o.id = NEW.order_id
                AND o.vat_recorded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'order lines are write-once when the order is paid'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER order_lines_open BEFORE INSERT ON app.order_lines
  FOR EACH ROW EXECUTE FUNCTION app.order_lines_open();
