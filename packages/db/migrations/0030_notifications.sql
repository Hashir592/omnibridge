-- 0030 notification centre core (T-0501: NTF-1, NTF-2, NTF-5). Runs as ob_owner. Expand only.
--
-- One notification per (type, linked record) in a workspace, updated in place (NTF-5). It holds
-- IDs, counts and codes only, never buyer PII (invariant 7): no free text is stored, and the
-- title comes from the type registry in @omnibridge/core. Who sees a row is worked out when it is
-- read (NTF-2): admins see every row; a child sees rows of a tab they have ticked, and RLS keeps
-- rows of companies outside their ticks away from them. Read state is per user and per version:
-- a severity rise or a reopen bumps `version`, so everyone sees it unread again.
--
-- Platform-level notices (NTF-2: to platform admins) have no workspace. Like app.auth_events they
-- are reached only through the definer functions below: web and worker may raise and resolve
-- them; only web's auth group may read them, and only for a user who is a platform admin.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.notification_severity_rank(p_severity text)
  RETURNS int
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_severity WHEN 'info' THEN 1 WHEN 'warning' THEN 2 WHEN 'critical' THEN 3 END
$$;
GRANT EXECUTE ON FUNCTION app.notification_severity_rank(text) TO ob_tenant_rw;

CREATE TABLE app.notifications (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND char_length(type) <= 64),
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  signal text CHECK (signal IN ('native', 'derived', 'estimate')),
  -- The tab the linked record belongs to: a child sees the row only with this tab ticked.
  tab text NOT NULL CHECK (tab IN ('home', 'orders', 'shipping', 'stock-catalogue',
    'customer-service', 'account-health', 'advertising', 'sales-profit', 'forecasting',
    'finance', 'reminders', 'notes', 'connections', 'users', 'settings', 'audit-log')),
  company_id uuid,
  channel_account_id uuid,
  record_kind text NOT NULL CHECK (record_kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  record_id text NOT NULL CHECK (record_id ~ '^[0-9a-zA-Z:._-]{1,64}$'),
  -- IDs, counts and flags only (checked by the core registry before anything is written).
  params jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CONSTRAINT notifications_one_per_record UNIQUE (workspace_id, type, record_kind, record_id),
  CONSTRAINT notifications_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id),
  CONSTRAINT notifications_channel_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
CREATE INDEX notifications_recent ON app.notifications (workspace_id, updated_at DESC, id DESC);

-- A row says this user has read this version of the notification. No row, or an older version,
-- is unread.
CREATE TABLE app.notification_reads (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  notification_id uuid NOT NULL,
  user_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  read_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, notification_id, user_id),
  FOREIGN KEY (workspace_id, notification_id) REFERENCES app.notifications (workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES app.memberships (workspace_id, user_id)
    ON DELETE CASCADE
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_reads']
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
-- A request sees only notifications of its permitted companies (PERM-3, invariant 5); a row of no
-- company is workspace-wide. The worker raises for any company of its workspace.
CREATE POLICY notifications_company_scope ON app.notifications AS RESTRICTIVE TO ob_app
  USING (company_id IS NULL
         OR company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                       '{}'::uuid[])))
  WITH CHECK (company_id IS NULL
         OR company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                       '{}'::uuid[])));
-- A request reads and writes only its own user's read marks.
CREATE POLICY notification_reads_own ON app.notification_reads AS RESTRICTIVE TO ob_app
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
-- A notification is kept as the record of what happened: resolved, never deleted here.
REVOKE DELETE, TRUNCATE ON app.notifications FROM ob_tenant_rw;
REVOKE UPDATE ON app.notifications FROM ob_tenant_rw;
GRANT UPDATE (severity, signal, company_id, channel_account_id, params, updated_at, resolved_at,
              version) ON app.notifications TO ob_tenant_rw;
REVOKE DELETE, TRUNCATE ON app.notification_reads FROM ob_tenant_rw;

-- Platform-level notices (NTF-2): no workspace, platform admins only.
CREATE TABLE app.platform_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND char_length(type) <= 64),
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  signal text CHECK (signal IN ('native', 'derived', 'estimate')),
  record_kind text NOT NULL CHECK (record_kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  record_id text NOT NULL CHECK (record_id ~ '^[0-9a-zA-Z:._-]{1,64}$'),
  params jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT platform_notifications_one_per_record UNIQUE (type, record_kind, record_id)
);
CREATE INDEX platform_notifications_recent ON app.platform_notifications (updated_at DESC, id DESC);

