-- 0003 deletion service (T-0403, DEL-1 to DEL-3, invariant 10). Runs as vault_owner.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- A tombstone keeps the channel account of what it deleted, so a deletion certificate can count
-- per account (DEL-3). IDs only.
ALTER TABLE vault.tombstones ADD COLUMN channel_account_id uuid;

-- One row per call of the deletion service: when, which trigger, what scope and how many rows,
-- never a value (DEL-3). Append-only for the vault.
CREATE TABLE vault.deletion_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  at timestamptz NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('expiry', 'cancellation', 'erasure',
    'ebay_account_deletion', 'amazon_revocation', 'ebay_termination', 'workspace_closure')),
  scope_type text NOT NULL CHECK (scope_type IN ('expiry', 'subjects', 'refs', 'channel_account',
    'workspace')),
  records bigint NOT NULL CHECK (records >= 0),
  fields bigint NOT NULL CHECK (fields >= 0),
  index_entries bigint NOT NULL CHECK (index_entries >= 0)
);
CREATE INDEX deletion_runs_run ON vault.deletion_runs (workspace_id, run_id);
ALTER TABLE vault.deletion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.deletion_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_runs_workspace ON vault.deletion_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON vault.deletion_runs FROM vault_app;

-- Invariant 10: a hard DELETE is followed by VACUUM, which needs MAINTAIN (PostgreSQL 17+).
GRANT MAINTAIN ON vault.records, vault.record_fields, vault.blind_index TO vault_app;
-- Workspace closure removes the workspace's keys too, so nothing it held can ever be opened again.
GRANT DELETE ON vault.workspace_keys TO vault_app;
