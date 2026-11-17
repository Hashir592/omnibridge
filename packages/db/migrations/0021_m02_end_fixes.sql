-- 0021 M02 end fixes (T-0401, S4 M02 end F-M02e-01, -03, -04). Runs as ob_owner. Expand only:
-- the previous app version keeps working (it writes members only as an admin, sends no job with a
-- company, and still may call app.invite_accept).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- F-M02e-01 (PERM-3, PERM-5): roles, ticks, invites and reviews were admin-only in app code alone.
-- True when the transaction names no user (the worker, the seed) or when the named user is an
-- admin of the transaction's workspace. A request always names its user (app.user_id), so a
-- child's request can never write these tables, whatever the app code does.
CREATE FUNCTION app.may_manage_members() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(current_setting('app.user_id', true), '') IS NULL
      OR EXISTS (SELECT 1 FROM app.memberships m
                  WHERE m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                    AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
                    AND m.role = 'admin')
$$;
REVOKE ALL ON FUNCTION app.may_manage_members() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.may_manage_members() TO ob_tenant_rw;

-- The one exception: a workspace's first admin, added while it has no admin at all (from then on
-- PERM-7 keeps one). Used only by the membership insert policy, never by the tick or invite ones.
CREATE FUNCTION app.workspace_has_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.memberships m
                  WHERE m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                    AND m.role = 'admin')
$$;
REVOKE ALL ON FUNCTION app.workspace_has_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_has_admin() TO ob_tenant_rw;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'membership_tabs', 'membership_companies', 'invites',
                           'access_reviews']
  LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I AS RESTRICTIVE FOR INSERT TO ob_tenant_rw '
                   'WITH CHECK (%s)', t || '_admin_insert', t,
                   CASE WHEN t = 'memberships'
                        THEN 'app.may_manage_members() OR (role = ''admin'' AND NOT app.workspace_has_admin())'
                        ELSE 'app.may_manage_members()' END);
    EXECUTE format('CREATE POLICY %I ON app.%I AS RESTRICTIVE FOR UPDATE TO ob_tenant_rw '
                   'USING (app.may_manage_members()) WITH CHECK (app.may_manage_members())',
                   t || '_admin_update', t);
    EXECUTE format('CREATE POLICY %I ON app.%I AS RESTRICTIVE FOR DELETE TO ob_tenant_rw '
                   'USING (app.may_manage_members())', t || '_admin_delete', t);
  END LOOP;
END
$$;

-- F-M02e-03 (PERM-3, invariant 4): a job may belong to one company. Web (ob_app) then shows it
-- only with that company in scope, like every company row; a job with no company stays
-- workspace-wide. The worker (ob_worker) is not bound by it: it runs jobs, it does not show them.
ALTER TABLE app.job_records ADD COLUMN company_id uuid;
ALTER TABLE app.job_records ADD CONSTRAINT job_records_company
  FOREIGN KEY (workspace_id, company_id) REFERENCES app.companies (workspace_id, id) NOT VALID; -- validated in 0022
CREATE POLICY job_records_company_scope ON app.job_records AS RESTRICTIVE FOR SELECT TO ob_app
  USING (company_id IS NULL
         OR company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                       '{}'::uuid[])));

-- F-M02e-04 (USR-1, USR-3): a brand-new person's invite is accepted and their first password
-- set in one call, so a failure between the two can no longer leave a member with no password.
-- Same rules as invite_accept with p_new_only (an email that already has a sign-in gets no row).
CREATE FUNCTION app.invite_accept_new_user(p_token bytea, p_new_user uuid, p_name text,
                                           p_now timestamptz, p_hash text)
  RETURNS TABLE (user_id uuid, workspace_id uuid, created boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  SELECT a.user_id, a.workspace_id, a.created INTO r
    FROM app.invite_accept(p_token, p_new_user, p_name, p_now, true) a;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM app.auth_password_set(r.user_id, p_hash, p_now);
  user_id := r.user_id;
  workspace_id := r.workspace_id;
  created := r.created;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.invite_accept_new_user(bytea, uuid, text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invite_accept_new_user(bytea, uuid, text, timestamptz, text) TO ob_auth;
