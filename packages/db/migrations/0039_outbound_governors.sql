-- 0039 outbound send path, switches and rate governors (T-0702: SAFE-1, SAFE-2, SAFE-3, INT-2,
-- RL-3, RL-4, RL-5; supports RL-1, RL-2, EBAY-8). Runs as ob_owner. Expand only; 0040 validates
-- the NOT VALID rules.
--
-- * app.outbound_writes: one row per automated provider write (an intent row, invariant 3). The
--   kill switch (SAFE-2) and the maintenance switch (SAFE-3) are read just before each send
--   (invariant 20); a paused write waits here at no cost and is sent when the switch is turned off.
-- * The maintenance switch is a platform setting, read by every workspace through a definer.
-- * app.bulk_confirmations: the token a bulk-write preview issues (SAFE-1), single use.
-- * app.amazon_rate_buckets: SP-API token buckets per seller and operation (RL-1, AMZ-9).
-- * app.ebay_budget_daily: eBay's app-wide daily budget per API and Pacific day (RL-2, EBAY-8),
--   reserved before every send with one guarded UPDATE (ARCHITECTURE 6.4).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- Outbound writes ----------------------------------------------------------------------------
CREATE TABLE app.outbound_writes (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('amazon', 'amazon_ads', 'ebay', 'website', 'evri',
                                             'dpd')),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'
                                 AND char_length(operation) <= 64),
  -- eBay: non-urgent writes stop at 80% of the daily budget, urgent ones at 95% (EBAY-8).
  urgent boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  -- IDs, SKUs, numbers and pii_ref values only (invariant 7a), checked by the operation's schema.
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  paused_reason text CHECK (paused_reason IN ('kill_switch', 'maintenance')),
  -- Real send attempts only: a pause or a governor's wait spends none.
  attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatch_seq bigint NOT NULL DEFAULT 0 CHECK (dispatch_seq >= 0),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_.]{0,63}$'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  sent_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT outbound_writes_once UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT outbound_writes_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
CREATE INDEX outbound_writes_open ON app.outbound_writes (workspace_id, channel_account_id, state)
  WHERE state IN ('pending', 'sending');
ALTER TABLE app.outbound_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbound_writes FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_writes_tenant ON app.outbound_writes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- The resume after maintenance lists the workspaces with writes it paused: IDs only.
CREATE POLICY outbound_writes_paused_list ON app.outbound_writes FOR SELECT TO ob_owner
  USING (current_setting('app.outbound_paused_list', true) = 'on');
REVOKE DELETE ON app.outbound_writes FROM ob_tenant_rw;

CREATE FUNCTION app.outbound_maintenance_workspaces()
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.outbound_paused_list', 'on', true);
  RETURN QUERY
    SELECT DISTINCT w.workspace_id FROM app.outbound_writes w
     WHERE w.state = 'pending' AND w.paused_reason = 'maintenance';
  PERFORM set_config('app.outbound_paused_list', '', true);
END
$$;
REVOKE ALL ON FUNCTION app.outbound_maintenance_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbound_maintenance_workspaces() TO ob_tenant_rw;

-- ---- The maintenance switch (SAFE-3) -----------------------------------------------------------
-- The wider rules go on first, so the table is never without them.
ALTER TABLE app.platform_settings ADD CONSTRAINT platform_settings_key
  CHECK (key IN ('public_signup', 'incident_banner', 'maintenance')) NOT VALID;
ALTER TABLE app.platform_settings ADD CONSTRAINT platform_settings_value CHECK (
  (key = 'public_signup' AND jsonb_typeof(value) = 'boolean')
  OR (key = 'maintenance' AND jsonb_typeof(value) = 'boolean')
  OR (key = 'incident_banner' AND jsonb_typeof(value) = 'object'
      AND jsonb_typeof(value -> 'message') = 'string'
      AND char_length(value ->> 'message') BETWEEN 1 AND 200
      AND position('@' IN value ->> 'message') = 0
      AND value ->> 'severity' IN ('info', 'warning', 'critical'))) NOT VALID;
-- Contract: the 0033 rules are the new ones minus the maintenance key, so dropping them removes
-- no guarantee.
-- waiver: replaced by platform_settings_key and platform_settings_value; T-0702
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.platform_settings DROP CONSTRAINT IF EXISTS platform_settings_key_check;
-- waiver: replaced by platform_settings_value; T-0702
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.platform_settings DROP CONSTRAINT IF EXISTS platform_settings_shape;

-- Every workspace reads it just before each provider write (invariant 20), and web shows it.
CREATE FUNCTION app.maintenance_state()
  RETURNS TABLE (maintenance boolean, since timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((SELECT s.value = 'true'::jsonb FROM app.platform_settings s
                    WHERE s.key = 'maintenance'), false),
         (SELECT s.updated_at FROM app.platform_settings s
           WHERE s.key = 'maintenance' AND s.value = 'true'::jsonb)
$$;
REVOKE ALL ON FUNCTION app.maintenance_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.maintenance_state() TO ob_tenant_rw;

-- ---- Bulk-write confirmations (SAFE-1) ---------------------------------------------------------
CREATE TABLE app.bulk_confirmations (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('stock_push', 'tracking_resend', 'ads_change')),
  -- Sorted, so the confirm runs on exactly the accounts the preview named.
  account_ids uuid[] NOT NULL CHECK (cardinality(account_ids) BETWEEN 2 AND 100),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (workspace_id, token_hash)
);
CREATE INDEX bulk_confirmations_expiry ON app.bulk_confirmations (workspace_id, expires_at);
ALTER TABLE app.bulk_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY bulk_confirmations_tenant ON app.bulk_confirmations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- Amazon token buckets (RL-1, AMZ-9) --------------------------------------------------------
-- Per seller (channel account) and operation. Rates are requests per second, so fractional; they
-- are never money. A take refills by elapsed time and spends one token in one UPDATE.
CREATE TABLE app.amazon_rate_buckets (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  channel_account_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z0-9_.]{0,63}$'),
  rate double precision NOT NULL CHECK (rate > 0),
  burst double precision NOT NULL CHECK (burst >= 1),
  tokens double precision NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, channel_account_id, operation),
  CONSTRAINT amazon_rate_buckets_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
