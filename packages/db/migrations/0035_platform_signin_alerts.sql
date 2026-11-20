-- 0035 console and platform-admin sign-in alerts (T-0507: S5-20261121-01 and -02, ADR-076;
-- SEC-12, PLAT-1, PLAT-2). Runs as ob_owner. Expand only: every function keeps its signature,
-- and the wider auth_events rule accepts everything the previous app version writes.
--
-- (1) A sign-in that ends at the picker (no workspace yet) is recorded per person as auth.login.
-- (2) The 0032 workspace rules leave platform admins out: their failures and lockouts are
--     platform notices to platform admins, never alerts to a workspace's admins.
-- (3) The platform-level rule reads console entries, failures and lockouts of platform admins
--     (IDs and counts only), through worker-only definers.
-- (4) session_advance takes the workspace FOR SHARE (before the session row, as a suspend does),
--     so a suspend in progress is waited for and seen, and one that follows revokes the session.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- ---- (1) auth.login per person; validated in 0036, in its own transaction ---------------------
-- The wider rule goes on first, so the table is never without one.
ALTER TABLE app.auth_events
  ADD CONSTRAINT auth_events_action CHECK (action IN ('auth.login', 'auth.login_failed',
                                                      'auth.locked', 'mfa.enrolled',
                                                      'auth.signed_out_everywhere')) NOT VALID;
-- Contract: the 0015 rule is the new one minus auth.login, so dropping it removes no guarantee.
-- waiver: replaced by auth_events_action; ADR-076
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.auth_events DROP CONSTRAINT IF EXISTS auth_events_action_check;

-- ---- Platform admins, for the security definers only ------------------------------------------
-- The IDs of every platform admin, read now (the 0031 policy shows platform admins to ob_owner
-- while app.platform_notice_mail is on).
CREATE FUNCTION app.security_platform_admin_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.platform_notice_mail', 'on', true);
  RETURN QUERY SELECT u.id FROM app.users u WHERE u.platform_admin;
  PERFORM set_config('app.platform_notice_mail', '', true);
END
$$;
REVOKE ALL ON FUNCTION app.security_platform_admin_ids() FROM PUBLIC;

-- ---- (2) The 0032 member rules, without platform admins --------------------------------------
CREATE OR REPLACE FUNCTION app.security_login_failures(p_since timestamptz)
  RETURNS TABLE (user_id uuid, failures bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.user_id, count(*)
    FROM app.auth_events e
    JOIN app.memberships m
      ON m.user_id = e.user_id
     AND m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
   WHERE e.action = 'auth.login_failed' AND e.occurred_at >= p_since
     AND e.user_id NOT IN (SELECT app.security_platform_admin_ids())
   GROUP BY e.user_id
   ORDER BY e.user_id
$$;

CREATE OR REPLACE FUNCTION app.security_locks(p_since timestamptz)
  RETURNS TABLE (event_id bigint, user_id uuid, occurred_at timestamptz)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.id, e.user_id, e.occurred_at
    FROM app.auth_events e
    JOIN app.memberships m
      ON m.user_id = e.user_id
     AND m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
   WHERE e.action = 'auth.locked' AND e.occurred_at >= p_since
     AND e.user_id NOT IN (SELECT app.security_platform_admin_ids())
   ORDER BY e.id
$$;

-- ---- (3) The platform-level rule ---------------------------------------------------------------
-- Console entries since p_since from a network (an IPv4 address or an IPv6 /64) the same user
-- has not entered the console from in the p_lookback_days before. A user's first entry ever is
-- never reported.
CREATE FUNCTION app.security_platform_console_entries(p_since timestamptz, p_lookback_days int)
  RETURNS TABLE (event_id uuid, user_id uuid, occurred_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH entries AS (
    SELECT e.id, e.user_id, e.occurred_at,
           CASE family(e.ip) WHEN 6 THEN set_masklen(e.ip, 64) ELSE set_masklen(e.ip, 32) END::cidr
             AS net
      FROM app.platform_audit_events e
     WHERE e.action = 'platform.console_entered' AND e.ip IS NOT NULL
       AND e.occurred_at >= p_since - make_interval(days => p_lookback_days))
  SELECT l.id, l.user_id, l.occurred_at
    FROM entries l
   WHERE l.occurred_at >= p_since
     AND EXISTS (SELECT 1 FROM app.platform_audit_events e
                  WHERE e.action = 'platform.console_entered' AND e.user_id = l.user_id
                    AND (e.occurred_at, e.id) < (l.occurred_at, l.id))
     AND NOT EXISTS (SELECT 1 FROM entries e
                      WHERE e.user_id = l.user_id
                        AND (e.occurred_at, e.id) < (l.occurred_at, l.id)
                        AND e.occurred_at >= l.occurred_at - make_interval(days => p_lookback_days)
                        AND e.net = l.net)
   ORDER BY l.occurred_at, l.id
$$;

-- Failed sign-ins per platform admin since p_since.
CREATE FUNCTION app.security_platform_login_failures(p_since timestamptz)
  RETURNS TABLE (user_id uuid, failures bigint)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.user_id, count(*)
    FROM app.auth_events e
   WHERE e.action = 'auth.login_failed' AND e.occurred_at >= p_since
     AND e.user_id IN (SELECT app.security_platform_admin_ids())
   GROUP BY e.user_id
   ORDER BY e.user_id
$$;

-- Lockouts of platform admins since p_since, one row per lock.
CREATE FUNCTION app.security_platform_locks(p_since timestamptz)
  RETURNS TABLE (event_id bigint, user_id uuid, occurred_at timestamptz)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.id, e.user_id, e.occurred_at
    FROM app.auth_events e
   WHERE e.action = 'auth.locked' AND e.occurred_at >= p_since
     AND e.user_id IN (SELECT app.security_platform_admin_ids())
   ORDER BY e.id
$$;

-- The record IDs of the open platform notices of one type and record kind (so a counter rule can
-- resolve the ones whose count dropped).
CREATE FUNCTION app.platform_notice_open_records(p_type text, p_record_kind text)
  RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT n.record_id FROM app.platform_notifications n
   WHERE n.type = p_type AND n.record_kind = p_record_kind AND n.resolved_at IS NULL
   ORDER BY n.record_id
$$;

REVOKE ALL ON FUNCTION
  app.security_platform_console_entries(timestamptz, int),
  app.security_platform_login_failures(timestamptz),
  app.security_platform_locks(timestamptz),
  app.platform_notice_open_records(text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.security_platform_console_entries(timestamptz, int),
  app.security_platform_login_failures(timestamptz),
  app.security_platform_locks(timestamptz),
  app.platform_notice_open_records(text, text)
  TO ob_worker;

-- ---- (4) session_advance: the status read waits for a suspend (S5-20261121-02) ----------------
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
  -- A workspace move takes the workspace's share lock before the session's row lock: the same
  -- order as a suspend (workspace, then its sessions), so the two never deadlock.
  IF p_stage = 'workspace' AND p_workspace IS NOT NULL THEN
    PERFORM set_config('app.workspace_id', p_workspace::text, true);
    PERFORM 1 FROM app.workspaces w WHERE w.id = p_workspace FOR SHARE;
    PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
  END IF;
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
      -- A suspended or archived workspace cannot be entered (PLAT-2). The share lock taken
      -- above waited for a status change in progress, so this reads the committed status; a
      -- change that comes after waits for this sign-in, and its revocation then finds it.
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
