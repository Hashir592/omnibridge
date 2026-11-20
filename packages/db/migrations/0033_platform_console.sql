-- 0033 platform console (T-0504: PLAT-1, PLAT-2, PLAT-3, OPS-6; ADR-071 4a). Runs as ob_owner.
-- Expand only: new columns with defaults, new tables and functions, and same-signature bodies.
--
-- The console reaches tenant tables only through the definer functions below. Each takes the
-- caller's user id and answers only for a platform admin with MFA confirmed (PLAT-1), checked here
-- again on every call. They return IDs, names of workspaces, statuses, dates and counts, never a
-- tenant's orders, customers, finance or messages (PLAT-3). Cross-workspace reads open owner-only
-- SELECT policies with the local setting app.platform_console, for the length of one query.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- Workspace status (PLAT-2) ----------------------------------------------------------------
-- Archive is final (S1, 20 Nov 2026): active <-> suspended, and either -> archived, never back.
ALTER TABLE app.workspaces
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  ADD COLUMN status_changed_at timestamptz;

-- ---- Cross-workspace reads for the console definers (owner only, one query at a time) ---------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces', 'memberships', 'channel_accounts', 'job_records',
                           'credentials', 'deletion_runs']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO ob_owner '
      'USING (current_setting(''app.platform_console'', true) = ''on'')',
      t || '_platform_console', t);
  END LOOP;
END
$$;

-- A platform admin who has confirmed MFA (PLAT-1). app.users and app.user_auth are read the way the
-- auth definers read them: one user, named in a local setting.
CREATE FUNCTION app.console_admin(p_user uuid)
  RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.auth_user_id', true);
  ok boolean;
BEGIN
  PERFORM set_config('app.auth_user_id', coalesce(p_user::text, ''), true);
  SELECT coalesce((SELECT u.platform_admin AND a.mfa_confirmed_at IS NOT NULL
                     FROM app.users u
                     JOIN app.user_auth a ON a.user_id = u.id
                    WHERE u.id = p_user), false)
    INTO ok;
  PERFORM set_config('app.auth_user_id', coalesce(previous, ''), true);
  RETURN ok;
END
$$;
REVOKE ALL ON FUNCTION app.console_admin(uuid) FROM PUBLIC;

CREATE FUNCTION app.console_require(p_user uuid) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT app.console_admin(p_user) THEN
    RAISE EXCEPTION 'platform admin with MFA required' USING ERRCODE = '42501';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.console_require(uuid) FROM PUBLIC;

