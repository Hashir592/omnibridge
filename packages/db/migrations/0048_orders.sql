-- 0048 orders, lines, status history, refunds and the VAT ledger (T-1001: ORD-3, ORD-4, VAT-1 to
-- VAT-7, FA-10, FA-11, FA-12, FA-16). Runs as ob_owner. New tables only, plus one nullable column.
--
-- Company-scoped (ARCHITECTURE 6.1, FA-13): every table here carries company_id with the restrictive
-- company policy, so Combined means the user's permitted companies only. db-main holds no buyer PII
-- (ORD-4, invariant 7): an order points at its pii-vault record by `pii_ref` and by `pii_subject`
-- (the channel account and external order ID), both IDs only. Money is bigint pence (invariant 12).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- Orders (ORD-3, ORD-4) ---------------------------------------------------------------------
CREATE TABLE app.orders (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('amazon', 'ebay', 'website')),
  external_order_id text NOT NULL CHECK (char_length(external_order_id) BETWEEN 1 AND 200),
  -- The vault subject: '<channel_account_id>:<external_order_id>' (one buyer record per order).
  pii_subject text NOT NULL CHECK (char_length(pii_subject) BETWEEN 1 AND 200),
  pii_ref uuid,
  -- Set when the vault record is deleted (expiry, cancellation, erasure) or was never kept (FA-16,
  -- the eBay tombstone check). Shown as "Customer details deleted on {date}" (ORD-6).
  pii_deleted_at timestamptz,
  -- FA-10: the normalised status moves only along the state table; raw_status is the channel's.
  status text NOT NULL CHECK (status IN ('pending_payment', 'awaiting_dispatch', 'label_created',
                                         'dispatched', 'delivered', 'cancelled',
                                         'partly_refunded', 'refunded', 'returned')),
  raw_status text NOT NULL CHECK (char_length(raw_status) BETWEEN 1 AND 100),
  placed_at timestamptz NOT NULL,
  paid_at timestamptz,
  ship_by timestamptz,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  -- The channel's last-modified time of the newest update applied.
  source_updated_at timestamptz NOT NULL,
  -- VAT-1, invariant 13: the London date the order was placed; written once.
  tax_point_date date NOT NULL,
  goods_pence bigint NOT NULL CHECK (goods_pence >= 0),
  discount_pence bigint NOT NULL DEFAULT 0 CHECK (discount_pence >= 0),
  shipping_pence bigint NOT NULL DEFAULT 0 CHECK (shipping_pence >= 0),
  gross_pence bigint NOT NULL CHECK (gross_pence >= 0),
  vat_pence bigint NOT NULL DEFAULT 0 CHECK (vat_pence >= 0),
  ship_to_country text CHECK (ship_to_country ~ '^[A-Z]{2}$'),
  -- ORD-1 flags.
  oversold boolean NOT NULL DEFAULT false,
  unmapped boolean NOT NULL DEFAULT false,
  address_shortened boolean NOT NULL DEFAULT false,
  fba boolean NOT NULL DEFAULT false,
  -- VAT-6: sale VAT is written once payment is captured, never for an order cancelled before it.
  vat_recorded_at timestamptz,
  notes text CHECK (char_length(notes) <= 2000),
  notes_updated_at timestamptz,
  notes_updated_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT orders_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id),
  CONSTRAINT orders_discount CHECK (discount_pence <= goods_pence)
);
CALL app.add_origin_columns('app.orders');
ALTER TABLE app.orders ADD CONSTRAINT orders_external
  UNIQUE (workspace_id, channel_account_id, external_order_id);
ALTER TABLE app.orders ADD CONSTRAINT orders_subject UNIQUE (workspace_id, pii_subject);
CREATE INDEX orders_placed ON app.orders (workspace_id, placed_at DESC, id);
CREATE INDEX orders_pii_ref ON app.orders (workspace_id, pii_ref) WHERE pii_ref IS NOT NULL;
CREATE INDEX orders_awaiting ON app.orders (workspace_id, channel_account_id, placed_at)
  WHERE status = 'awaiting_dispatch';
ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_tenant ON app.orders
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY orders_scope ON app.orders AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
-- An order is never deleted by the app; statutory retention (PRD 7.3) is an ops job.
REVOKE DELETE ON app.orders FROM ob_tenant_rw;

-- The placed time, tax point and company are written once (VAT-1, invariant 13).
CREATE FUNCTION app.orders_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tax_point_date IS DISTINCT FROM OLD.tax_point_date
     OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.channel_account_id IS DISTINCT FROM OLD.channel_account_id
     OR NEW.external_order_id IS DISTINCT FROM OLD.external_order_id
     OR NEW.pii_subject IS DISTINCT FROM OLD.pii_subject THEN
    RAISE EXCEPTION 'an order''s identity, placed time and tax point never change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER orders_fixed BEFORE UPDATE ON app.orders
  FOR EACH ROW EXECUTE FUNCTION app.orders_fixed();

