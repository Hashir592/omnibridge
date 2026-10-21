-- 0011 passwords, MFA, lockout, sessions and password resets (T-0203, USR-2 to USR-7, SEC-1,
-- ADR-008, ADR-048, ADR-050). Runs as ob_owner. Expand only: new tables and functions.
--
-- These tables belong to a person, not to a workspace: sign-in happens before any workspace is
-- chosen. So they carry no workspace_id. ob_app holds no grant on them at all. Every read and
-- write goes through one of the narrow SECURITY DEFINER functions below, owned by ob_owner, each
-- taking the one user, token or counter key it acts on. FORCE RLS stays on; the only policies
-- are for ob_owner, so a definer function is the only way in.
--
-- Times come from the caller (p_now), so the app's clock drives expiry and tests can move it.
-- No plaintext email of an unknown address is ever stored: lockout counters are keyed by an
-- HMAC-SHA256 of the normalised email under a server secret (ADR-048).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Password and TOTP state of a user (USR-3, USR-4). The TOTP secret is sealed with the platform
-- data key (app.platform_keys); the pending one waits for the first code to confirm it.
CREATE TABLE app.user_auth (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES app.users (id),
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  password_set_at timestamptz NOT NULL,
  totp_secret bytea,
  totp_key_version bigint CHECK (totp_key_version >= 1),
  totp_pending bytea,
  totp_pending_key_version bigint CHECK (totp_pending_key_version >= 1),
  -- The last 30-second step accepted: each code works once.
  totp_last_step bigint,
  mfa_confirmed_at timestamptz,
  CHECK ((totp_secret IS NULL) = (mfa_confirmed_at IS NULL)),
  CHECK ((totp_secret IS NULL) = (totp_key_version IS NULL)),
  CHECK ((totp_pending IS NULL) = (totp_pending_key_version IS NULL))
);

-- The last 10 password hashes, the current one included (USR-3).
CREATE TABLE app.password_history (
  user_id uuid NOT NULL REFERENCES app.users (id),
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  set_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, set_at)
);

-- 10 single-use recovery codes (USR-4). High-entropy random codes, stored as HMAC-SHA256 under
-- auth_hmac_key, not argon2 (ADR-050).
CREATE TABLE app.recovery_codes (
  user_id uuid NOT NULL REFERENCES app.users (id),
  code_hmac bytea NOT NULL CHECK (octet_length(code_hmac) = 32),
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hmac)
);

-- Sessions (USR-6, SEC-1): the SHA-256 of the 256-bit cookie token, never the token. A session
-- moves pre_mfa → signed_in (MFA done) → workspace (one chosen) or platform (operator). Its
-- token is replaced at each step. Absolute lifetime counts from signed_in_at.
CREATE TABLE app.sessions (
  id uuid NOT NULL PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  user_id uuid NOT NULL REFERENCES app.users (id),
  stage text NOT NULL
    CHECK (stage IN ('pre_mfa', 'signed_in', 'password_change', 'workspace', 'platform')),
  -- Not workspace_id: a session is not tenant data, and the workspace it uses can change.
  active_workspace uuid REFERENCES app.workspaces (id),
  signed_in_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((stage = 'workspace') = (active_workspace IS NOT NULL))
);
CREATE INDEX sessions_user ON app.sessions (user_id) WHERE revoked_at IS NULL;

-- Failed sign-ins per submitted email (USR-5), real or not, keyed by HMAC; kept 24 hours after
-- the last failure (ADR-048).
CREATE TABLE app.login_counters (
  key bytea NOT NULL PRIMARY KEY CHECK (octet_length(key) = 32),
  failures bigint NOT NULL CHECK (failures >= 1),
  window_started_at timestamptz NOT NULL,
  last_failure_at timestamptz NOT NULL,
  locked_until timestamptz
);
CREATE INDEX login_counters_age ON app.login_counters (last_failure_at);

-- Failed sign-ins per client address, for the progressive delay (ADR-008).
CREATE TABLE app.ip_counters (
  ip inet NOT NULL PRIMARY KEY,
  failures bigint NOT NULL CHECK (failures >= 1),
  last_failure_at timestamptz NOT NULL,
  blocked_until timestamptz
);
CREATE INDEX ip_counters_age ON app.ip_counters (last_failure_at);