-- Every workspace with its status and counts only (PLAT-2, PLAT-3).
CREATE FUNCTION app.console_workspaces(p_user uuid)
  RETURNS TABLE (id uuid, name text, status text, status_changed_at timestamptz,
                 created_at timestamptz, modules jsonb, users bigint, channel_accounts bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  PERFORM set_config('app.platform_console', 'on', true);
  RETURN QUERY
    SELECT w.id, w.name, w.status, w.status_changed_at, w.created_at, w.modules,
           (SELECT count(*) FROM app.memberships m WHERE m.workspace_id = w.id),
           (SELECT count(*) FROM app.channel_accounts c
             WHERE c.workspace_id = w.id AND c.archived_at IS NULL)
      FROM app.workspaces w
     ORDER BY w.created_at, w.id;
  PERFORM set_config('app.platform_console', '', true);
END
$$;

-- Moves a workspace to `p_to` (PLAT-2). Allowed: active -> suspended, suspended -> active, active
-- or suspended -> archived. Suspending or archiving revokes every session in the workspace at once,
-- and the picker and session_advance refuse it from then on. Returns the outcome and the status
-- before: 'ok', 'not_found' or 'conflict' (a move not allowed, e.g. anything from archived).
CREATE FUNCTION app.console_workspace_status(p_user uuid, p_workspace uuid, p_to text,
                                             p_now timestamptz)
  RETURNS TABLE (outcome text, previous text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  outer_workspace text := current_setting('app.workspace_id', true);
  was text;
BEGIN
  PERFORM app.console_require(p_user);
  IF p_to NOT IN ('active', 'suspended', 'archived') THEN
    RAISE EXCEPTION 'unknown workspace status %', p_to USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.workspace_id', p_workspace::text, true);
  SELECT w.status INTO was FROM app.workspaces w WHERE w.id = p_workspace FOR UPDATE;
  IF was IS NULL THEN
    PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  IF NOT ((was = 'active' AND p_to IN ('suspended', 'archived'))
          OR (was = 'suspended' AND p_to IN ('active', 'archived'))) THEN
    PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
    RETURN QUERY SELECT 'conflict'::text, was;
    RETURN;
  END IF;
  UPDATE app.workspaces w SET status = p_to, status_changed_at = p_now WHERE w.id = p_workspace;
  IF p_to <> 'active' THEN
    UPDATE app.sessions s SET revoked_at = p_now
     WHERE s.active_workspace = p_workspace AND s.revoked_at IS NULL;
    -- Nobody joins a suspended or archived workspace: its open invites end too.
    UPDATE app.invites i SET revoked_at = p_now
     WHERE i.workspace_id = p_workspace AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
  END IF;
  PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
  RETURN QUERY SELECT 'ok'::text, was;
END
$$;

-- A module toggle from the console (PLAT-2, T-0211); 'not_found' or 'archived' when it cannot.
CREATE FUNCTION app.console_set_module(p_user uuid, p_workspace uuid, p_module text, p_on boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  outer_workspace text := current_setting('app.workspace_id', true);
  was text;
BEGIN
  PERFORM app.console_require(p_user);
  PERFORM set_config('app.workspace_id', p_workspace::text, true);
  SELECT w.status INTO was FROM app.workspaces w WHERE w.id = p_workspace FOR UPDATE;
  PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
  IF was IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF was = 'archived' THEN
    RETURN 'archived';
  END IF;
  PERFORM app.workspace_set_module(p_workspace, p_module, p_on);
  RETURN 'ok';
END
$$;

-- ---- Platform settings: flags and the incident banner (PLAT-2, TEN-8) --------------------------
CREATE TABLE app.platform_settings (
  key text NOT NULL PRIMARY KEY CHECK (key IN ('public_signup', 'incident_banner')),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL REFERENCES app.users (id),
  CONSTRAINT platform_settings_shape CHECK (
    (key = 'public_signup' AND jsonb_typeof(value) = 'boolean')
    OR (key = 'incident_banner' AND jsonb_typeof(value) = 'object'
        AND jsonb_typeof(value -> 'message') = 'string'
        AND char_length(value ->> 'message') BETWEEN 1 AND 200
        -- Operator text shown to every user: no email address (no buyer or staff contact).
        AND position('@' IN value ->> 'message') = 0
        AND value ->> 'severity' IN ('info', 'warning', 'critical')))
);
ALTER TABLE app.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_settings_definer_only ON app.platform_settings TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.platform_settings FROM PUBLIC, ob_tenant_rw;

CREATE FUNCTION app.console_settings(p_user uuid)
  RETURNS TABLE (key text, value jsonb, updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  RETURN QUERY SELECT s.key, s.value, s.updated_at FROM app.platform_settings s ORDER BY s.key;
END
$$;

-- Sets (p_value not null) or clears (null) one setting.
CREATE FUNCTION app.console_set_setting(p_user uuid, p_key text, p_value jsonb, p_now timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  IF p_value IS NULL THEN
    DELETE FROM app.platform_settings s WHERE s.key = p_key;
  ELSE
    INSERT INTO app.platform_settings (key, value, updated_at, updated_by)
      VALUES (p_key, p_value, p_now, p_user)
    ON CONFLICT (key) DO UPDATE
      SET value = excluded.value, updated_at = excluded.updated_at,
          updated_by = excluded.updated_by;
  END IF;
END
$$;

-- The incident banner every signed-in user sees (PLAT-2), or no row.
CREATE FUNCTION app.incident_banner()
  RETURNS TABLE (message text, severity text, set_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.value ->> 'message', s.value ->> 'severity', s.updated_at
    FROM app.platform_settings s WHERE s.key = 'incident_banner'
$$;

-- ---- Platform audit (PLAT-2): console actions, with no workspace of their own -----------------
-- IDs, names of flags, modules and secrets, and counts only; never a value of a secret.
CREATE TABLE app.platform_audit_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users (id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'
                              AND char_length(action) <= 64),
  -- The workspace the action was about, if any: a target, not tenant data (no RLS by workspace).
  target_workspace_id uuid,
  params jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  ip inet
);
CREATE INDEX platform_audit_events_recent ON app.platform_audit_events (occurred_at DESC, id DESC);
ALTER TABLE app.platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_events_definer_only ON app.platform_audit_events TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.platform_audit_events FROM PUBLIC, ob_tenant_rw;

CREATE FUNCTION app.console_audit(p_user uuid, p_action text, p_workspace uuid, p_params jsonb,
                                  p_ip inet, p_now timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  INSERT INTO app.platform_audit_events (occurred_at, user_id, action, target_workspace_id,
                                         params, ip)
    VALUES (p_now, p_user, p_action, p_workspace, coalesce(p_params, '{}'::jsonb), p_ip);
END
$$;

-- ---- API usage (PLAT-2): the one usage table; M07's eBay governor reserves against it ---------
-- `day` is the provider's own day (US/Pacific for eBay, UTC for the rest), worked out by the
-- caller (core providerDay). T-0703 reserves with one atomic
-- UPDATE ... SET calls = calls + n WHERE calls + n <= cap.
CREATE TABLE app.api_usage_daily (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  channel_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('amazon', 'amazon_ads', 'ebay', 'website', 'evri',
                                             'dpd')),
  api text NOT NULL CHECK (api ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  day date NOT NULL,
  calls bigint NOT NULL DEFAULT 0 CHECK (calls >= 0),
  cap bigint CHECK (cap >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, channel_account_id, provider, api, day),
  CONSTRAINT api_usage_daily_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
ALTER TABLE app.api_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.api_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY api_usage_daily_tenant ON app.api_usage_daily
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY api_usage_daily_platform_console ON app.api_usage_daily FOR SELECT TO ob_owner
  USING (current_setting('app.platform_console', true) = 'on');
REVOKE ALL ON app.api_usage_daily FROM PUBLIC;
GRANT SELECT, INSERT ON app.api_usage_daily TO ob_tenant_rw;
GRANT UPDATE (calls, cap, updated_at) ON app.api_usage_daily TO ob_tenant_rw;

CREATE FUNCTION app.console_api_usage(p_user uuid, p_from date, p_to date)
  RETURNS TABLE (workspace_id uuid, channel_account_id uuid, provider text, api text, day date,
                 calls bigint, cap bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  PERFORM set_config('app.platform_console', 'on', true);
  RETURN QUERY
    SELECT u.workspace_id, u.channel_account_id, u.provider, u.api, u.day, u.calls, u.cap
      FROM app.api_usage_daily u
     WHERE u.day BETWEEN p_from AND p_to
     ORDER BY u.day DESC, u.provider, u.api, u.workspace_id, u.channel_account_id
     LIMIT 5000;
  PERFORM set_config('app.platform_console', '', true);
END
$$;

-- The credential-expiry calendar (PLAT-2): active credentials expiring before p_until. IDs, kind,
-- slot and date only; never the value.
CREATE FUNCTION app.console_credential_expiry(p_user uuid, p_until timestamptz)
  RETURNS TABLE (workspace_id uuid, channel_account_id uuid, kind text, slot text,
                 expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  PERFORM set_config('app.platform_console', 'on', true);
  RETURN QUERY
    SELECT c.workspace_id, c.channel_account_id, c.kind, c.slot, c.expires_at
      FROM app.credentials c
     WHERE c.is_active AND c.expires_at IS NOT NULL AND c.expires_at <= p_until
     ORDER BY c.expires_at, c.workspace_id, c.kind
     LIMIT 5000;
  PERFORM set_config('app.platform_console', '', true);
END
$$;

-- The job records behind dead-lettered jobs (PLAT-2): state, attempt and error code by
-- (workspace, type, idempotency key). p_keys is a JSON array of {"w","t","k"}.
CREATE FUNCTION app.console_job_records(p_user uuid, p_keys jsonb)
  RETURNS TABLE (workspace_id uuid, type text, idempotency_key text, state text, attempt bigint,
                 error_code text, updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  IF jsonb_typeof(p_keys) <> 'array' OR jsonb_array_length(p_keys) > 500 THEN
    RAISE EXCEPTION 'p_keys must be an array of at most 500 keys' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.platform_console', 'on', true);
  RETURN QUERY
    SELECT r.workspace_id, r.type, r.idempotency_key, r.state, r.attempt, r.error_code,
           r.updated_at
      FROM jsonb_to_recordset(p_keys) AS k (w uuid, t text, k text)
      JOIN app.job_records r
        ON r.workspace_id = k.w AND r.type = k.t AND r.idempotency_key = k.k;
  PERFORM set_config('app.platform_console', '', true);
END
$$;

-- ---- Notification retention (ADR-071 4a): resolved more than 90 days ago, hard-deleted --------
-- Read and email rows go with them (ON DELETE CASCADE); open ones are kept. The workspace one runs
-- in the worker's tenant transaction (app.workspace_id set); the platform one has no workspace.
CREATE FUNCTION app.notification_purge_resolved(p_cutoff timestamptz)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  n bigint;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  DELETE FROM app.notifications x
   WHERE x.workspace_id = ws AND x.resolved_at IS NOT NULL AND x.resolved_at < p_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION app.platform_notice_purge_resolved(p_cutoff timestamptz)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM app.platform_notifications x
   WHERE x.resolved_at IS NOT NULL AND x.resolved_at < p_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ---- Daily health digest (OPS-6): counts only, once per platform admin per day ---------------
CREATE TABLE app.platform_digests (
  day date NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (day, user_id)
);
ALTER TABLE app.platform_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_digests FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_digests_definer_only ON app.platform_digests TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.platform_digests FROM PUBLIC, ob_tenant_rw;

-- Counts over the last day (p_since onward) and credentials expiring before p_until.
CREATE FUNCTION app.platform_digest_counts(p_since timestamptz, p_until timestamptz)
  RETURNS TABLE (jobs_failed bigint, api_calls bigint, api_capped_calls bigint, api_cap bigint,
                 credentials_expiring bigint, deletion_runs bigint, records_deleted bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.platform_console', 'on', true);
  RETURN QUERY SELECT
    (SELECT count(*) FROM app.job_records r WHERE r.state = 'failed' AND r.updated_at >= p_since),
    -- Usage of the current day only (each provider's own day, so at most today's rows).
    (SELECT coalesce(sum(u.calls), 0)::bigint FROM app.api_usage_daily u
      WHERE u.day = ((p_since + interval '1 day') AT TIME ZONE 'UTC')::date),
    (SELECT coalesce(sum(u.calls), 0)::bigint FROM app.api_usage_daily u
      WHERE u.day = ((p_since + interval '1 day') AT TIME ZONE 'UTC')::date
        AND u.cap IS NOT NULL),
    (SELECT coalesce(sum(u.cap), 0)::bigint FROM app.api_usage_daily u
      WHERE u.day = ((p_since + interval '1 day') AT TIME ZONE 'UTC')::date
        AND u.cap IS NOT NULL),
    (SELECT count(*) FROM app.credentials c
      WHERE c.is_active AND c.expires_at IS NOT NULL AND c.expires_at <= p_until),
    (SELECT count(*) FROM app.deletion_runs d WHERE d.finished_at >= p_since),
    (SELECT coalesce(sum(d.records_deleted), 0)::bigint FROM app.deletion_runs d
      WHERE d.finished_at >= p_since);
  PERFORM set_config('app.platform_console', '', true);
END
$$;

-- Platform admins not yet sent the digest of p_day: id, address and name (the 0031 policy).
CREATE FUNCTION app.platform_digest_recipients(p_day date)
  RETURNS TABLE (user_id uuid, email text, name text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.platform_notice_mail', 'on', true);
  RETURN QUERY
    SELECT u.id, u.email, u.name
      FROM app.users u
     WHERE u.platform_admin
       AND NOT EXISTS (SELECT 1 FROM app.platform_digests d
                        WHERE d.day = p_day AND d.user_id = u.id)
     ORDER BY u.id;
  PERFORM set_config('app.platform_notice_mail', '', true);
END
$$;

CREATE FUNCTION app.platform_digest_sent(p_day date, p_user uuid, p_now timestamptz)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.platform_digests (day, user_id, sent_at) VALUES (p_day, p_user, p_now)
  ON CONFLICT DO NOTHING
$$;

-- ---- Workspace closure (DEL-1, PLAT-2) -------------------------------------------------------
-- PERM-7 keeps an admin in every live workspace; an archived one is closing, so its last admin
-- may go with everyone else.
CREATE OR REPLACE FUNCTION app.memberships_keep_an_admin() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.role <> 'admin' OR (TG_OP = 'UPDATE' AND NEW.role = 'admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  PERFORM 1 FROM app.workspaces w WHERE w.id = OLD.workspace_id FOR UPDATE;
  -- Only the closure of an archived workspace may remove its last admin: the local setting alone
  -- is not enough, so a caller who sets it on a live workspace still meets PERM-7.
  IF TG_OP = 'DELETE' AND current_setting('app.closing_workspace', true) = OLD.workspace_id::text
     AND EXISTS (SELECT 1 FROM app.workspaces w
                  WHERE w.id = OLD.workspace_id AND w.status = 'archived') THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.memberships m
                  WHERE m.workspace_id = OLD.workspace_id AND m.role = 'admin'
                    AND m.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'the last admin of a workspace cannot be removed or demoted'
      USING ERRCODE = 'OBA01';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

-- Removes every membership of the current workspace (app.workspace_id), which must be archived,
-- and returns the people removed. Ticks, read and email rows cascade. The worker's
-- workspace.close job then deletes the terms of those left with no workspace (ADR-058b).
CREATE FUNCTION app.workspace_close_members()
  RETURNS SETOF uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'app.workspace_id is not set' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.workspaces w WHERE w.id = ws AND w.status = 'archived') THEN
    RAISE EXCEPTION 'only an archived workspace is closed' USING ERRCODE = 'OBA03';
  END IF;
  PERFORM set_config('app.closing_workspace', ws::text, true);
  RETURN QUERY
    WITH gone AS (DELETE FROM app.memberships m WHERE m.workspace_id = ws RETURNING m.user_id)
    SELECT gone.user_id FROM gone;
  PERFORM set_config('app.closing_workspace', '', true);
END
$$;

-- ADR-058b for a closure: deletes the person's terms acceptances when they belong to no
-- workspace any more, and returns how many; NULL (nothing done) while they still belong to one.
-- Unlike user_terms_delete it never raises, so one closure transaction can run it for everyone.
CREATE FUNCTION app.user_terms_delete_if_unattached(p_user uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  attached boolean;
BEGIN
  PERFORM set_config('app.auth_user_id', p_user::text, true);
  SELECT EXISTS (SELECT 1 FROM app.memberships m WHERE m.user_id = p_user) INTO attached;
  PERFORM set_config('app.auth_user_id', '', true);
  IF attached THEN
    RETURN NULL;
  END IF;
  RETURN app.user_terms_delete(p_user);
END
$$;

-- ---- Sign-in refuses a workspace that is not active (PLAT-2) ---------------------------------
-- Same signatures and bodies as 0013 and 0019, plus the status check.
CREATE OR REPLACE FUNCTION app.auth_user_workspaces_modules(p_user uuid)
  RETURNS TABLE (id uuid, name text, role text, companies bigint, modules jsonb)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  m record;
  outer_workspace text := current_setting('app.workspace_id', true);
BEGIN
  PERFORM set_config('app.auth_user_id', p_user::text, true);
  FOR m IN SELECT mm.workspace_id, mm.role FROM app.memberships mm
            WHERE mm.user_id = p_user ORDER BY mm.created_at, mm.workspace_id
  LOOP
    PERFORM set_config('app.workspace_id', m.workspace_id::text, true);
    RETURN QUERY
      SELECT w.id, w.name, m.role,
             (SELECT count(*) FROM app.companies c WHERE c.workspace_id = w.id),
             w.modules
        FROM app.workspaces w WHERE w.id = m.workspace_id AND w.status = 'active';
  END LOOP;
  PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
  PERFORM set_config('app.auth_user_id', '', true);
END
$$;

CREATE OR REPLACE FUNCTION app.session_advance(p_id uuid, p_token bytea, p_csrf bytea,
                                               p_stage text, p_workspace uuid,
                                               p_now timestamptz, p_signed_in boolean,
                                               p_expires timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  owner uuid;
  current_stage text;
  allowed boolean;
  ok boolean;
  outer_workspace text := current_setting('app.workspace_id', true);
BEGIN
  SELECT s.user_id, s.stage INTO owner, current_stage FROM app.sessions s
   WHERE s.id = p_id AND s.revoked_at IS NULL FOR UPDATE;
  IF owner IS NULL THEN
    RETURN false;
  END IF;
  allowed := CASE
    WHEN current_stage = 'pre_mfa' THEN
      p_signed_in AND p_stage IN ('signed_in', 'password_change', 'workspace')
    WHEN current_stage IN ('signed_in', 'workspace', 'platform') THEN
      NOT p_signed_in AND p_stage IN ('workspace', 'platform')
    ELSE false
  END;
  IF NOT allowed THEN
    RETURN false;
  END IF;
  IF (p_stage = 'workspace') <> (p_workspace IS NOT NULL) THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.auth_user_id', owner::text, true);
  IF p_stage = 'workspace' THEN
    SELECT EXISTS (SELECT 1 FROM app.memberships m
                    WHERE m.user_id = owner AND m.workspace_id = p_workspace) INTO ok;
    IF ok THEN
      -- A suspended or archived workspace cannot be entered (PLAT-2).
      PERFORM set_config('app.workspace_id', p_workspace::text, true);
      SELECT EXISTS (SELECT 1 FROM app.workspaces w
                      WHERE w.id = p_workspace AND w.status = 'active') INTO ok;
      PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
    END IF;
  ELSIF p_stage = 'platform' THEN
    SELECT coalesce((SELECT u.platform_admin FROM app.users u WHERE u.id = owner), false)
      INTO ok;
  ELSE
    ok := true;
  END IF;
  PERFORM set_config('app.auth_user_id', '', true);
  IF NOT ok THEN
    RETURN false;
  END IF;
  UPDATE app.sessions s
     SET token_hash = p_token, csrf_hash = p_csrf, stage = p_stage,
         active_workspace = p_workspace, last_seen_at = p_now,
         signed_in_at = CASE WHEN p_signed_in THEN p_now ELSE s.signed_in_at END,
         expires_at = p_expires
   WHERE s.id = p_id;
  RETURN true;
END
$$;

-- ---- Grants ----------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  app.console_workspaces(uuid),
  app.console_workspace_status(uuid, uuid, text, timestamptz),
  app.console_set_module(uuid, uuid, text, boolean),
  app.console_settings(uuid),
  app.console_set_setting(uuid, text, jsonb, timestamptz),
  app.incident_banner(),
  app.console_audit(uuid, text, uuid, jsonb, inet, timestamptz),
  app.console_api_usage(uuid, date, date),
  app.console_credential_expiry(uuid, timestamptz),
  app.console_job_records(uuid, jsonb),
  app.notification_purge_resolved(timestamptz),
  app.platform_notice_purge_resolved(timestamptz),
  app.platform_digest_counts(timestamptz, timestamptz),
  app.platform_digest_recipients(date),
  app.platform_digest_sent(date, uuid, timestamptz),
  app.workspace_close_members(),
  app.user_terms_delete_if_unattached(uuid)
  FROM PUBLIC;
-- Web's auth group: the console (each call re-checks the admin) and the banner for every session.
GRANT EXECUTE ON FUNCTION
  app.console_workspaces(uuid),
  app.console_workspace_status(uuid, uuid, text, timestamptz),
  app.console_set_module(uuid, uuid, text, boolean),
  app.console_settings(uuid),
  app.console_set_setting(uuid, text, jsonb, timestamptz),
  app.incident_banner(),
  app.console_audit(uuid, text, uuid, jsonb, inet, timestamptz),
  app.console_api_usage(uuid, date, date),
  app.console_credential_expiry(uuid, timestamptz),
  app.console_job_records(uuid, jsonb)
  TO ob_auth;
-- The worker's daily jobs: retention, the digest and workspace closure.
GRANT EXECUTE ON FUNCTION
  app.notification_purge_resolved(timestamptz),
  app.platform_notice_purge_resolved(timestamptz),
  app.platform_digest_counts(timestamptz, timestamptz),
  app.platform_digest_recipients(date),
  app.platform_digest_sent(date, uuid, timestamptz),
  app.workspace_close_members(),
  app.user_terms_delete_if_unattached(uuid)
  TO ob_worker;
