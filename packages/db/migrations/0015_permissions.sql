-- 0015 roles, tab and company ticks, invites, the access review and user-level auth events
-- (T-0204: TEN-5, TEN-7, USR-1, USR-8, USR-9, PERM-1 to PERM-7, AT-2; ADR-051, ADR-052).
-- Runs as ob_owner. Expand only: new tables, functions and a trigger.
--
-- A membership's role is `admin` or `member`; the UI calls a member a Child (PERM-1). A child
-- sees only the tabs and companies ticked for them (PERM-3, invariant 4); a new child has none
-- (PERM-6). The ticks are read once per request by app.member_scope(), which also sets
-- app.company_ids, so RLS narrows every company-scoped table to the permitted companies.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.membership_tabs (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  user_id uuid NOT NULL,
  tab text NOT NULL CHECK (tab IN ('home', 'orders', 'shipping', 'stock-catalogue',
    'customer-service', 'account-health', 'advertising', 'sales-profit', 'forecasting',
    'finance', 'reminders', 'notes')),
  PRIMARY KEY (workspace_id, user_id, tab),
  FOREIGN KEY (workspace_id, user_id) REFERENCES app.memberships (workspace_id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE app.membership_companies (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  user_id uuid NOT NULL,
  company_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, user_id, company_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES app.memberships (workspace_id, user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, company_id) REFERENCES app.companies (workspace_id, id)
);
CREATE INDEX membership_companies_company ON app.membership_companies (workspace_id, company_id);

-- Invitations (USR-1, TEN-7): to a named person, with the role and ticks they will get. Only the
-- token's SHA-256 is stored; the worker makes the token just before it mails the link.
CREATE TABLE app.invites (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  email text NOT NULL
    CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254 AND email LIKE '_%@_%'),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  tabs text[] NOT NULL DEFAULT '{}',
  company_ids uuid[] NOT NULL DEFAULT '{}',
  invited_by uuid REFERENCES app.users (id),
  token_hash bytea UNIQUE CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES app.users (id),
  revoked_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CHECK (expires_at > created_at)
);
CREATE INDEX invites_workspace ON app.invites (workspace_id, created_at DESC);

-- The quarterly access review (USR-9): one task per workspace every 90 days.
CREATE TABLE app.access_reviews (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES app.users (id),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id)
);
CREATE INDEX access_reviews_workspace ON app.access_reviews (workspace_id, due_at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['membership_tabs', 'membership_companies', 'invites', 'access_reviews']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) '
      'WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t || '_tenant', t);
  END LOOP;
END
$$;
-- A tick for a company is visible only with that company in scope, like every company row.
CREATE POLICY membership_companies_scope ON app.membership_companies AS RESTRICTIVE
  TO ob_tenant_rw
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])));
-- An invite is revoked or accepted, never deleted; a review is completed, never deleted.
REVOKE DELETE ON app.invites, app.access_reviews FROM ob_tenant_rw;
REVOKE UPDATE ON app.invites, app.access_reviews FROM ob_tenant_rw;
GRANT UPDATE (token_hash, revoked_at) ON app.invites TO ob_tenant_rw;
GRANT UPDATE (completed_at, completed_by) ON app.access_reviews TO ob_tenant_rw;
-- Ticks are replaced as a set, so they may be deleted; they are never edited in place.
REVOKE UPDATE ON app.membership_tabs, app.membership_companies FROM ob_tenant_rw;

