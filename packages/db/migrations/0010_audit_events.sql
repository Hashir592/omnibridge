-- 0010 the append-only audit log (T-0202, AUD-1 to AUD-4). Runs as ob_owner.
-- Expand only: a new table that the previous app version never touches.
--
-- ob_app may INSERT and SELECT, nothing else. A trigger refuses UPDATE, DELETE and TRUNCATE for
-- every role, ob_owner included. The one exception is the retention purge: a SECURITY DEFINER
-- function owned by ob_owner that deletes events older than 6 years in the current workspace
-- (AUD-3, PRD default: everything kept 6 years). So retention runs as ob_owner without any
-- container holding ob_owner's password. Only ob_worker may call it (ADR-049): web, as ob_app,
-- cannot.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.audit_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  -- UTC, set by the database: the app cannot choose it (no column grant).
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system', 'platform')),
  -- The acting user. No foreign key: deleting a user must never be blocked by their history.
  user_id uuid CHECK ((actor_kind = 'system') = (user_id IS NULL)),
  action text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z_]+$'),
  entity_id text CHECK (char_length(entity_id) BETWEEN 1 AND 200),
  -- Catalogue fields only (packages/core audit-events, AUD-3); objects of scalars or lists.
  before jsonb CHECK (jsonb_typeof(before) = 'object' AND pg_column_size(before) <= 8192),
  after jsonb CHECK (jsonb_typeof(after) = 'object' AND pg_column_size(after) <= 8192),
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500),
  ip inet
);
-- Newest first, paged by (occurred_at, id); also serves date filters and the retention purge. No
-- global sequence: a cursor must never reveal how busy other workspaces are.
CREATE INDEX audit_events_list ON app.audit_events (workspace_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_entity ON app.audit_events (workspace_id, entity_type, entity_id);

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant ON app.audit_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

REVOKE ALL ON app.audit_events FROM ob_app;
GRANT SELECT ON app.audit_events TO ob_app;
GRANT INSERT (workspace_id, actor_kind, user_id, action, entity_type, entity_id, before, after,
              reason, ip)
  ON app.audit_events TO ob_app;

-- Nobody edits or deletes an event (AUD-4). Not SECURITY DEFINER: current_user is the caller,
-- which is ob_owner only inside the purge function below.
CREATE FUNCTION app.audit_events_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'ob_owner'
     AND current_setting('app.audit_purge', true) = 'on'
     AND OLD.occurred_at < now() - interval '6 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'app.audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'OBA01';
END
$$;
REVOKE ALL ON FUNCTION app.audit_events_append_only() FROM PUBLIC;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON app.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_events_append_only();

-- Retention (AUD-3): the only deletion path. Deletes the current workspace's events older than
-- 6 years and returns how many. Run by the audit.retention job in its tenant transaction. The
-- cut-off is fixed here, never a parameter.
CREATE FUNCTION app.purge_audit_events() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  workspace uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  deleted bigint;
BEGIN
  IF workspace IS NULL THEN
    RAISE EXCEPTION 'purge_audit_events needs app.workspace_id' USING ERRCODE = 'OBA01';
  END IF;
  PERFORM set_config('app.audit_purge', 'on', true);
  DELETE FROM app.audit_events e
   WHERE e.workspace_id = workspace AND e.occurred_at < now() - interval '6 years';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('app.audit_purge', '', true);
  RETURN deleted;
END
$$;
REVOKE ALL ON FUNCTION app.purge_audit_events() FROM PUBLIC;
-- ob_worker comes from the roles script, which runs only on an empty volume (ADR-049).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_worker') THEN
    RAISE EXCEPTION 'role ob_worker is missing: in dev, recreate the db-main volume '
      'so infra/compose/db-main/10-roles.sh runs again; elsewhere, create it as that script does';
  END IF;
END
$$;
GRANT EXECUTE ON FUNCTION app.purge_audit_events() TO ob_worker;
