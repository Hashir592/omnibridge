-- 0019 per-workspace module toggles (T-0211, PLAT-2, WEB-1, ADR-059, PS-024). Runs as ob_owner.
-- Expand only.
--
-- `modules` holds the switches of one workspace, e.g. {"website_connector": true}. A switch that
-- is absent is off, so every existing and new workspace starts with every module off. Only the
-- platform turns a module on (the seed today, the console in M05): ob_tenant_rw gets no write
-- grant on the column, so a workspace admin cannot switch one on.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.workspaces
  ADD COLUMN modules jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(modules) = 'object');

-- The workspace picker (USR-2) with the modules each workspace has on: the 0011 body plus one
-- column, under a new name. auth_user_workspaces stays as it is for the previous app version
-- (expand only); a later contract step may drop it.
CREATE FUNCTION app.auth_user_workspaces_modules(p_user uuid)
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
    -- The workspace and company policies apply to ob_owner too: look at one workspace at a time.
    PERFORM set_config('app.workspace_id', m.workspace_id::text, true);
    RETURN QUERY
      SELECT w.id, w.name, m.role,
             (SELECT count(*) FROM app.companies c WHERE c.workspace_id = w.id),
             w.modules
        FROM app.workspaces w WHERE w.id = m.workspace_id;
  END LOOP;
  PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
  PERFORM set_config('app.auth_user_id', '', true);
END
$$;
REVOKE ALL ON FUNCTION app.auth_user_workspaces_modules(uuid) FROM PUBLIC, ob_tenant_rw;
GRANT EXECUTE ON FUNCTION app.auth_user_workspaces_modules(uuid) TO ob_auth;

-- Turns one known module of one workspace on or off. Platform tooling only: the dev seed (ob_ops)
-- today, the platform console later (M05).
CREATE FUNCTION app.workspace_set_module(p_workspace uuid, p_module text, p_on boolean)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  outer_workspace text := current_setting('app.workspace_id', true);
  found_one boolean;
BEGIN
  IF p_module NOT IN ('website_connector') THEN
    RAISE EXCEPTION 'unknown module %', p_module USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.workspace_id', p_workspace::text, true);
  UPDATE app.workspaces w SET modules = w.modules || jsonb_build_object(p_module, p_on)
   WHERE w.id = p_workspace;
  found_one := FOUND;
  PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
  RETURN found_one;
END
$$;
REVOKE ALL ON FUNCTION app.workspace_set_module(uuid, text, boolean) FROM PUBLIC, ob_tenant_rw;
GRANT EXECUTE ON FUNCTION app.workspace_set_module(uuid, text, boolean) TO ob_ops;
