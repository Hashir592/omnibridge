-- 0062 shipping: carrier accounts, labels and label costs (T-1201: SHIP-1, SHIP-3, SHIP-4, EVRI-3,
-- EVRI-6, SHP-5, SHP-7, SHP-9, AT-12, AT-26). Runs as ob_owner. Expand only: new tables, one
-- column with a default, and the channel account read policy split by command.
--
-- * SHIP-1, ARCHITECTURE 6.1: a carrier account belongs to one company and ships for every company,
--   so any user of the workspace may read carrier accounts (ADR-089 2). Every write still needs
--   the account's company, and marketplace and website accounts stay company-scoped for reads.
-- * A label is bought once per parcel: a parcel row exists, with its client UID unique per carrier
--   account, before Evri is called; the job only ever re-reads it. One live shipment per order.
-- * Label files are PII and live in pii-vault's volume (invariant 11); db-main holds IDs, states,
--   codes and costs only. Shipments and parcels are company-scoped like orders.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- SHIP-1: carrier accounts readable by every company ------------------------------------
DROP POLICY channel_accounts_scope ON app.channel_accounts;
CREATE POLICY channel_accounts_scope_read ON app.channel_accounts AS RESTRICTIVE FOR SELECT TO ob_app
  USING (provider IN ('evri', 'dpd')
         OR company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                       '{}'::uuid[])));
CREATE POLICY channel_accounts_scope_insert ON app.channel_accounts AS RESTRICTIVE FOR INSERT
  TO ob_app
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
CREATE POLICY channel_accounts_scope_update ON app.channel_accounts AS RESTRICTIVE FOR UPDATE
  TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
CREATE POLICY channel_accounts_scope_delete ON app.channel_accounts AS RESTRICTIVE FOR DELETE
  TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])));

-- ---- Settings (SHP-2, SHP-4, SHP-6, EVRI-5, ADR-089 3): one row per workspace, defaults when none
CREATE TABLE app.shipping_settings (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  auto_dispatch_on_label boolean NOT NULL DEFAULT true,
  label_format text NOT NULL DEFAULT 'THERMAL'
    CHECK (label_format IN ('THERMAL', 'DEFAULT', 'TWO_PER_PAGE', 'LARGE_SINGLE', 'LARGE_MULTI')),
  packaging_allowance_g bigint NOT NULL DEFAULT 150 CHECK (packaging_allowance_g BETWEEN 0 AND 50000),
  packing_slip_enabled boolean NOT NULL DEFAULT false,
  tracking_hold_minutes bigint NOT NULL DEFAULT 30 CHECK (tracking_hold_minutes BETWEEN 0 AND 240),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id)
);
ALTER TABLE app.shipping_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shipping_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY shipping_settings_tenant ON app.shipping_settings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE DELETE ON app.shipping_settings FROM ob_tenant_rw;

-- ---- SHP-7: label cost per service, ex VAT with a VAT rate (workspace-shared, like the account)
CREATE TABLE app.carrier_service_costs (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  channel_account_id uuid NOT NULL,
  service_code text NOT NULL CHECK (service_code ~ '^[a-z0-9_]{1,50}$'),
  cost_pence bigint NOT NULL CHECK (cost_pence BETWEEN 0 AND 1000000000),
  vat_rate_bp bigint NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, channel_account_id, service_code),
  CONSTRAINT carrier_service_costs_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
ALTER TABLE app.carrier_service_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.carrier_service_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY carrier_service_costs_tenant ON app.carrier_service_costs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- Shipments: one label (one or more parcels) for one order, or several (Ship together) ----
CREATE TABLE app.shipments (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('evri', 'dpd')),
  service_code text NOT NULL CHECK (service_code ~ '^[a-z0-9_]{1,50}$'),
  -- requested: parcels being bought; created: every parcel has its label; failed: a parcel was
  -- refused (nothing more is bought); voided: void in OmniBridge (EVRI-6).
  status text NOT NULL CHECK (status IN ('requested', 'created', 'failed', 'voided')),
  -- One request, one shipment: the order (or group and members) and a running number.
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 1000),
  group_id uuid,
  label_format text NOT NULL
    CHECK (label_format IN ('THERMAL', 'DEFAULT', 'TWO_PER_PAGE', 'LARGE_SINGLE', 'LARGE_MULTI')),
  confirm_shortened boolean NOT NULL DEFAULT false,
  tracking_number text CHECK (char_length(tracking_number) BETWEEN 1 AND 100),
  -- SHP-7: the cost table's figures when the shipment was made; null when none was set.
  cost_pence bigint CHECK (cost_pence BETWEEN 0 AND 1000000000),
  vat_rate_bp bigint CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  label_stored boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  voided_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT shipments_idempotency UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT shipments_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id),
  CONSTRAINT shipments_carrier_fk FOREIGN KEY (workspace_id, carrier_account_id)
    REFERENCES app.channel_accounts (workspace_id, id),
  CONSTRAINT shipments_group_fk FOREIGN KEY (workspace_id, group_id)
    REFERENCES app.order_groups (workspace_id, id)
);
CREATE INDEX shipments_working ON app.shipments (workspace_id, created_at)
  WHERE status = 'requested';
ALTER TABLE app.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY shipments_tenant ON app.shipments
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY shipments_scope ON app.shipments AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE DELETE ON app.shipments FROM ob_tenant_rw;

