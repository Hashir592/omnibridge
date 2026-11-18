-- 0005 erasure, eBay deletion and canaries (T-0404: DEL-4, DEL-5, AT-10, SEC-12). Runs as
-- vault_owner. Expand only.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- SEC-12: one synthetic record per workspace that no feature reads. It has no blind-index
-- entries, so no search or match can reach it; any read of it is a canary event.
ALTER TABLE vault.records ADD COLUMN canary boolean NOT NULL DEFAULT false;

CREATE TABLE vault.canary_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  pii_ref uuid NOT NULL,
  at timestamptz NOT NULL,
  caller text NOT NULL CHECK (caller IN ('web', 'worker', 'deletion')),
  capability text NOT NULL CHECK (capability IN ('read_full', 'mask')),
  actor_user_id uuid
);
CREATE INDEX canary_events_workspace ON vault.canary_events (workspace_id, at DESC);
ALTER TABLE vault.canary_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.canary_events FORCE ROW LEVEL SECURITY;
CREATE POLICY canary_events_workspace ON vault.canary_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON vault.canary_events FROM vault_app;

-- AT-10 (FA-14, PS-027, Hashir 18 Nov 2026): an eBay deletion notice names no workspace, so the vault
-- needs the list of workspaces that hold PII. IDs only, like db-main's workspace list. Anyone
-- with the vault's role may read the list; a row is written or removed only inside its own
-- workspace's transaction (ingest adds it, closure removes it).
CREATE TABLE vault.workspace_directory (
  workspace_id uuid PRIMARY KEY,
  added_at timestamptz NOT NULL
);
ALTER TABLE vault.workspace_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.workspace_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_directory_list ON vault.workspace_directory FOR SELECT USING (true);
CREATE POLICY workspace_directory_insert ON vault.workspace_directory FOR INSERT
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY workspace_directory_delete ON vault.workspace_directory FOR DELETE
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE ON vault.workspace_directory FROM vault_app;
