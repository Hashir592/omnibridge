-- 0032 security alert signals (T-0503: SEC-12, USR-5). Runs as ob_owner. Expand only.
--
-- Failed sign-ins and lockouts are kept per person in app.auth_events (ADR-052), outside any
-- workspace, and reached only through definers. These two give the security scan of one
-- workspace what it needs, for that workspace's members only: failure counts and lock events,
-- as IDs and counts. Only the worker may call them.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Failed sign-ins per member of the current workspace since p_since.
CREATE FUNCTION app.security_login_failures(p_since timestamptz)
  RETURNS TABLE (user_id uuid, failures bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.user_id, count(*)
    FROM app.auth_events e
    JOIN app.memberships m
      ON m.user_id = e.user_id
     AND m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
   WHERE e.action = 'auth.login_failed' AND e.occurred_at >= p_since
   GROUP BY e.user_id
   ORDER BY e.user_id
$$;

-- Lockouts (USR-5) of members of the current workspace since p_since, one row per lock.
CREATE FUNCTION app.security_locks(p_since timestamptz)
  RETURNS TABLE (event_id bigint, user_id uuid, occurred_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.id, e.user_id, e.occurred_at
    FROM app.auth_events e
    JOIN app.memberships m
      ON m.user_id = e.user_id
     AND m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
   WHERE e.action = 'auth.locked' AND e.occurred_at >= p_since
   ORDER BY e.id
$$;

REVOKE ALL ON FUNCTION app.security_login_failures(timestamptz), app.security_locks(timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.security_login_failures(timestamptz), app.security_locks(timestamptz)
  TO ob_worker;
