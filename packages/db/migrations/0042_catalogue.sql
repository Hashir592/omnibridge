-- 0042 catalogue (T-0801: CAT-1 to CAT-6, FIN-1, AT-5). Runs as ob_owner. Expand only: new tables.
--
-- Every table here is workspace-shared (ARCHITECTURE 6.1, ADR-078 3): the workspace policy only,
-- no company_id, so every member with the Stock & Catalogue tab sees the whole catalogue.
--
-- * app.master_skus: one row per product (CAT-1). A bundle (CAT-3) names one component SKU and a
--   pack size; it has no stock, VAT type or COGS of its own. Its make-up never changes.
-- * app.sku_vat_types: the VAT-type history of each plain SKU (ADR-078 4), so the type in force
--   on an order's date is known when M10 fills its write-once snapshot.
-- * app.vat_rates: the rate of each VAT type from a date (CAT-2); a rate change needs no code.
-- * app.cogs_history: ex-VAT COGS per unit from a date (CAT-4), integer pence (FIN-1).
-- * app.listings: channel listings found by discovery (CAT-5), each mapped to at most one SKU.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- Master SKUs (CAT-1, CAT-3) ----------------------------------------------------------------
CREATE TABLE app.master_skus (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  -- Matched exactly against channel SKUs (CAT-5); no leading or trailing space.
  sku text NOT NULL CHECK (char_length(sku) BETWEEN 1 AND 64 AND sku = btrim(sku)),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  -- The carrier item description.
  short_description text NOT NULL CHECK (char_length(short_description) BETWEEN 1 AND 100),
  barcode text CHECK (char_length(barcode) BETWEEN 1 AND 64),
  manufacturer text CHECK (char_length(manufacturer) BETWEEN 1 AND 100),
  weight_g bigint NOT NULL DEFAULT 0 CHECK (weight_g BETWEEN 0 AND 1000000),
  length_mm bigint CHECK (length_mm BETWEEN 1 AND 10000),
  width_mm bigint CHECK (width_mm BETWEEN 1 AND 10000),
  height_mm bigint CHECK (height_mm BETWEEN 1 AND 10000),
  image_url text CHECK (char_length(image_url) BETWEEN 1 AND 2000),
  -- CAT-4: only when the purchase VAT rate differs from the SKU's VAT type (PRF-6).
  purchase_vat_rate_bp bigint CHECK (purchase_vat_rate_bp BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  lead_time_days bigint NOT NULL DEFAULT 0 CHECK (lead_time_days BETWEEN 0 AND 365),
  safety_days bigint NOT NULL DEFAULT 0 CHECK (safety_days BETWEEN 0 AND 365),
  target_cover_days bigint NOT NULL DEFAULT 0 CHECK (target_cover_days BETWEEN 0 AND 730),
  -- CAT-3: one component SKU and a pack size, both or neither. One component only: a bundle of
  -- two different SKUs has no column to live in.
  bundle_component_id uuid,
  pack_size bigint CHECK (pack_size BETWEEN 2 AND 1000),
  created_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT master_skus_code UNIQUE (workspace_id, sku),
  CONSTRAINT master_skus_bundle CHECK ((bundle_component_id IS NULL) = (pack_size IS NULL)
                                       AND bundle_component_id IS DISTINCT FROM id),
  CONSTRAINT master_skus_dimensions CHECK (
    (length_mm IS NULL AND width_mm IS NULL AND height_mm IS NULL)
    OR (length_mm IS NOT NULL AND width_mm IS NOT NULL AND height_mm IS NOT NULL)),
  CONSTRAINT master_skus_component_fk FOREIGN KEY (workspace_id, bundle_component_id)
    REFERENCES app.master_skus (workspace_id, id)
);
CREATE INDEX master_skus_by_component ON app.master_skus (workspace_id, bundle_component_id)
  WHERE bundle_component_id IS NOT NULL;
CREATE INDEX master_skus_manufacturer ON app.master_skus (workspace_id, manufacturer)
  WHERE manufacturer IS NOT NULL;
ALTER TABLE app.master_skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.master_skus FORCE ROW LEVEL SECURITY;
CREATE POLICY master_skus_tenant ON app.master_skus
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- SKUs are deactivated, never deleted: order lines and movements point at them.
REVOKE DELETE ON app.master_skus FROM ob_tenant_rw;

-- CAT-3: a bundle's component is a plain SKU, and a bundle's make-up never changes (a different
-- pack is a new SKU). SQLSTATE OBK01 is the catalogue's "refused" code.
CREATE FUNCTION app.master_skus_bundle_rules() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.bundle_component_id IS DISTINCT FROM OLD.bundle_component_id
                           OR NEW.pack_size IS DISTINCT FROM OLD.pack_size
                           OR NEW.sku IS DISTINCT FROM OLD.sku) THEN
    RAISE EXCEPTION 'a SKU code and a bundle make-up never change' USING ERRCODE = 'OBK01';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.bundle_component_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM app.master_skus c
        WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.bundle_component_id
          AND c.bundle_component_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a bundle component must be a plain SKU' USING ERRCODE = 'OBK01';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.master_skus_bundle_rules() FROM PUBLIC;
