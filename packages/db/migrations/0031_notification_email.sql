-- 0031 email alerts and per-type preferences (T-0502: NTF-3, NTF-4, MAIL-3). Runs as ob_owner.
-- Expand only.
--
-- Each member chooses email on or off per notification type (NTF-4). No row means the default:
-- on for types that can be critical, off for the rest (the app passes the list of types that
-- default to on). An admin
-- can never switch a critical type off; the server refuses it, and the recipient rule below
-- still emails every admin about a critical notification whatever their row says.
--
-- An email is a job per recipient (IDs only, invariant 7a). `notification_emails` records each one
-- sent, per notification version, so a retried job never sends it twice and a plain re-raise
-- (same version) never sends again (NTF-5).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.notification_email_prefs (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  user_id uuid NOT NULL,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND char_length(type) <= 64),
  email boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id, type),
  FOREIGN KEY (workspace_id, user_id) REFERENCES app.memberships (workspace_id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE app.notification_emails (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  notification_id uuid NOT NULL,
  user_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, notification_id, user_id, version),
  FOREIGN KEY (workspace_id, notification_id) REFERENCES app.notifications (workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES app.memberships (workspace_id, user_id)
    ON DELETE CASCADE
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_email_prefs', 'notification_emails']
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
-- A request reads and writes only its own user's preferences.
CREATE POLICY notification_email_prefs_own ON app.notification_email_prefs AS RESTRICTIVE TO ob_app
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
-- A sent record is written once (by the email job) and never changed.
REVOKE UPDATE, DELETE, TRUNCATE ON app.notification_emails FROM ob_tenant_rw;

-- NTF-2, NTF-4: who gets an email about this notification in the current workspace. Every admin
-- for a critical one; otherwise members who can see it (admins, or children whose ticked tabs
-- and companies cover it) and whose preference for its type is on (on when they have none and
-- the type is in `p_default_on`). A definer, so a child's request that raises sees the full list, not its own scope.
CREATE FUNCTION app.notification_email_recipients(p_notification uuid, p_default_on text[])
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.user_id
    FROM app.notifications n
    JOIN app.memberships m ON m.workspace_id = n.workspace_id
    LEFT JOIN app.notification_email_prefs p
      ON p.workspace_id = m.workspace_id AND p.user_id = m.user_id AND p.type = n.type
   WHERE n.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
     AND n.id = p_notification
     AND n.resolved_at IS NULL
     AND (m.role = 'admin'
          OR (EXISTS (SELECT 1 FROM app.membership_tabs t
                       WHERE t.workspace_id = m.workspace_id AND t.user_id = m.user_id
                         AND t.tab = n.tab)
              AND (n.company_id IS NULL
                   OR EXISTS (SELECT 1 FROM app.membership_companies c
                               WHERE c.workspace_id = m.workspace_id AND c.user_id = m.user_id
                                 AND c.company_id = n.company_id))))
     AND ((m.role = 'admin' AND n.severity = 'critical') OR coalesce(p.email, n.type = ANY (p_default_on)))
   ORDER BY m.user_id
$$;
REVOKE ALL ON FUNCTION app.notification_email_recipients(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notification_email_recipients(uuid, text[]) TO ob_tenant_rw;

-- Platform notices (NTF-2): a critical one is emailed to every platform admin, once per version.
-- The worker's minute sweep reads what is still to send and records each email it sent.
CREATE TABLE app.platform_notification_emails (
  notification_id uuid NOT NULL REFERENCES app.platform_notifications (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version >= 1),
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (notification_id, user_id, version)
);
ALTER TABLE app.platform_notification_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_notification_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_notification_emails_definer_only ON app.platform_notification_emails
  TO ob_owner USING (true) WITH CHECK (true);
REVOKE ALL ON app.platform_notification_emails FROM PUBLIC, ob_tenant_rw;

-- The definer below may list platform admins (their id, name and address), and only while it
-- runs: it turns this local setting on and off around its one query.
CREATE POLICY users_platform_admins_for_notices ON app.users FOR SELECT TO ob_owner
  USING (platform_admin AND current_setting('app.platform_notice_mail', true) = 'on');

CREATE FUNCTION app.platform_notice_pending_emails(p_limit int)
  RETURNS TABLE (notification_id uuid, version bigint, type text, severity text, user_id uuid,
                 email text, name text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.platform_notice_mail', 'on', true);
  RETURN QUERY
    SELECT n.id, n.version, n.type, n.severity, u.id, u.email, u.name
      FROM app.platform_notifications n
      CROSS JOIN app.users u
     WHERE u.platform_admin
       AND n.resolved_at IS NULL
       AND n.severity = 'critical'
       AND NOT EXISTS (SELECT 1 FROM app.platform_notification_emails e
                        WHERE e.notification_id = n.id AND e.user_id = u.id
                          AND e.version = n.version)
     ORDER BY n.updated_at, n.id, u.id
     LIMIT least(greatest(p_limit, 1), 500);
  PERFORM set_config('app.platform_notice_mail', '', true);
END
$$;

CREATE FUNCTION app.platform_notice_email_sent(p_notification uuid, p_user uuid, p_version bigint,
                                               p_now timestamptz)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.platform_notification_emails (notification_id, user_id, version, sent_at)
  VALUES (p_notification, p_user, p_version, p_now)
  ON CONFLICT DO NOTHING
$$;

REVOKE ALL ON FUNCTION app.platform_notice_pending_emails(int),
  app.platform_notice_email_sent(uuid, uuid, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_notice_pending_emails(int),
  app.platform_notice_email_sent(uuid, uuid, bigint, timestamptz) TO ob_worker;