ALTER TABLE app.amazon_rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.amazon_rate_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY amazon_rate_buckets_tenant ON app.amazon_rate_buckets
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- eBay daily budget (RL-2, EBAY-8) ----------------------------------------------------------
-- App-wide per API and US Pacific day: not tenant data, reached through the definers only.
CREATE TABLE app.ebay_budget_daily (
  api text NOT NULL CHECK (api ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  day date NOT NULL,
  calls bigint NOT NULL DEFAULT 0 CHECK (calls >= 0),
  cap bigint NOT NULL CHECK (cap > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (api, day)
);
ALTER TABLE app.ebay_budget_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ebay_budget_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY ebay_budget_daily_definer_only ON app.ebay_budget_daily TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.ebay_budget_daily FROM PUBLIC, ob_tenant_rw;

-- Reserves p_n calls of p_api today before they are sent: one guarded UPDATE, so concurrent
-- callers can never pass the limit (p_percent of cap: 80 for non-urgent work, 95 for the rest).
-- A reservation is never given back (eBay counts attempts too). The calls are added to the
-- caller's account row in api_usage_daily in the same call (RL-5), under the caller's workspace.
CREATE FUNCTION app.ebay_budget_reserve(p_account uuid, p_api text, p_day date, p_n bigint,
                                        p_cap bigint, p_percent int, p_now timestamptz)
  RETURNS TABLE (reserved boolean, calls bigint, cap bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  after bigint;
BEGIN
  IF ws IS NULL OR p_n < 1 OR p_cap < 1 OR p_percent NOT IN (80, 95) THEN
    RAISE EXCEPTION 'ebay_budget_reserve: bad arguments' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.ebay_budget_daily AS b (api, day, calls, cap, updated_at)
    VALUES (p_api, p_day, 0, p_cap, p_now)
  ON CONFLICT (api, day) DO UPDATE SET cap = excluded.cap
    WHERE b.cap <> excluded.cap;
  UPDATE app.ebay_budget_daily b SET calls = b.calls + p_n, updated_at = p_now
   WHERE b.api = p_api AND b.day = p_day AND (b.calls + p_n) * 100 <= b.cap * p_percent
  RETURNING b.calls INTO after;
  IF after IS NULL THEN
    RETURN QUERY SELECT false, b.calls, b.cap FROM app.ebay_budget_daily b
                  WHERE b.api = p_api AND b.day = p_day;
    RETURN;
  END IF;
  -- The account row of today's usage, under the caller's own workspace (RLS still applies).
  INSERT INTO app.api_usage_daily AS u (workspace_id, channel_account_id, provider, api, day,
                                       calls, cap, updated_at)
    VALUES (ws, p_account, 'ebay', p_api, p_day, p_n, p_cap, p_now)
  ON CONFLICT (workspace_id, channel_account_id, provider, api, day)
    DO UPDATE SET calls = u.calls + excluded.calls, cap = excluded.cap, updated_at = p_now;
  RETURN QUERY SELECT true, after, p_cap;
END
$$;
REVOKE ALL ON FUNCTION app.ebay_budget_reserve(uuid, text, date, bigint, bigint, int, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ebay_budget_reserve(uuid, text, date, bigint, bigint, int,
                                                  timestamptz) TO ob_tenant_rw;

-- Live usage for the console (RL-5): today's eBay budget, and usage rows since p_from with their
-- update times. IDs, API names and counts only (PLAT-3).
CREATE FUNCTION app.console_ebay_budget(p_user uuid, p_from date)
  RETURNS TABLE (api text, day date, calls bigint, cap bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  RETURN QUERY SELECT b.api, b.day, b.calls, b.cap FROM app.ebay_budget_daily b
                WHERE b.day >= p_from ORDER BY b.day DESC, b.api;
END
$$;
CREATE FUNCTION app.console_api_usage_live(p_user uuid, p_from date)
  RETURNS TABLE (workspace_id uuid, channel_account_id uuid, provider text, api text, day date,
                 calls bigint, cap bigint, updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  PERFORM set_config('app.platform_console', 'on', true);
  RETURN QUERY
    SELECT u.workspace_id, u.channel_account_id, u.provider, u.api, u.day, u.calls, u.cap,
           u.updated_at
      FROM app.api_usage_daily u
     WHERE u.day >= p_from
     ORDER BY u.updated_at DESC, u.provider, u.api
     LIMIT 5000;
  PERFORM set_config('app.platform_console', '', true);
END
$$;
REVOKE ALL ON FUNCTION app.console_ebay_budget(uuid, date), app.console_api_usage_live(uuid, date)
  FROM PUBLIC;
-- Web's auth group, as for the other console reads (each call re-checks the admin).
GRANT EXECUTE ON FUNCTION app.console_ebay_budget(uuid, date), app.console_api_usage_live(uuid, date)
  TO ob_auth;
