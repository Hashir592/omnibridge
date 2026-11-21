-- 0037 integration framework (T-0701: INT-1, INT-3, INT-4, INT-6, INT-8; AMZ-12, EBAY-5). Runs as
-- ob_owner. Expand only; 0038 validates the two NOT VALID rules.
--
-- * Carrier accounts (Evri, DPD) are channel accounts too: the Connections page lists them, their
--   tokens and usage rows name them (0002, 0033), and RL-4 caps them per account.
-- * Connection health on each account (INT-4): last good call, last token refresh, auth failures
--   (AMZ-12: 3 in 1 hour), Needs re-authorisation, the last error code, and the kill switch state
--   (SAFE-2; T-0702 enforces it).
-- * Origin tags (INT-6): the helper every provider-sourced table from M08 on calls.
-- * Sync cursors per account and stream (INT-8).
-- * OAuth states: single use, 10 minutes, stored as a hash (INT-2's one web provider call).
-- * Credentials: which provider environment a token belongs to (INT-3), and the account foreign
--   key promised in 0002.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- Channel accounts: carriers, health and the kill switch ----------------------------------
-- The wider rule goes on first, so the table is never without one.
ALTER TABLE app.channel_accounts ADD CONSTRAINT channel_accounts_provider
  CHECK (provider IN ('amazon', 'amazon_ads', 'ebay', 'website', 'evri', 'dpd')) NOT VALID;
-- Contract: the 0007 rule is the new one minus evri and dpd, so dropping it removes no guarantee.
-- waiver: replaced by channel_accounts_provider; T-0701
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.channel_accounts DROP CONSTRAINT IF EXISTS channel_accounts_provider_check;

ALTER TABLE app.channel_accounts
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN last_token_refresh_at timestamptz,
  -- Consecutive auth failures (INT-4), and the times of the last three (AMZ-12: 3 within any
  -- hour mark Needs re-authorisation); a successful call clears both.
  ADD COLUMN auth_failures bigint NOT NULL DEFAULT 0,
  ADD COLUMN auth_failure_times timestamptz[] NOT NULL DEFAULT '{}',
  ADD COLUMN needs_reauth_at timestamptz,
  -- A stable code only (e.g. provider.server_error), never a provider message or a value.
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_at timestamptz,
  -- SAFE-2: set while the account's automated writes are paused. Who paused it is in the audit log.
  ADD COLUMN paused_at timestamptz;
ALTER TABLE app.channel_accounts ADD CONSTRAINT channel_accounts_health
  CHECK (auth_failures >= 0 AND cardinality(auth_failure_times) <= 3
         AND (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.]{0,63}$')) NOT VALID;

-- ---- Origin tags (INT-6) -----------------------------------------------------------------------
-- The shared helper: a migration that creates a provider-sourced table calls
--   CALL app.add_origin_columns('app.<table>');
-- right after CREATE TABLE (the table must be new, so empty, and have workspace_id). It adds the
-- origin tag (the list is @omnibridge/core ORIGIN_TAGS), the account (required unless the row was
-- entered by hand), the composite foreign key and an index, so every row from one source can be
-- found and deleted (INT-6, AMZ-13). Column rules, not a domain, so a later change to the list is
-- an ordinary NOT VALID swap per table.
CREATE PROCEDURE app.add_origin_columns(p_table regclass)
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  short text := (SELECT c.relname FROM pg_class c WHERE c.oid = p_table);
BEGIN
  EXECUTE format('ALTER TABLE %s ADD COLUMN origin text NOT NULL, '
                 'ADD COLUMN channel_account_id uuid', p_table);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (origin IN (%L, %L, %L, %L, %L, %L, %L))',
                 p_table, short || '_origin', 'amazon', 'amazon_ads', 'ebay', 'website', 'evri',
                 'dpd', 'manual');
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (channel_account_id IS NOT NULL '
                 'OR origin = ''manual'')', p_table, short || '_origin_account');
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (workspace_id, channel_account_id) '
                 'REFERENCES app.channel_accounts (workspace_id, id)', p_table,
                 short || '_account_fk');
  EXECUTE format('CREATE INDEX %I ON %s (workspace_id, channel_account_id)',
                 short || '_by_account', p_table);
END
$$;
REVOKE ALL ON PROCEDURE app.add_origin_columns(regclass) FROM PUBLIC;

-- ---- Sync cursors (INT-8) ----------------------------------------------------------------------
-- "Updated since" per account and stream. A poll reads from cursor_at minus 5 minutes; `overlap`
-- holds the external IDs (with their updated_at) already handled inside that window, so a re-poll
-- handles each change once. External IDs only: order and listing ids, never buyer data.
CREATE TABLE app.sync_cursors (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  channel_account_id uuid NOT NULL,
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'
                              AND char_length(stream) <= 64),
  cursor_at timestamptz,
  overlap jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(overlap) = 'array'
                                             AND jsonb_array_length(overlap) <= 10000),
  -- A run that stopped at its page cap goes on from here next time: { since, page, maxAt }. The
  -- cursor moves on only once every page has been read, so no change is skipped.
  resume jsonb CHECK (resume IS NULL OR jsonb_typeof(resume) = 'object'),
  last_run_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, channel_account_id, stream),
  CONSTRAINT sync_cursors_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
ALTER TABLE app.sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sync_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_cursors_tenant ON app.sync_cursors
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- OAuth states (INT-2) ----------------------------------------------------------------------
-- The state is `<workspace id>.<32 random bytes>`; only its SHA-256 is kept. The public callback
-- opens that workspace's transaction and takes the row once, before it expires.
CREATE TABLE app.oauth_states (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  state_hash bytea NOT NULL CHECK (octet_length(state_hash) = 32),
  channel_account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('amazon', 'amazon_ads', 'ebay')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (workspace_id, state_hash),
  CONSTRAINT oauth_states_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
CREATE INDEX oauth_states_expiry ON app.oauth_states (workspace_id, expires_at);
ALTER TABLE app.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY oauth_states_tenant ON app.oauth_states
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---- Credentials (INT-3) -----------------------------------------------------------------------
-- A token is usable only in the provider environment it was issued in: dev and CI (mock), staging
-- (sandbox) or production (live). A restored or copied database cannot send one to the wrong place.
ALTER TABLE app.credentials ADD COLUMN environment text NOT NULL DEFAULT 'mock';
ALTER TABLE app.credentials ADD CONSTRAINT credentials_environment
  CHECK (environment IN ('mock', 'sandbox', 'live')) NOT VALID;
ALTER TABLE app.credentials ADD CONSTRAINT credentials_account_fk
  FOREIGN KEY (workspace_id, channel_account_id)
  REFERENCES app.channel_accounts (workspace_id, id) NOT VALID;