-- Password reset links (USR-7): the SHA-256 of the token, valid 30 minutes, used once.
CREATE TABLE app.password_resets (
  token_hash bytea NOT NULL PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX password_resets_user ON app.password_resets (user_id);

-- The platform data key: seals secrets that belong to a person rather than a workspace (TOTP),
-- wrapped by the secrets KEK and re-wrapped by the rewrap-keys job like the workspace keys.
CREATE TABLE app.platform_keys (
  version bigint NOT NULL PRIMARY KEY CHECK (version >= 1),
  kek_version bigint NOT NULL CHECK (kek_version >= 1),
  wrapped_key bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewrapped_at timestamptz
);

-- Forced RLS on every new table, open only to ob_owner (the definer functions). ob_app holds no
-- grant at all, so even a bug that sends raw SQL as ob_app reads nothing.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_auth', 'password_history', 'recovery_codes', 'sessions',
                           'login_counters', 'ip_counters', 'password_resets', 'platform_keys']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON app.%I TO ob_owner USING (true) WITH CHECK (true)',
                   t || '_definer_only', t);
    EXECUTE format('REVOKE ALL ON app.%I FROM ob_app', t);
  END LOOP;
END
$$;

-- The definer functions may read one user, by id or by email, and that user's memberships across
-- workspaces. Each function names the one it wants in a transaction-local setting first.
CREATE POLICY users_auth_lookup ON app.users FOR SELECT TO ob_owner
  USING (id = nullif(current_setting('app.auth_user_id', true), '')::uuid
         OR email = nullif(current_setting('app.auth_email', true), ''));
CREATE POLICY memberships_auth_user ON app.memberships FOR SELECT TO ob_owner
  USING (user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid);