CREATE TRIGGER master_skus_bundle_rules BEFORE INSERT OR UPDATE ON app.master_skus
  FOR EACH ROW EXECUTE FUNCTION app.master_skus_bundle_rules();

-- ---- VAT types and rates (CAT-2) ---------------------------------------------------------------
-- The type of a plain SKU from a date (ADR-078 4). A bundle has no rows: it follows its component.
CREATE TABLE app.sku_vat_types (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  master_sku_id uuid NOT NULL,
  vat_type text NOT NULL CHECK (vat_type IN ('standard', 'reduced', 'zero', 'no_vat')),
  effective_from date NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, master_sku_id, effective_from),
  CONSTRAINT sku_vat_types_sku_fk FOREIGN KEY (workspace_id, master_sku_id)
    REFERENCES app.master_skus (workspace_id, id)
);
ALTER TABLE app.sku_vat_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sku_vat_types FORCE ROW LEVEL SECURITY;
CREATE POLICY sku_vat_types_tenant ON app.sku_vat_types
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE DELETE ON app.sku_vat_types FROM ob_tenant_rw;

-- Zero-rated and No VAT are separate types (CAT-2) and both are 0%.
CREATE TABLE app.vat_rates (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  vat_type text NOT NULL CHECK (vat_type IN ('standard', 'reduced', 'zero', 'no_vat')),
  effective_from date NOT NULL,
  rate_bp bigint NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, vat_type, effective_from),
  CONSTRAINT vat_rates_zero CHECK (vat_type NOT IN ('zero', 'no_vat') OR rate_bp = 0)
);
ALTER TABLE app.vat_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vat_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY vat_rates_tenant ON app.vat_rates
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON app.vat_rates FROM ob_tenant_rw;

-- The UK rates every workspace starts with. A new workspace gets them in its own creating
-- transaction (the RLS check passes: app.workspace_id is the new id).
CREATE FUNCTION app.vat_rates_defaults() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.vat_rates (workspace_id, vat_type, effective_from, rate_bp, created_at)
  VALUES (NEW.id, 'standard', DATE '2011-01-04', 2000, now()),
         (NEW.id, 'reduced', DATE '1997-09-01', 500, now()),
         (NEW.id, 'zero', DATE '1973-04-01', 0, now()),
         (NEW.id, 'no_vat', DATE '1973-04-01', 0, now());
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.vat_rates_defaults() FROM PUBLIC;
CREATE TRIGGER workspaces_vat_rates AFTER INSERT ON app.workspaces
  FOR EACH ROW EXECUTE FUNCTION app.vat_rates_defaults();