-- ---- Order lines (ORD-4; FA-11 write-once snapshots) -------------------------------------------
CREATE TABLE app.order_lines (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no bigint NOT NULL CHECK (line_no >= 1),
  external_line_id text NOT NULL CHECK (char_length(external_line_id) BETWEEN 1 AND 200),
  listing_id uuid,
  external_sku text CHECK (char_length(external_sku) BETWEEN 1 AND 200),
  title text CHECK (char_length(title) <= 500),
  quantity bigint NOT NULL CHECK (quantity >= 1),
  unit_gross_pence bigint NOT NULL CHECK (unit_gross_pence >= 0),
  line_gross_pence bigint NOT NULL CHECK (line_gross_pence >= 0),
  -- This line's share of the order discount, shipping and its group's VAT (VAT-3, FA-12).
  discount_pence bigint NOT NULL DEFAULT 0 CHECK (discount_pence >= 0),
  shipping_pence bigint NOT NULL DEFAULT 0 CHECK (shipping_pence >= 0),
  vat_pence bigint NOT NULL DEFAULT 0 CHECK (vat_pence >= 0),
  -- Snapshots (invariant 14, FA-11): null to a value, once. The trigger below enforces it.
  master_sku_id uuid,
  vat_type text CHECK (vat_type IN ('standard', 'reduced', 'zero', 'no_vat')),
  vat_rate_bp bigint CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  cogs_pence bigint CHECK (cogs_pence >= 0),
  -- While unmapped the line counts at the workspace default rate and is provisional (FA-11).
  provisional_rate_bp bigint NOT NULL CHECK (provisional_rate_bp BETWEEN 0 AND 10000),
  snapshot_at timestamptz,
  oversold boolean NOT NULL DEFAULT false,
  fba boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT order_lines_external UNIQUE (workspace_id, order_id, external_line_id),
  CONSTRAINT order_lines_order_fk FOREIGN KEY (workspace_id, order_id)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT order_lines_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id),
  CONSTRAINT order_lines_listing_fk FOREIGN KEY (workspace_id, listing_id)
    REFERENCES app.listings (workspace_id, id),
  CONSTRAINT order_lines_sku_fk FOREIGN KEY (workspace_id, master_sku_id)
    REFERENCES app.master_skus (workspace_id, id),
  CONSTRAINT order_lines_snapshot CHECK ((vat_type IS NULL) = (vat_rate_bp IS NULL)
                                         AND (vat_type IS NULL) = (snapshot_at IS NULL))
);
CREATE INDEX order_lines_order ON app.order_lines (workspace_id, order_id, line_no);
-- CAT-6 back-fill and late snapshots: the lines of a listing that were unmapped when stored.
CREATE INDEX order_lines_provisional ON app.order_lines (workspace_id, listing_id)
  WHERE vat_type IS NULL;
ALTER TABLE app.order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY order_lines_tenant ON app.order_lines
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY order_lines_scope ON app.order_lines AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE DELETE ON app.order_lines FROM ob_tenant_rw;

-- FA-11 / invariant 14: a snapshot goes from null to a value once and never changes after; the
-- line's own facts (quantity, price, order) never change at all.
CREATE FUNCTION app.order_lines_write_once() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (OLD.vat_type IS NOT NULL AND NEW.vat_type IS DISTINCT FROM OLD.vat_type)
     OR (OLD.vat_rate_bp IS NOT NULL AND NEW.vat_rate_bp IS DISTINCT FROM OLD.vat_rate_bp)
     OR (OLD.cogs_pence IS NOT NULL AND NEW.cogs_pence IS DISTINCT FROM OLD.cogs_pence)
     OR (OLD.master_sku_id IS NOT NULL AND NEW.master_sku_id IS DISTINCT FROM OLD.master_sku_id)
     OR (OLD.snapshot_at IS NOT NULL AND NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at)
     OR NEW.provisional_rate_bp IS DISTINCT FROM OLD.provisional_rate_bp
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.unit_gross_pence IS DISTINCT FROM OLD.unit_gross_pence
     OR NEW.line_gross_pence IS DISTINCT FROM OLD.line_gross_pence
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'order line snapshots are write-once (invariant 14)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER order_lines_write_once BEFORE UPDATE ON app.order_lines
  FOR EACH ROW EXECUTE FUNCTION app.order_lines_write_once();

