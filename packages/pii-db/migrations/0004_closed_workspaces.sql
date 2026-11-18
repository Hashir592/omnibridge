-- 0004 closed workspaces (F-M04h-04, ADR-065, DP-5, invariant 7). Runs as vault_owner.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Workspace closure deletes a workspace's records and keys and leaves this marker, so the vault
-- refuses any later ingest for it (409) instead of quietly making new keys. IDs and a time only.
CREATE TABLE vault.closed_workspaces (
  workspace_id uuid PRIMARY KEY,
  closed_at timestamptz NOT NULL
);
ALTER TABLE vault.closed_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.closed_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY closed_workspaces_workspace ON vault.closed_workspaces
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- Append-only for the vault: a closed workspace stays closed.
REVOKE UPDATE, DELETE ON vault.closed_workspaces FROM vault_app;
