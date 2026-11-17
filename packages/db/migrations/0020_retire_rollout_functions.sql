-- 0020 retires the functions kept for the T-0210/T-0211 rollout (T-0212, ADR-062). Runs as
-- ob_owner. Contract step of 0018/0019: no app code calls them any more (rollout-functions.test.ts
-- proves it), so no role may execute them.
--
-- ADR-062 says drop. squawk bans DROP FUNCTION (ban-drop-function), and ADR-045 allows a waiver
-- only for ban-drop-constraint, so taking every EXECUTE grant away is the contract step here; the
-- DROP waits for S1's ruling on PS-025. A call now fails with "permission denied", which is the
-- same outcome for every caller as a dropped function.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  fn regprocedure;
  r record;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.auth_record_failure(bytea, inet, timestamptz)'::regprocedure,
    'app.auth_reset_allow(bytea, inet, timestamptz)'::regprocedure,
    'app.auth_user_workspaces(uuid)'::regprocedure
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOR r IN
      SELECT DISTINCT a.grantee::regrole AS grantee
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
       WHERE p.oid = fn AND a.grantee <> 0 AND a.grantee <> p.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', fn, r.grantee);
    END LOOP;
  END LOOP;
END
$$;