CREATE TABLE app.platform_notification_reads (
  notification_id uuid NOT NULL REFERENCES app.platform_notifications (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version >= 1),
  read_at timestamptz NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_notifications', 'platform_notification_reads']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON app.%I TO ob_owner USING (true) WITH CHECK (true)',
                   t || '_definer_only', t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, ob_tenant_rw', t);
  END LOOP;
END
$$;

-- Raise or update a platform notice in place (NTF-5). `created`, `escalated` (severity rose) and
-- `reopened` (it had been resolved) tell the caller whether to email (T-0502).
CREATE FUNCTION app.platform_notice_raise(p_type text, p_severity text, p_signal text,
                                          p_record_kind text, p_record_id text, p_params jsonb,
                                          p_now timestamptz)
  RETURNS TABLE (id uuid, version bigint, created boolean, escalated boolean, reopened boolean)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.platform_notifications AS n
         (type, severity, signal, record_kind, record_id, params, created_at, updated_at)
  VALUES (p_type, p_severity, p_signal, p_record_kind, p_record_id, p_params, p_now, p_now)
  ON CONFLICT (type, record_kind, record_id) DO UPDATE
    SET severity = excluded.severity,
        signal = excluded.signal,
        params = excluded.params,
        updated_at = excluded.updated_at,
        resolved_at = NULL,
        version = n.version + CASE
          WHEN n.resolved_at IS NOT NULL
            OR app.notification_severity_rank(excluded.severity)
               > app.notification_severity_rank(n.severity) THEN 1
          ELSE 0 END
  RETURNING new.id, new.version, old.id IS NULL,
            old.id IS NOT NULL AND app.notification_severity_rank(new.severity)
                                   > app.notification_severity_rank(old.severity),
            coalesce(old.resolved_at IS NOT NULL, false)
$$;

CREATE FUNCTION app.platform_notice_resolve(p_type text, p_record_kind text, p_record_id text,
                                            p_now timestamptz)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH done AS (
    UPDATE app.platform_notifications SET resolved_at = p_now
     WHERE type = p_type AND record_kind = p_record_kind AND record_id = p_record_id
       AND resolved_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM done)
$$;

-- Reading: only for a platform admin (anyone else gets nothing back). app.users is read the way
-- the auth definers read it (0011 users_auth_lookup): one user, named in a local setting.
CREATE FUNCTION app.notice_reader_is_platform_admin(p_user uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.auth_user_id', true);
  ok boolean;
BEGIN
  PERFORM set_config('app.auth_user_id', coalesce(p_user::text, ''), true);
  SELECT coalesce((SELECT u.platform_admin FROM app.users u WHERE u.id = p_user), false) INTO ok;
  PERFORM set_config('app.auth_user_id', coalesce(previous, ''), true);
  RETURN ok;
END
$$;
REVOKE ALL ON FUNCTION app.notice_reader_is_platform_admin(uuid) FROM PUBLIC;

CREATE FUNCTION app.platform_notice_list(p_user uuid, p_state text, p_severity text,
                                         p_after_at timestamptz, p_after_id uuid, p_limit int)
  RETURNS TABLE (id uuid, type text, severity text, signal text, record_kind text,
                 record_id text, params jsonb, created_at timestamptz, updated_at timestamptz,
                 resolved_at timestamptz, read boolean)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT n.id, n.type, n.severity, n.signal, n.record_kind, n.record_id, n.params, n.created_at,
         n.updated_at, n.resolved_at, (r.version IS NOT NULL AND r.version >= n.version)
    FROM app.platform_notifications n
    LEFT JOIN app.platform_notification_reads r ON r.notification_id = n.id AND r.user_id = p_user
   WHERE app.notice_reader_is_platform_admin(p_user)
     AND (p_severity IS NULL OR n.severity = p_severity)
     AND (p_state IS NULL
          OR (p_state = 'resolved' AND n.resolved_at IS NOT NULL)
          OR (p_state = 'read' AND n.resolved_at IS NULL
              AND r.version IS NOT NULL AND r.version >= n.version)
          OR (p_state = 'unread' AND n.resolved_at IS NULL
              AND (r.version IS NULL OR r.version < n.version)))
     AND (p_after_at IS NULL OR (n.updated_at, n.id) < (p_after_at, p_after_id))
   ORDER BY n.updated_at DESC, n.id DESC
   LIMIT least(greatest(p_limit, 1), 201)
$$;

CREATE FUNCTION app.platform_notice_unread_count(p_user uuid)
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT count(*)
    FROM app.platform_notifications n
    LEFT JOIN app.platform_notification_reads r ON r.notification_id = n.id AND r.user_id = p_user
   WHERE app.notice_reader_is_platform_admin(p_user)
     AND n.resolved_at IS NULL
     AND (r.version IS NULL OR r.version < n.version)
$$;

-- Marks one notice (p_id) or, with p_id NULL, every open notice read at its current version.
-- Returns how many were marked; 0 for an unknown id or a user who is not a platform admin.
CREATE FUNCTION app.platform_notice_mark_read(p_user uuid, p_id uuid, p_now timestamptz)
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH marked AS (
    INSERT INTO app.platform_notification_reads AS r (notification_id, user_id, version, read_at)
    SELECT n.id, p_user, n.version, p_now
      FROM app.platform_notifications n
     WHERE app.notice_reader_is_platform_admin(p_user)
       AND (p_id IS NULL OR n.id = p_id)
       AND (p_id IS NOT NULL OR n.resolved_at IS NULL)
    ON CONFLICT (notification_id, user_id) DO UPDATE
      SET version = excluded.version, read_at = excluded.read_at
    RETURNING 1)
  SELECT count(*) FROM marked
$$;

REVOKE ALL ON FUNCTION app.platform_notice_raise(text, text, text, text, text, jsonb, timestamptz),
  app.platform_notice_resolve(text, text, text, timestamptz),
  app.platform_notice_list(uuid, text, text, timestamptz, uuid, int),
  app.platform_notice_unread_count(uuid),
  app.platform_notice_mark_read(uuid, uuid, timestamptz) FROM PUBLIC;
-- Web and worker raise and resolve (a canary read, a throttled eBay key).
GRANT EXECUTE ON FUNCTION app.platform_notice_raise(text, text, text, text, text, jsonb, timestamptz),
  app.platform_notice_resolve(text, text, text, timestamptz) TO ob_tenant_rw;
-- Only web's auth group reads them, for the signed-in platform admin.
GRANT EXECUTE ON FUNCTION app.platform_notice_list(uuid, text, text, timestamptz, uuid, int),
  app.platform_notice_unread_count(uuid),
  app.platform_notice_mark_read(uuid, uuid, timestamptz) TO ob_auth;
