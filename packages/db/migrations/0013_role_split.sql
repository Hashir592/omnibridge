-- 0013 database role split for auth (ADR-051, F-M02h-03). Runs as ob_owner.
--
-- Until now every grant went to ob_app, and ob_worker was a member of ob_app, so the worker and
-- any raw SQL on either role could call every auth definer: read a password hash, or mint a
-- platform-stage session. The 0011 header ("ob_app holds no grant at all, so even a bug that
-- sends raw SQL as ob_app reads nothing") was true of the auth tables but not of the definers.
-- What is true from here on:
--   ob_tenant_rw  NOLOGIN group: every table, sequence and helper-function grant, and every
--                 RLS policy that used to name ob_app. Members: ob_app, ob_worker, ob_ops.
--   ob_auth       NOLOGIN group: EXECUTE on the auth_*, session_* and platform_key_* definers.
--                 Member: ob_app (web) only.
--   ob_worker     ob_tenant_rw, plus EXECUTE on exactly what its jobs call: auth_reset_create
--                 (the reset mail) and purge_audit_events (ADR-049).
--   ob_ops        rewrap-keys and the dev seed: ob_tenant_rw, plus EXECUTE on the platform-key
--                 definers and the few password and MFA setup definers the seed calls.
-- The roles and their memberships are created by infra/compose/db-main/10-roles.sh (ob_owner
-- cannot create roles). Inside the definers: session_create makes pre_mfa sessions only, and
-- session_advance allows only the stage moves the app makes, with platform only for a user whose
-- platform_admin flag is set.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_tenant_rw')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_auth')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_ops') THEN
    RAISE EXCEPTION 'roles ob_tenant_rw, ob_auth and ob_ops are missing: recreate the db-main '
      'volume so infra/compose/db-main/10-roles.sh runs (ADR-051)';
  END IF;
END
$$;

-- Schemas: each group needs USAGE to reach its objects.
GRANT USAGE ON SCHEMA app TO ob_tenant_rw, ob_auth;
GRANT USAGE ON SCHEMA pgboss TO ob_tenant_rw;
REVOKE USAGE ON SCHEMA app FROM ob_app;
REVOKE USAGE ON SCHEMA pgboss FROM ob_app;

-- Tables, views and sequences: every privilege ob_app holds moves to ob_tenant_rw, whole-table
-- and per-column alike.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT format('%I.%I', n.nspname, c.relname) AS obj,
           CASE WHEN c.relkind = 'S' THEN 'SEQUENCE ' ELSE 'TABLE ' END AS kind,
           a.privilege_type AS priv
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname IN ('app', 'pgboss')
       AND a.grantee = 'ob_app'::regrole
  LOOP
    EXECUTE format('GRANT %s ON %s%s TO ob_tenant_rw', r.priv, r.kind, r.obj);
    EXECUTE format('REVOKE %s ON %s%s FROM ob_app', r.priv, r.kind, r.obj);
  END LOOP;

  FOR r IN
    SELECT format('%I.%I', n.nspname, c.relname) AS obj, quote_ident(att.attname) AS col,
           a.privilege_type AS priv
      FROM pg_attribute att
      JOIN pg_class c ON c.oid = att.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(att.attacl) a
     WHERE n.nspname IN ('app', 'pgboss')
       AND a.grantee = 'ob_app'::regrole
  LOOP
    EXECUTE format('GRANT %s (%s) ON TABLE %s TO ob_tenant_rw', r.priv, r.col, r.obj);
    EXECUTE format('REVOKE %s (%s) ON TABLE %s FROM ob_app', r.priv, r.col, r.obj);
  END LOOP;
END
$$;

-- Functions: the auth definers go to ob_auth, every other function ob_app could call (the
-- tenancy helpers, pg-boss) to ob_tenant_rw.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, n.nspname = 'app'
             AND (p.proname LIKE 'auth\_%' OR p.proname LIKE 'session\_%'
                  OR p.proname LIKE 'platform\_key\_%') AS is_auth
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE n.nspname IN ('app', 'pgboss')
       AND a.grantee = 'ob_app'::regrole
       AND a.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', r.fn,
                   CASE WHEN r.is_auth THEN 'ob_auth' ELSE 'ob_tenant_rw' END);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ob_app', r.fn);
  END LOOP;
END
$$;

-- Objects created later get the same grants (0001 named ob_app).
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA app
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA app
  REVOKE USAGE, SELECT ON SEQUENCES FROM ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ob_tenant_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO ob_tenant_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  REVOKE USAGE, SELECT ON SEQUENCES FROM ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  REVOKE EXECUTE ON FUNCTIONS FROM ob_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ob_tenant_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO ob_tenant_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE ob_owner IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO ob_tenant_rw;

-- RLS policies written TO ob_app now name ob_tenant_rw, so they bind every member.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pol.polname, format('%I.%I', n.nspname, c.relname) AS tbl,
           (SELECT string_agg(CASE WHEN x = 'ob_app'::regrole THEN 'ob_tenant_rw'
                                   ELSE quote_ident(x::regrole::text) END, ', ')
              FROM unnest(pol.polroles) x) AS roles
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE 'ob_app'::regrole = ANY (pol.polroles)
  LOOP
    EXECUTE format('ALTER POLICY %I ON %s TO %s', r.polname, r.tbl, r.roles);
  END LOOP;
END
$$;

-- The worker: only the definers its jobs call. The purge grant (0010) stays.
GRANT EXECUTE ON FUNCTION app.auth_reset_create(bytea, uuid, timestamptz, timestamptz)
  TO ob_worker;

-- rewrap-keys and the dev seed.
GRANT EXECUTE ON FUNCTION app.platform_key_get(bigint) TO ob_ops;
GRANT EXECUTE ON FUNCTION app.platform_key_insert(bigint, bigint, bytea) TO ob_ops;
GRANT EXECUTE ON FUNCTION app.platform_key_rewrap(bigint, bigint, bytea) TO ob_ops;
GRANT EXECUTE ON FUNCTION app.auth_user(uuid) TO ob_ops;
GRANT EXECUTE ON FUNCTION app.auth_password_set(uuid, text, timestamptz) TO ob_ops;
GRANT EXECUTE ON FUNCTION app.auth_mfa_set_pending(uuid, bytea, bigint) TO ob_ops;
GRANT EXECUTE ON FUNCTION app.auth_mfa_confirm(uuid, bigint, bytea[], timestamptz) TO ob_ops;

-- A new session is always pre_mfa: every later stage comes from session_advance (ADR-051).
CREATE OR REPLACE FUNCTION app.session_create(p_id uuid, p_token bytea, p_csrf bytea, p_user uuid,
                                              p_stage text, p_now timestamptz,
                                              p_expires timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_stage IS DISTINCT FROM 'pre_mfa' THEN
    RAISE EXCEPTION 'a new session starts at pre_mfa' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.sessions (id, token_hash, csrf_hash, user_id, stage, signed_in_at,
                            last_seen_at, expires_at)
    VALUES (p_id, p_token, p_csrf, p_user, p_stage, p_now, p_now, p_expires);
END
$$;

-- Moves a live session to its next stage under a new token and CSRF secret. Only these moves:
--   pre_mfa → signed_in, password_change or workspace (MFA passed; p_signed_in starts the clock)
--   signed_in, workspace or platform → workspace or platform (the picker, the console)
-- A workspace stage needs a membership of that workspace; platform needs the user's
-- platform_admin flag, read here. Returns false when nothing moved.
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
