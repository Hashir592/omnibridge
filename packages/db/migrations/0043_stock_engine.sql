-- 0043 stock engine (T-0901: INV-1 to INV-10, AT-4, AT-27; supports CAT-3, CAT-5, CAT-6, SAFE-2).
-- Runs as ob_owner. Expand only; 0044 validates the NOT VALID rules on app.listings.
--
-- All of it is workspace-shared (ARCHITECTURE 6.1, ADR-078 3):
-- * app.stock_levels: one row per plain Master SKU, on hand and reserved (INV-1). Changed only
--   by the engine, under a row lock, together with the movement that explains it (ADR-078 5).
-- * app.stock_movements: the append-only change log (INV-3, INV-5). Its unique key (source kind,
--   source id, kind) makes a repeated event a no-op (FA-10). Kept 3 years.
-- * app.listing_writes: which outbound write carried which listing's quantity (INV-4, INV-8).
-- * app.movement_pushes: the writes queued because of a movement, for the change log (INV-5).
-- * app.channel_stock_settings: the safety buffer per sales account (INV-2, default 0).
-- * app.stock_reconciliations: what the nightly check found and corrected (INV-7).
-- * app.listings gains the per-listing stock fields: mode and manual allocation (INV-10, C7),
--   its own buffer, the last quantity queued and sent, the sync-failed and drift state.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- Stock levels (INV-1) ----------------------------------------------------------------------
CREATE TABLE app.stock_levels (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  master_sku_id uuid NOT NULL,
  on_hand bigint NOT NULL DEFAULT 0,
  -- Units in orders not yet dispatched or cancelled; never below 0.
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  -- Bumped by every movement and every allocation change: the C7.2 save checks it.
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_movement_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, master_sku_id),
  CONSTRAINT stock_levels_sku_fk FOREIGN KEY (workspace_id, master_sku_id)
    REFERENCES app.master_skus (workspace_id, id)
);
ALTER TABLE app.stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stock_levels FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_levels_tenant ON app.stock_levels
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE DELETE ON app.stock_levels FROM ob_tenant_rw;

-- ---- Movements (INV-3, INV-5) ------------------------------------------------------------------
CREATE TABLE app.stock_movements (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  -- Always a plain SKU: a bundle's movement lands on its component (CAT-3).
  master_sku_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reserve', 'release', 'dispatch', 'return', 'stock_in',
                                     'adjust', 'stock_take', 'allocation')),
  -- order_line: M10 and M12 events; user: stock-in and adjustments (the form's client_ref);
  -- stock_take: one import row; allocation: one manual-allocation change (C7.2).
  source_kind text NOT NULL CHECK (source_kind IN ('order_line', 'refund_line', 'user',
                                                   'stock_take', 'allocation')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
  on_hand_change bigint NOT NULL,
  reserved_change bigint NOT NULL,
  on_hand_after bigint NOT NULL,
  reserved_after bigint NOT NULL,
  reason text CHECK (reason IN ('damaged', 'count_correction', 'lost', 'other')),
  note text CHECK (char_length(note) <= 500),
  supplier text CHECK (char_length(supplier) <= 200),
  actor_user_id uuid,
  listing_id uuid,
  -- The company of the order a movement names, so the change log shows its reference only to a
  -- user who can see that company (ARCHITECTURE 6.1). No order data is copied here.
  company_id uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT stock_movements_once UNIQUE (workspace_id, source_kind, source_id, kind),
  CONSTRAINT stock_movements_sku_fk FOREIGN KEY (workspace_id, master_sku_id)
    REFERENCES app.master_skus (workspace_id, id),
  CONSTRAINT stock_movements_listing_fk FOREIGN KEY (workspace_id, listing_id)
    REFERENCES app.listings (workspace_id, id)
);
CREATE INDEX stock_movements_by_sku ON app.stock_movements (workspace_id, master_sku_id, created_at);
CREATE INDEX stock_movements_by_time ON app.stock_movements (workspace_id, created_at);
ALTER TABLE app.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_tenant ON app.stock_movements
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Nobody edits or deletes a movement (ADR-078 5). Not SECURITY DEFINER: current_user is the
-- caller, which is ob_owner only inside the purge function below.
CREATE FUNCTION app.stock_movements_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'ob_owner'
     AND current_setting('app.stock_purge', true) = 'on'
     AND OLD.created_at < now() - interval '3 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'app.stock_movements is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'OBS01';
END
$$;
REVOKE ALL ON FUNCTION app.stock_movements_append_only() FROM PUBLIC;
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON app.stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.stock_movements_append_only();
CREATE TRIGGER stock_movements_no_truncate
  BEFORE TRUNCATE ON app.stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION app.stock_movements_append_only();

-- ---- Writes per listing and per movement (INV-4, INV-5, INV-8) ---------------------------------
CREATE TABLE app.listing_writes (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  outbound_write_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, outbound_write_id),
  CONSTRAINT listing_writes_write_fk FOREIGN KEY (workspace_id, outbound_write_id)
    REFERENCES app.outbound_writes (workspace_id, id),
  CONSTRAINT listing_writes_listing_fk FOREIGN KEY (workspace_id, listing_id)
    REFERENCES app.listings (workspace_id, id)
);
CREATE INDEX listing_writes_by_listing ON app.listing_writes (workspace_id, listing_id, created_at);
ALTER TABLE app.listing_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listing_writes FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_writes_tenant ON app.listing_writes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE TABLE app.movement_pushes (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  movement_id uuid NOT NULL,
  outbound_write_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, movement_id, outbound_write_id),
  CONSTRAINT movement_pushes_movement_fk FOREIGN KEY (workspace_id, movement_id)
    REFERENCES app.stock_movements (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT movement_pushes_write_fk FOREIGN KEY (workspace_id, outbound_write_id)
    REFERENCES app.outbound_writes (workspace_id, id)
);
ALTER TABLE app.movement_pushes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.movement_pushes FORCE ROW LEVEL SECURITY;
CREATE POLICY movement_pushes_tenant ON app.movement_pushes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- Buffers (INV-2) ---------------------------------------------------------------------------
-- Workspace-shared, not a channel_accounts column: a child user's save recomputes targets for
-- every listing of the SKU, including accounts of companies they cannot see.
CREATE TABLE app.channel_stock_settings (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  channel_account_id uuid NOT NULL,
  buffer bigint NOT NULL DEFAULT 0 CHECK (buffer BETWEEN 0 AND 10000000),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, channel_account_id),
  CONSTRAINT channel_stock_settings_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