-- Existing workspaces: ob_owner is subject to forced RLS, so each one is written under its own id.
DO $$
DECLARE
  w uuid;
BEGIN
  FOR w IN SELECT id FROM app.workspaces LOOP
    PERFORM set_config('app.workspace_id', w::text, true);
    INSERT INTO app.vat_rates (workspace_id, vat_type, effective_from, rate_bp, created_at)
    VALUES (w, 'standard', DATE '2011-01-04', 2000, now()),
           (w, 'reduced', DATE '1997-09-01', 500, now()),
           (w, 'zero', DATE '1973-04-01', 0, now()),
           (w, 'no_vat', DATE '1973-04-01', 0, now());
  END LOOP;
  PERFORM set_config('app.workspace_id', '', true);
END
$$;

-- ---- COGS (CAT-4) ------------------------------------------------------------------------------
-- Ex-VAT cost per unit from a date. The same date again replaces the value; an order line keeps
-- its own snapshot (M10), so a change here never alters past profit.
CREATE TABLE app.cogs_history (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  master_sku_id uuid NOT NULL,
  effective_from date NOT NULL,
  cogs_pence bigint NOT NULL CHECK (cogs_pence BETWEEN 0 AND 100000000),
  created_by uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, master_sku_id, effective_from),
  CONSTRAINT cogs_history_sku_fk FOREIGN KEY (workspace_id, master_sku_id)
    REFERENCES app.master_skus (workspace_id, id)
);
ALTER TABLE app.cogs_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cogs_history FORCE ROW LEVEL SECURITY;
CREATE POLICY cogs_history_tenant ON app.cogs_history
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE DELETE ON app.cogs_history FROM ob_tenant_rw;

-- ---- Listings (CAT-5, CAT-6) -------------------------------------------------------------------
-- One row per channel account and external SKU, found by discovery. `provider` is kept on the row
-- because channel accounts are company-scoped: a workspace-shared list must not lose listings of
-- accounts a child user cannot see.
CREATE TABLE app.listings (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('amazon', 'ebay', 'website')),
  external_sku text NOT NULL CHECK (char_length(external_sku) BETWEEN 1 AND 200),
  -- Listing ID, ASIN or item ID.
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  title text CHECK (char_length(title) <= 500),
  fulfilment text CHECK (fulfilment IN ('mfn', 'fba')),
  inventory_api boolean,
  -- The quantity the channel showed at the last discovery or reconciliation (INV-7).
  channel_qty bigint CHECK (channel_qty >= 0),
  master_sku_id uuid,
  -- auto: matched on the exact code at discovery; manual: mapped by a person or a CSV.
  mapping_source text CHECK (mapping_source IN ('auto', 'manual')),
  mapped_at timestamptz,
  mapped_by uuid,
  discovered_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  -- Not seen by a complete scan: the listing ended or its account was disconnected.
  ended_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT listings_mapping CHECK ((master_sku_id IS NULL) = (mapped_at IS NULL)
                                     AND (master_sku_id IS NULL) = (mapping_source IS NULL)),
  CONSTRAINT listings_sku_fk FOREIGN KEY (workspace_id, master_sku_id)
    REFERENCES app.master_skus (workspace_id, id)
);
CALL app.add_origin_columns('app.listings');
ALTER TABLE app.listings ADD CONSTRAINT listings_external
  UNIQUE (workspace_id, channel_account_id, external_sku);
CREATE INDEX listings_by_sku ON app.listings (workspace_id, master_sku_id)
  WHERE master_sku_id IS NOT NULL;
CREATE INDEX listings_unmapped ON app.listings (workspace_id, discovered_at)
  WHERE master_sku_id IS NULL AND ended_at IS NULL;
ALTER TABLE app.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listings FORCE ROW LEVEL SECURITY;
CREATE POLICY listings_tenant ON app.listings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
