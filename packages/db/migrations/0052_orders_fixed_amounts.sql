-- 0052 an order's stored amounts never change (T-1001 fixes: FIN-1, invariant 12). Runs as ob_owner.
-- The goods, discount, shipping and gross of an order feed later VAT adjustments, so they are fixed
-- at ingest like its identity. No app version writes them after the insert (safe with the previous
-- one running).

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
     OR NEW.goods_pence IS DISTINCT FROM OLD.goods_pence
     OR NEW.discount_pence IS DISTINCT FROM OLD.discount_pence
     OR NEW.shipping_pence IS DISTINCT FROM OLD.shipping_pence
     OR NEW.gross_pence IS DISTINCT FROM OLD.gross_pence THEN
    RAISE EXCEPTION 'an order''s identity, placed time, tax point and amounts never change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