ALTER TABLE app.channel_stock_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_stock_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_stock_settings_tenant ON app.channel_stock_settings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- Reconciliation (INV-7) --------------------------------------------------------------------
CREATE TABLE app.stock_reconciliations (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  channel_qty bigint NOT NULL,
  target bigint NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT stock_reconciliations_listing_fk FOREIGN KEY (workspace_id, listing_id)
    REFERENCES app.listings (workspace_id, id),
  CONSTRAINT stock_reconciliations_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
CREATE INDEX stock_reconciliations_by_time ON app.stock_reconciliations (workspace_id, created_at);
ALTER TABLE app.stock_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stock_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_reconciliations_tenant ON app.stock_reconciliations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- Listing stock fields (INV-2, INV-4, INV-7, INV-8, INV-10) ---------------------------------
ALTER TABLE app.listings
  ADD COLUMN stock_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN manual_qty bigint,
  ADD COLUMN manual_sold bigint NOT NULL DEFAULT 0,
  ADD COLUMN manual_set_at timestamptz,
  ADD COLUMN manual_set_by uuid,
  ADD COLUMN buffer_override bigint,
  -- The quantity of the newest write queued (or what the channel is taken to show after its
  -- own sale): a new write is queued only when the target differs from it (INV-4, C7.1).
  ADD COLUMN last_queued_qty bigint,
  ADD COLUMN last_sent_qty bigint,
  ADD COLUMN pending_write_id uuid,
  ADD COLUMN push_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN sync_failed_at timestamptz,
  ADD COLUMN drift_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN last_order_at timestamptz;
ALTER TABLE app.listings ADD CONSTRAINT listings_stock CHECK (
  stock_mode IN ('auto', 'manual')
  AND (stock_mode = 'auto') = (manual_qty IS NULL)
  AND manual_qty >= 0 AND manual_sold >= 0 AND buffer_override >= 0
  AND last_queued_qty >= 0 AND last_sent_qty >= 0 AND push_seq >= 0 AND drift_count >= 0)
  NOT VALID;

-- ---- Retention (INV-5: 3 years) ----------------------------------------------------------------
-- The only deletion path: the current workspace's movements older than 3 years. Run by the
-- stock.retention job in its tenant transaction; the cut-off is fixed here, never a parameter.
CREATE FUNCTION app.purge_stock_movements() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  workspace uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  deleted bigint;
BEGIN
  IF workspace IS NULL THEN
    RAISE EXCEPTION 'purge_stock_movements needs app.workspace_id' USING ERRCODE = 'OBS01';
  END IF;
  PERFORM set_config('app.stock_purge', 'on', true);
  DELETE FROM app.stock_movements m
   WHERE m.workspace_id = workspace AND m.created_at < now() - interval '3 years';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('app.stock_purge', '', true);
  RETURN deleted;
END
$$;
REVOKE ALL ON FUNCTION app.purge_stock_movements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_stock_movements() TO ob_tenant_rw;
