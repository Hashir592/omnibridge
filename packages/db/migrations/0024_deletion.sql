-- 0024 deletion service, db-main half (T-0403, DEL-1 to DEL-3, invariant 10). Runs as ob_owner.
-- The vault deletes the PII; db-main keeps what may be kept: the run log and the tombstones, IDs
-- and counts only, never a value.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- DEL-3: one row per deletion run: time, trigger, scope (counts and IDs), result.
CREATE TABLE app.deletion_runs (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('expiry', 'cancellation', 'erasure',
    'ebay_account_deletion', 'amazon_revocation', 'ebay_termination', 'workspace_closure')),
  scope_type text NOT NULL CHECK (scope_type IN ('expiry', 'subjects', 'refs', 'channel_account',
    'workspace')),
  -- The scope's own IDs (subject ids, a channel account): never PII (invariant 7a).
  scope jsonb NOT NULL,
  channel_account_id uuid,
  records_deleted bigint NOT NULL CHECK (records_deleted >= 0),
  result text NOT NULL CHECK (result IN ('done')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id)
);
CREATE INDEX deletion_runs_account ON app.deletion_runs (workspace_id, channel_account_id, finished_at);

-- Invariant 10: the db-main copy of every tombstone (the others: db-pii and the off-site journal).
-- Applied again after any restore (T-0405).
CREATE TABLE app.pii_tombstones (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  pii_ref uuid NOT NULL,
  run_id uuid NOT NULL,
  channel_account_id uuid,
  deleted_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, pii_ref),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.deletion_runs (workspace_id, id)
);
CREATE INDEX pii_tombstones_account ON app.pii_tombstones (workspace_id, channel_account_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deletion_runs', 'pii_tombstones']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) '
      'WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t || '_tenant', t);
    -- Append-only for the app: a record of a deletion is never changed or removed.
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON app.%I FROM ob_tenant_rw', t);
  END LOOP;
END
$$;

-- ADR-058(b): a person's terms acceptances are their personal data and go with them. The table
-- stays append-only for everyone else; only this definer, for a person with no membership left,
-- may delete their rows.
CREATE OR REPLACE FUNCTION app.terms_acceptances_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.deleting_user', true) = OLD.user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'terms acceptances are append-only' USING ERRCODE = '42501';
END
$$;

CREATE FUNCTION app.user_terms_delete(p_user uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  -- The memberships_auth_user policy shows the owner this person's rows in any workspace.
  PERFORM set_config('app.auth_user_id', p_user::text, true);
  IF EXISTS (SELECT 1 FROM app.memberships m WHERE m.user_id = p_user) THEN
    RAISE EXCEPTION 'the person still belongs to a workspace' USING ERRCODE = 'OBA02';
  END IF;
  PERFORM set_config('app.deleting_user', p_user::text, true);
  DELETE FROM app.terms_acceptances t WHERE t.user_id = p_user;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.deleting_user', '', true);
  PERFORM set_config('app.auth_user_id', '', true);
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION app.user_terms_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_terms_delete(uuid) TO ob_worker;