-- Sign-in lookup by email (USR-5): the user and what sign-in needs, or no row.
CREATE FUNCTION app.auth_login_lookup(p_email text)
  RETURNS TABLE (user_id uuid, name text, email text, password_hash text,
                 password_set_at timestamptz, mfa_confirmed boolean, platform_admin boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.auth_email', lower(p_email), true);
  RETURN QUERY
    SELECT u.id, u.name, u.email, a.password_hash, a.password_set_at,
           a.mfa_confirmed_at IS NOT NULL, u.platform_admin
      FROM app.users u
      JOIN app.user_auth a ON a.user_id = u.id
     WHERE u.email = lower(p_email);
  PERFORM set_config('app.auth_email', '', true);
END
$$;

-- One user by id: for the session, the reset page and the password rules.
CREATE FUNCTION app.auth_user(p_user uuid)
  RETURNS TABLE (user_id uuid, name text, email text, password_set_at timestamptz,
                 mfa_confirmed boolean, platform_admin boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.auth_user_id', p_user::text, true);
  RETURN QUERY
    SELECT u.id, u.name, u.email, a.password_set_at, a.mfa_confirmed_at IS NOT NULL,
           u.platform_admin
      FROM app.users u
      LEFT JOIN app.user_auth a ON a.user_id = u.id
     WHERE u.id = p_user;
  PERFORM set_config('app.auth_user_id', '', true);
END
$$;

-- Active blocks for an email key and a client address; NULL where there is none.
CREATE FUNCTION app.auth_lock_state(p_key bytea, p_ip inet, p_now timestamptz)
  RETURNS TABLE (locked_until timestamptz, ip_blocked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (SELECT c.locked_until FROM app.login_counters c
           WHERE c.key = p_key AND c.locked_until > p_now),
         (SELECT i.blocked_until FROM app.ip_counters i
           WHERE i.ip = p_ip AND i.blocked_until > p_now)
$$;

-- Records one failed sign-in (USR-5, ADR-008). The 10th failure within 15 minutes locks the
-- email for 15 minutes from that failure. From the 4th failure from one address within 15
-- minutes, that address waits 1 s, doubling to 30 s. Rows idle for 24 hours are dropped.
CREATE FUNCTION app.auth_record_failure(p_key bytea, p_ip inet, p_now timestamptz)
  RETURNS TABLE (locked_until timestamptz, newly_locked boolean, ip_blocked_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c app.login_counters%ROWTYPE;
  i app.ip_counters%ROWTYPE;
  fresh boolean;
BEGIN
  DELETE FROM app.login_counters o WHERE o.last_failure_at < p_now - interval '24 hours';
  DELETE FROM app.ip_counters o WHERE o.last_failure_at < p_now - interval '24 hours';

  SELECT * INTO c FROM app.login_counters o WHERE o.key = p_key FOR UPDATE;
  fresh := NOT FOUND
        OR coalesce(c.locked_until <= p_now, false)
        OR (c.locked_until IS NULL AND c.window_started_at <= p_now - interval '15 minutes');
  IF NOT FOUND THEN
    INSERT INTO app.login_counters (key, failures, window_started_at, last_failure_at)
      VALUES (p_key, 1, p_now, p_now) RETURNING * INTO c;
  ELSIF fresh THEN
    UPDATE app.login_counters o SET failures = 1, window_started_at = p_now,
                                    last_failure_at = p_now, locked_until = NULL
     WHERE o.key = p_key RETURNING * INTO c;
  ELSIF c.locked_until IS NULL THEN
    UPDATE app.login_counters o SET failures = o.failures + 1, last_failure_at = p_now
     WHERE o.key = p_key RETURNING * INTO c;
  END IF;
  newly_locked := false;
  IF c.locked_until IS NULL AND c.failures >= 10 THEN
    UPDATE app.login_counters o SET locked_until = p_now + interval '15 minutes'
     WHERE o.key = p_key RETURNING * INTO c;
    newly_locked := true;
  END IF;
  locked_until := c.locked_until;

  SELECT * INTO i FROM app.ip_counters o WHERE o.ip = p_ip FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO app.ip_counters (ip, failures, last_failure_at) VALUES (p_ip, 1, p_now)
      RETURNING * INTO i;
  ELSIF i.last_failure_at <= p_now - interval '15 minutes' THEN
    UPDATE app.ip_counters o SET failures = 1, last_failure_at = p_now, blocked_until = NULL
     WHERE o.ip = p_ip RETURNING * INTO i;
  ELSE
    UPDATE app.ip_counters o SET failures = o.failures + 1, last_failure_at = p_now
     WHERE o.ip = p_ip RETURNING * INTO i;
  END IF;
  IF i.failures > 3 THEN
    UPDATE app.ip_counters o
       SET blocked_until = p_now + least(30, power(2, i.failures - 4)) * interval '1 second'
     WHERE o.ip = p_ip RETURNING * INTO i;
  END IF;
  ip_blocked_until := i.blocked_until;
  RETURN NEXT;
END
$$;

-- A good password clears its email's counter (not the address's).
CREATE FUNCTION app.auth_clear_failures(p_key bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  DELETE FROM app.login_counters c WHERE c.key = p_key
$$;

-- Sessions.
CREATE FUNCTION app.session_create(p_id uuid, p_token bytea, p_csrf bytea, p_user uuid,
                                   p_stage text, p_now timestamptz, p_expires timestamptz)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.sessions (id, token_hash, csrf_hash, user_id, stage, signed_in_at,
                            last_seen_at, expires_at)
    VALUES (p_id, p_token, p_csrf, p_user, p_stage, p_now, p_now, p_expires)
$$;

CREATE FUNCTION app.session_find(p_token bytea)
  RETURNS TABLE (id uuid, user_id uuid, stage text, active_workspace uuid, csrf_hash bytea,
                 signed_in_at timestamptz, last_seen_at timestamptz, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.id, s.user_id, s.stage, s.active_workspace, s.csrf_hash, s.signed_in_at,
         s.last_seen_at, s.expires_at
    FROM app.sessions s
   WHERE s.token_hash = p_token AND s.revoked_at IS NULL
$$;

CREATE FUNCTION app.session_touch(p_id uuid, p_now timestamptz) RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE app.sessions s SET last_seen_at = p_now WHERE s.id = p_id AND s.revoked_at IS NULL
$$;

-- Moves a live session to its next stage under a new token and CSRF secret. A workspace stage
-- needs a membership of that workspace. Returns false when nothing moved.
CREATE FUNCTION app.session_advance(p_id uuid, p_token bytea, p_csrf bytea, p_stage text,
                                    p_workspace uuid, p_now timestamptz,
                                    p_signed_in boolean, p_expires timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  owner uuid;
  member boolean;
BEGIN
  SELECT s.user_id INTO owner FROM app.sessions s
   WHERE s.id = p_id AND s.revoked_at IS NULL FOR UPDATE;
  IF owner IS NULL THEN
    RETURN false;
  END IF;
  IF p_workspace IS NOT NULL THEN
    PERFORM set_config('app.auth_user_id', owner::text, true);
    SELECT EXISTS (SELECT 1 FROM app.memberships m
                    WHERE m.user_id = owner AND m.workspace_id = p_workspace) INTO member;
    PERFORM set_config('app.auth_user_id', '', true);
    IF NOT member THEN
      RETURN false;
    END IF;
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

CREATE FUNCTION app.session_revoke(p_id uuid, p_now timestamptz) RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE app.sessions s SET revoked_at = p_now WHERE s.id = p_id AND s.revoked_at IS NULL
$$;

-- Sign out on all devices (USR-6), and every session after a password change or reset.
CREATE FUNCTION app.session_revoke_user(p_user uuid, p_now timestamptz) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  UPDATE app.sessions s SET revoked_at = p_now WHERE s.user_id = p_user AND s.revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- TOTP (USR-4).
CREATE FUNCTION app.auth_mfa_get(p_user uuid)
  RETURNS TABLE (secret bytea, key_version bigint, last_step bigint, pending bytea,
                 pending_key_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.totp_secret, a.totp_key_version, a.totp_last_step, a.totp_pending,
         a.totp_pending_key_version
    FROM app.user_auth a WHERE a.user_id = p_user
$$;

-- A new enrolment while MFA is not yet confirmed; returns false once it is (no silent reset).
CREATE FUNCTION app.auth_mfa_set_pending(p_user uuid, p_sealed bytea, p_key_version bigint)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE app.user_auth a SET totp_pending = p_sealed, totp_pending_key_version = p_key_version
   WHERE a.user_id = p_user AND a.mfa_confirmed_at IS NULL;
  RETURN FOUND;
END
$$;

-- Confirms the pending secret with the step its first code used, and stores the recovery codes.
CREATE FUNCTION app.auth_mfa_confirm(p_user uuid, p_step bigint, p_codes bytea[],
                                     p_now timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF cardinality(p_codes) <> 10 THEN
    RAISE EXCEPTION 'exactly 10 recovery codes are stored' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.user_auth a
     SET totp_secret = a.totp_pending, totp_key_version = a.totp_pending_key_version,
         totp_pending = NULL, totp_pending_key_version = NULL, totp_last_step = p_step,
         mfa_confirmed_at = p_now
   WHERE a.user_id = p_user AND a.mfa_confirmed_at IS NULL AND a.totp_pending IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM app.recovery_codes r WHERE r.user_id = p_user;
  INSERT INTO app.recovery_codes (user_id, code_hmac)
    SELECT p_user, c FROM unnest(p_codes) AS c;
  RETURN true;
END
$$;

-- Accepts a TOTP step once: a later step only, so a code can never be replayed.
CREATE FUNCTION app.auth_mfa_use_step(p_user uuid, p_step bigint) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE app.user_auth a SET totp_last_step = p_step
   WHERE a.user_id = p_user AND a.mfa_confirmed_at IS NOT NULL
     AND (a.totp_last_step IS NULL OR a.totp_last_step < p_step);
  RETURN FOUND;
END
$$;

-- Uses one recovery code; returns how many are left, or -1 when it is unknown or used.
CREATE FUNCTION app.auth_recovery_use(p_user uuid, p_hmac bytea, p_now timestamptz)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  left_over bigint;
BEGIN
  UPDATE app.recovery_codes r SET used_at = p_now
   WHERE r.user_id = p_user AND r.code_hmac = p_hmac AND r.used_at IS NULL;
  IF NOT FOUND THEN
    RETURN -1;
  END IF;
  SELECT count(*) INTO left_over FROM app.recovery_codes r
   WHERE r.user_id = p_user AND r.used_at IS NULL;
  RETURN left_over;
END
$$;

-- Passwords (USR-3): the hashes the new password must not match (last 10, current included).
CREATE FUNCTION app.auth_password_hashes(p_user uuid) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT h.password_hash FROM app.password_history h
   WHERE h.user_id = p_user ORDER BY h.set_at DESC LIMIT 10
$$;

-- Sets a password (rules checked by the caller) and keeps the newest 10 in the history.
CREATE FUNCTION app.auth_password_set(p_user uuid, p_hash text, p_now timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.user_auth (user_id, password_hash, password_set_at)
    VALUES (p_user, p_hash, p_now)
    ON CONFLICT (user_id) DO UPDATE
      SET password_hash = excluded.password_hash, password_set_at = excluded.password_set_at;
  INSERT INTO app.password_history (user_id, password_hash, set_at) VALUES (p_user, p_hash, p_now);
  DELETE FROM app.password_history h
   WHERE h.user_id = p_user
     AND h.set_at NOT IN (SELECT k.set_at FROM app.password_history k
                           WHERE k.user_id = p_user ORDER BY k.set_at DESC LIMIT 10);
END
$$;

-- Password reset links (USR-7).
CREATE FUNCTION app.auth_reset_create(p_token bytea, p_user uuid, p_now timestamptz,
                                      p_expires timestamptz)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.password_resets (token_hash, user_id, created_at, expires_at)
    VALUES (p_token, p_user, p_now, p_expires)
$$;

CREATE FUNCTION app.auth_reset_find(p_token bytea, p_now timestamptz)
  RETURNS TABLE (user_id uuid, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.user_id, r.expires_at FROM app.password_resets r
   WHERE r.token_hash = p_token AND r.used_at IS NULL AND r.expires_at > p_now
$$;

-- Uses a link once, and every other open link of the same user with it. Returns the user.
CREATE FUNCTION app.auth_reset_consume(p_token bytea, p_now timestamptz) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  who uuid;
BEGIN
  UPDATE app.password_resets r SET used_at = p_now
   WHERE r.token_hash = p_token AND r.used_at IS NULL AND r.expires_at > p_now
   RETURNING r.user_id INTO who;
  IF who IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE app.password_resets r SET used_at = p_now WHERE r.user_id = who AND r.used_at IS NULL;
  RETURN who;
END
$$;

-- The workspace picker (USR-2): every workspace the user belongs to, with their role there.
CREATE FUNCTION app.auth_user_workspaces(p_user uuid)
  RETURNS TABLE (id uuid, name text, role text, companies bigint)
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
    -- The workspace and company policies apply to ob_owner too: look at one workspace at a time.
    PERFORM set_config('app.workspace_id', m.workspace_id::text, true);
    RETURN QUERY
      SELECT w.id, w.name, m.role,
             (SELECT count(*) FROM app.companies c WHERE c.workspace_id = w.id)
        FROM app.workspaces w WHERE w.id = m.workspace_id;
  END LOOP;
  PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
  PERFORM set_config('app.auth_user_id', '', true);
END
$$;

-- The platform data key.
CREATE FUNCTION app.platform_key_get(p_version bigint)
  RETURNS TABLE (version bigint, kek_version bigint, wrapped_key bytea)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT k.version, k.kek_version, k.wrapped_key FROM app.platform_keys k
   WHERE p_version IS NULL OR k.version = p_version
   ORDER BY k.version DESC
$$;

CREATE FUNCTION app.platform_key_insert(p_version bigint, p_kek_version bigint, p_wrapped bytea)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.platform_keys (version, kek_version, wrapped_key)
    VALUES (p_version, p_kek_version, p_wrapped) ON CONFLICT (version) DO NOTHING;
  RETURN FOUND;
END
$$;

CREATE FUNCTION app.platform_key_rewrap(p_version bigint, p_kek_version bigint, p_wrapped bytea)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE app.platform_keys k
     SET kek_version = p_kek_version, wrapped_key = p_wrapped, rewrapped_at = now()
   WHERE k.version = p_version
$$;

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app'
             AND (p.proname LIKE 'auth\_%' OR p.proname LIKE 'session\_%'
                  OR p.proname LIKE 'platform\_key\_%')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ob_app', f);
  END LOOP;
END
$$;
