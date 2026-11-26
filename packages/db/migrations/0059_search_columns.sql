-- 0059 what order search reads (T-1004: ORD-2, CAP-7; ADR-081 6, F-M10-end-09). Runs as ob_owner.
-- Prefix search by range on normalised copies: a comparison under row-level security uses an index
-- only when its operator is leakproof (text < and >= are; LIKE and lower() are not), and a plain
-- range needs the C collation. Kept by insert triggers, so the previous app version keeps them right
-- unasked; the references and SKUs they copy never change. Expand only: nullable columns.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.orders ADD COLUMN search_ref text COLLATE "C";
ALTER TABLE app.order_lines ADD COLUMN search_sku text COLLATE "C";
ALTER TABLE app.master_skus ADD COLUMN search_sku text COLLATE "C";

CREATE FUNCTION app.orders_search() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.search_ref := lower(NEW.external_order_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER orders_search BEFORE INSERT ON app.orders
  FOR EACH ROW EXECUTE FUNCTION app.orders_search();

CREATE FUNCTION app.order_lines_search() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.search_sku := lower(NEW.external_sku);
  RETURN NEW;
END
$$;
CREATE TRIGGER order_lines_search BEFORE INSERT ON app.order_lines
  FOR EACH ROW EXECUTE FUNCTION app.order_lines_search();

CREATE FUNCTION app.master_skus_search() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.search_sku := lower(NEW.sku);
  RETURN NEW;
END
$$;
CREATE TRIGGER master_skus_search BEFORE INSERT ON app.master_skus
  FOR EACH ROW EXECUTE FUNCTION app.master_skus_search();

-- Rows stored before this (dev data: nothing is deployed, ADR-029). The owner is held to the tenant
-- policies (FORCE), so they step aside for it inside this transaction only, and come back before it
-- commits; every other role keeps them throughout.
ALTER TABLE app.orders NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.order_lines NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.master_skus NO FORCE ROW LEVEL SECURITY;
UPDATE app.orders SET search_ref = lower(external_order_id) WHERE search_ref IS NULL;
UPDATE app.order_lines SET search_sku = lower(external_sku)
 WHERE search_sku IS NULL AND external_sku IS NOT NULL AND removed_at IS NULL;
UPDATE app.master_skus SET search_sku = lower(sku) WHERE search_sku IS NULL;
ALTER TABLE app.orders FORCE ROW LEVEL SECURITY;
ALTER TABLE app.order_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE app.master_skus FORCE ROW LEVEL SECURITY;