-- ---- Status history (ORD-6, FA-10) -------------------------------------------------------------
-- One row per channel update that changed the raw or normalised status. `status` is null when the
-- update was kept but the state table refused the move.
CREATE TABLE app.order_status_events (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  status text CHECK (status IN ('pending_payment', 'awaiting_dispatch', 'label_created',
                                'dispatched', 'delivered', 'cancelled', 'partly_refunded',
                                'refunded', 'returned')),
  raw_status text NOT NULL CHECK (char_length(raw_status) BETWEEN 1 AND 100),
  source_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT order_status_events_order_fk FOREIGN KEY (workspace_id, order_id)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT order_status_events_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
CREATE INDEX order_status_events_order
  ON app.order_status_events (workspace_id, order_id, created_at);
ALTER TABLE app.order_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.order_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY order_status_events_tenant ON app.order_status_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY order_status_events_scope ON app.order_status_events AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE UPDATE, DELETE ON app.order_status_events FROM ob_tenant_rw;

-- ---- Refunds (VAT-5, ORD-7) --------------------------------------------------------------------
CREATE TABLE app.refunds (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  external_refund_id text NOT NULL CHECK (char_length(external_refund_id) BETWEEN 1 AND 200),
  refunded_at timestamptz NOT NULL,
  -- VAT-5: the refund counts in the VAT quarter of this London date.
  tax_point_date date NOT NULL,
  amount_pence bigint NOT NULL CHECK (amount_pence >= 0),
  vat_pence bigint NOT NULL CHECK (vat_pence >= 0),
  return_to_stock boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT refunds_external UNIQUE (workspace_id, order_id, external_refund_id),
  CONSTRAINT refunds_order_fk FOREIGN KEY (workspace_id, order_id)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT refunds_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
CREATE INDEX refunds_by_date ON app.refunds (workspace_id, refunded_at DESC, id);
CREATE INDEX refunds_by_order ON app.refunds (workspace_id, order_id);
ALTER TABLE app.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY refunds_tenant ON app.refunds
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY refunds_scope ON app.refunds AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE UPDATE, DELETE ON app.refunds FROM ob_tenant_rw;

CREATE TABLE app.refund_lines (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  amount_pence bigint NOT NULL CHECK (amount_pence >= 0),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT refund_lines_unique UNIQUE (workspace_id, refund_id, order_line_id),
  CONSTRAINT refund_lines_refund_fk FOREIGN KEY (workspace_id, refund_id)
    REFERENCES app.refunds (workspace_id, id),
  CONSTRAINT refund_lines_line_fk FOREIGN KEY (workspace_id, order_line_id)
    REFERENCES app.order_lines (workspace_id, id),
  CONSTRAINT refund_lines_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
ALTER TABLE app.refund_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.refund_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_lines_tenant ON app.refund_lines
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY refund_lines_scope ON app.refund_lines AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE UPDATE, DELETE ON app.refund_lines FROM ob_tenant_rw;

-- ---- VAT ledger (VAT-1 to VAT-7, FA-11, FA-12) -------------------------------------------------
-- Append-only output VAT by rate group: a sale row per group once payment is captured, a refund
-- row per group (negative, in the refund date's quarter), and adjustment rows when a late mapping
-- fills a provisional line (the difference). `entry_key` makes each one happen once.
-- `period_date` is the date the VAT report counts it on: the tax point, or the next open period
-- when that period is filed (FA-11, VQ-3; filing arrives with the VAT quarters module).
CREATE TABLE app.vat_ledger (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  refund_id uuid,
  entry_key text NOT NULL CHECK (char_length(entry_key) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind IN ('sale', 'refund', 'adjustment')),
  vat_type text CHECK (vat_type IN ('standard', 'reduced', 'zero', 'no_vat')),
  rate_bp bigint NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  provisional boolean NOT NULL,
  gross_pence bigint NOT NULL,
  vat_pence bigint NOT NULL,
  net_pence bigint NOT NULL,
  tax_point_date date NOT NULL,
  period_date date NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT vat_ledger_entry UNIQUE (workspace_id, entry_key),
  CONSTRAINT vat_ledger_net CHECK (net_pence = gross_pence - vat_pence),
  CONSTRAINT vat_ledger_order_fk FOREIGN KEY (workspace_id, order_id)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT vat_ledger_refund_fk FOREIGN KEY (workspace_id, refund_id)
    REFERENCES app.refunds (workspace_id, id),
  CONSTRAINT vat_ledger_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
CREATE INDEX vat_ledger_period ON app.vat_ledger (workspace_id, period_date);
CREATE INDEX vat_ledger_order ON app.vat_ledger (workspace_id, order_id);
ALTER TABLE app.vat_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vat_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY vat_ledger_tenant ON app.vat_ledger
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY vat_ledger_scope ON app.vat_ledger AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE UPDATE, DELETE ON app.vat_ledger FROM ob_tenant_rw;

-- ---- Cutover: stock push per account (FA-16) ---------------------------------------------------
-- A newly connected account holds its stock writes until its first reconciliation shows no drift;
-- the reconciliation then clears the hold. Null means writes go out, so accounts that exist now
-- carry on as before. The Connect route (T-1101) creates accounts with the hold set.
ALTER TABLE app.channel_accounts ADD COLUMN stock_push_held_since timestamptz;