-- The orders on a shipment. `live` until the shipment is voided or fails; at most one live
-- shipment per order, so two requests can never both buy a label for it (AT-26).
CREATE TABLE app.shipment_orders (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  shipment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  company_id uuid NOT NULL,
  -- 1 for the earliest order: SHP-9's remainder pence go to the earliest first.
  position bigint NOT NULL CHECK (position BETWEEN 1 AND 20),
  cost_share_pence bigint CHECK (cost_share_pence BETWEEN 0 AND 1000000000),
  -- SHP-8: the lines this shipment carries; null for the whole order.
  line_ids uuid[],
  live boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id, shipment_id, order_id),
  CONSTRAINT shipment_orders_shipment_fk FOREIGN KEY (workspace_id, shipment_id)
    REFERENCES app.shipments (workspace_id, id),
  CONSTRAINT shipment_orders_order_fk FOREIGN KEY (workspace_id, order_id)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT shipment_orders_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
CREATE UNIQUE INDEX shipment_orders_one_live ON app.shipment_orders (workspace_id, order_id)
  WHERE live;
CREATE INDEX shipment_orders_order ON app.shipment_orders (workspace_id, order_id);
ALTER TABLE app.shipment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shipment_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY shipment_orders_tenant ON app.shipment_orders
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY shipment_orders_scope ON app.shipment_orders AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE DELETE ON app.shipment_orders FROM ob_tenant_rw;

-- One parcel bought from the carrier. The row and its client UID exist before the call, so a
-- retry can only re-read it (EVRI-3: a duplicate client UID is refused by Evri, never re-bought).
CREATE TABLE app.parcels (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  parcel_no bigint NOT NULL CHECK (parcel_no BETWEEN 1 AND 20),
  client_uid text NOT NULL CHECK (char_length(client_uid) BETWEEN 1 AND 255),
  weight_g bigint NOT NULL CHECK (weight_g BETWEEN 1 AND 1000000),
  -- pending → requesting (sent, answer not stored yet) → created | invalid | unknown; voided.
  state text NOT NULL
    CHECK (state IN ('pending', 'requesting', 'created', 'invalid', 'unknown', 'voided')),
  barcode text CHECK (char_length(barcode) BETWEEN 1 AND 100),
  -- SHIP-4: the carrier's codes and the request paths it named; never its text or a value.
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_.]{0,63}$'),
  error_fields text[] NOT NULL DEFAULT '{}',
  -- SHP-5, EVRI-6: on the reconcile list from this time until a user marks it done.
  reconcile_since timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT parcels_number UNIQUE (workspace_id, shipment_id, parcel_no),
  CONSTRAINT parcels_client_uid UNIQUE (workspace_id, carrier_account_id, client_uid),
  CONSTRAINT parcels_shipment_fk FOREIGN KEY (workspace_id, shipment_id)
    REFERENCES app.shipments (workspace_id, id),
  CONSTRAINT parcels_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id),
  CONSTRAINT parcels_carrier_fk FOREIGN KEY (workspace_id, carrier_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
CREATE INDEX parcels_reconcile ON app.parcels (workspace_id, reconcile_since)
  WHERE reconcile_since IS NOT NULL AND reconciled_at IS NULL;
ALTER TABLE app.parcels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.parcels FORCE ROW LEVEL SECURITY;
CREATE POLICY parcels_tenant ON app.parcels
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY parcels_scope ON app.parcels AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE DELETE ON app.parcels FROM ob_tenant_rw;

-- ---- SHP-2: a label request and where each of its orders stands -----------------------------
CREATE TABLE app.label_batches (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
ALTER TABLE app.label_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.label_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY label_batches_tenant ON app.label_batches
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON app.label_batches FROM ob_tenant_rw;

CREATE TABLE app.label_batch_items (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  batch_id uuid NOT NULL,
  position bigint NOT NULL CHECK (position BETWEEN 1 AND 200),
  order_id uuid NOT NULL,
  company_id uuid NOT NULL,
  shipment_id uuid,
  -- Why the order was refused before any carrier call (nothing bought).
  refusal text CHECK (refusal IN ('not_awaiting_dispatch', 'already_labelled',
                                  'address_not_confirmed', 'address_changed_after_label',
                                  'no_buyer_details', 'carrier_needs_reauth', 'unknown_service',
                                  'partial_not_allowed')),
  PRIMARY KEY (workspace_id, batch_id, position),
  CONSTRAINT label_batch_items_batch_fk FOREIGN KEY (workspace_id, batch_id)
    REFERENCES app.label_batches (workspace_id, id),
  CONSTRAINT label_batch_items_order_fk FOREIGN KEY (workspace_id, order_id)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT label_batch_items_shipment_fk FOREIGN KEY (workspace_id, shipment_id)
    REFERENCES app.shipments (workspace_id, id),
  CONSTRAINT label_batch_items_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
CREATE INDEX label_batch_items_shipment ON app.label_batch_items (workspace_id, shipment_id);
ALTER TABLE app.label_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.label_batch_items FORCE ROW LEVEL SECURITY;
CREATE POLICY label_batch_items_tenant ON app.label_batch_items
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY label_batch_items_scope ON app.label_batch_items AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE DELETE ON app.label_batch_items FROM ob_tenant_rw;

-- ---- ADR-081: the buyer's address changed after the label was printed -----------------------
ALTER TABLE app.orders ADD COLUMN address_changed_after_label boolean NOT NULL DEFAULT false;