-- PERM-7: a workspace always keeps at least one admin. The workspace row is locked first, so two
-- admins demoting each other at the same time cannot both succeed.
CREATE FUNCTION app.memberships_keep_an_admin() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.role <> 'admin' OR (TG_OP = 'UPDATE' AND NEW.role = 'admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  PERFORM 1 FROM app.workspaces w WHERE w.id = OLD.workspace_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.memberships m
                  WHERE m.workspace_id = OLD.workspace_id AND m.role = 'admin'
                    AND m.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'the last admin of a workspace cannot be removed or demoted'
      USING ERRCODE = 'OBA01';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
REVOKE ALL ON FUNCTION app.memberships_keep_an_admin() FROM PUBLIC;
CREATE TRIGGER memberships_keep_an_admin BEFORE UPDATE OR DELETE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.memberships_keep_an_admin();

-- The caller's access in the current workspace (app.user_id), read once per request: no row when
-- they are not a member (USR-8: a removed user is refused on the next request). An admin gets
-- every company and every tab (tabs NULL); a child gets only their ticks. It also sets
-- app.company_ids to exactly those companies, never a wildcard (invariant 4).
CREATE FUNCTION app.member_scope()
  RETURNS TABLE (role text, tabs text[], company_ids uuid[])
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  usr uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  r text;
BEGIN
  SELECT m.role INTO r FROM app.memberships m WHERE m.workspace_id = ws AND m.user_id = usr;
  IF r IS NULL THEN
    PERFORM set_config('app.company_ids', '{}', true);
    RETURN;
  END IF;
  role := r;
  IF r = 'admin' THEN
    tabs := NULL;
    company_ids := app.workspace_company_ids();
  ELSE
    SELECT coalesce(array_agg(t.tab ORDER BY t.tab), '{}') INTO tabs
      FROM app.membership_tabs t WHERE t.workspace_id = ws AND t.user_id = usr;
    SELECT coalesce(array_agg(c.company_id ORDER BY c.company_id), '{}') INTO company_ids
      FROM app.membership_companies c WHERE c.workspace_id = ws AND c.user_id = usr;
  END IF;
  PERFORM set_config('app.company_ids', company_ids::text, true);
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.member_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.member_scope() TO ob_tenant_rw;

-- An invite link, by its token (before any workspace is chosen): what the accept page shows.
CREATE FUNCTION app.invite_find(p_token bytea, p_now timestamptz)
  RETURNS TABLE (id uuid, workspace_id uuid, workspace_name text, email text, role text,
                 user_exists boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.id, i.workspace_id, w.name, i.email, i.role,
         EXISTS (SELECT 1 FROM app.users u WHERE u.email = i.email)
    FROM app.invites i JOIN app.workspaces w ON w.id = i.workspace_id
   WHERE i.token_hash = p_token AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     AND i.expires_at > p_now
$$;

-- Accepts an invite once: the person (new, or already a user under that email) joins the
-- workspace with the invite's role and ticks. Returns the user and whether they are new; no row
-- when the link is unknown, used, revoked or expired, or they are already a member.
CREATE FUNCTION app.invite_accept(p_token bytea, p_new_user uuid, p_name text, p_now timestamptz)
  RETURNS TABLE (user_id uuid, workspace_id uuid, created boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inv app.invites%ROWTYPE;
  uid uuid;
  fresh boolean := false;
BEGIN
  SELECT * INTO inv FROM app.invites i
   WHERE i.token_hash = p_token AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     AND i.expires_at > p_now
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT u.id INTO uid FROM app.users u WHERE u.email = inv.email;
  IF uid IS NULL THEN
    INSERT INTO app.users (id, email, name) VALUES (p_new_user, inv.email, p_name);
    uid := p_new_user;
    fresh := true;
  ELSIF EXISTS (SELECT 1 FROM app.memberships m
                 WHERE m.workspace_id = inv.workspace_id AND m.user_id = uid) THEN
    RETURN;
  END IF;
  INSERT INTO app.memberships (workspace_id, user_id, role) VALUES (inv.workspace_id, uid, inv.role);
  IF inv.role <> 'admin' THEN
    INSERT INTO app.membership_tabs (workspace_id, user_id, tab)
      SELECT inv.workspace_id, uid, t FROM unnest(inv.tabs) t;
    INSERT INTO app.membership_companies (workspace_id, user_id, company_id)
      SELECT inv.workspace_id, uid, c FROM unnest(inv.company_ids) c
       WHERE EXISTS (SELECT 1 FROM app.companies co
                      WHERE co.workspace_id = inv.workspace_id AND co.id = c);
  END IF;
  UPDATE app.invites i SET accepted_at = p_now, accepted_by = uid WHERE i.id = inv.id;
  user_id := uid;
  workspace_id := inv.workspace_id;
  created := fresh;
  RETURN NEXT;
END
$$;

-- The definer functions read invites, users and memberships across workspaces: policies for
-- ob_owner, the owner they run as (FORCE RLS applies to the owner too).
CREATE POLICY invites_definer ON app.invites TO ob_owner USING (true) WITH CHECK (true);
CREATE POLICY memberships_definer ON app.memberships TO ob_owner USING (true) WITH CHECK (true);
CREATE POLICY membership_tabs_definer ON app.membership_tabs TO ob_owner
  USING (true) WITH CHECK (true);
CREATE POLICY membership_companies_definer ON app.membership_companies TO ob_owner
  USING (true) WITH CHECK (true);
CREATE POLICY users_definer ON app.users TO ob_owner USING (true) WITH CHECK (true);
CREATE POLICY workspaces_definer_read ON app.workspaces FOR SELECT TO ob_owner USING (true);
CREATE POLICY companies_definer_read ON app.companies FOR SELECT TO ob_owner USING (true);

-- Failed sign-ins and lockouts (ADR-052): before any workspace is chosen, so per person (or per
-- email key when no account matched), never in a workspace's audit log. Platform-only reading
-- arrives with M05. Append-only; reached only through the definer below.
CREATE TABLE app.auth_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES app.users (id),
  action text NOT NULL CHECK (action IN ('auth.login_failed', 'auth.locked')),
  ip inet,
  detail jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL
);
CREATE INDEX auth_events_user ON app.auth_events (user_id, occurred_at DESC);
ALTER TABLE app.auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auth_events FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_events_definer_only ON app.auth_events TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.auth_events FROM PUBLIC, ob_tenant_rw;
CREATE TRIGGER auth_events_no_change BEFORE UPDATE OR DELETE ON app.auth_events
  FOR EACH ROW EXECUTE FUNCTION app.terms_acceptances_append_only();

CREATE FUNCTION app.auth_event_record(p_user uuid, p_action text, p_ip inet, p_detail jsonb,
                                      p_now timestamptz)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.auth_events (user_id, action, ip, detail, occurred_at)
    VALUES (p_user, p_action, p_ip, p_detail, p_now)
$$;

REVOKE ALL ON FUNCTION app.invite_find(bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.invite_accept(bytea, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_event_record(uuid, text, inet, jsonb, timestamptz) FROM PUBLIC;
-- Web only (ADR-051).
GRANT EXECUTE ON FUNCTION app.invite_find(bytea, timestamptz) TO ob_auth;
GRANT EXECUTE ON FUNCTION app.invite_accept(bytea, uuid, text, timestamptz) TO ob_auth;
GRANT EXECUTE ON FUNCTION app.auth_event_record(uuid, text, inet, jsonb, timestamptz) TO ob_auth;
