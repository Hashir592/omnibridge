-- 0008 order ingest (T-1001: ORD-4, DEL-1, ADR-068, ADR-079 3). Runs as vault_owner.
--
-- A buyer deleted by an eBay account-deletion notice is never stored again: the notice leaves a
-- blind-index entry of the eBay user ID (or, when the notice has none, the username) per
-- workspace, under that workspace's index key, and ingest refuses a buyer that matches one.
-- One buyer record per order: the unique index is built CONCURRENTLY by 0009 (ADR-047).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE vault.deleted_buyers (
  workspace_id uuid NOT NULL,
  field text NOT NULL CHECK (field IN ('ebay_user_id', 'ebay_username')),
  mac bytea NOT NULL CHECK (octet_length(mac) = 32),
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, field, mac)
);
ALTER TABLE vault.deleted_buyers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.deleted_buyers FORCE ROW LEVEL SECURITY;
CREATE POLICY deleted_buyers_workspace ON vault.deleted_buyers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- Written once; workspace closure removes them with the workspace's keys.
REVOKE UPDATE ON vault.deleted_buyers FROM vault_app;
