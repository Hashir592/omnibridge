-- 0014 label files (T-1201: SHIP-2, EVRI-5, DEL-1, invariant 11, FA-15). Runs as vault_owner.
-- Expand only: one new table.
--
-- A label file holds the buyer's name and address, so it is PII. The file itself lives in the
-- vault's own volume (pii_labels), encrypted under the workspace's data key, and is never backed
-- up. This row holds IDs, a size and a date only. A file goes at the earlier of 30 days or its
-- order's PII expiry: the expiry run deletes it with the record (LabelFiles), and deletes any
-- file whose own date has passed. After a restore these rows point at files that no longer
-- exist; the restore runbook empties the table (the files were never in the backup).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE vault.label_files (
  workspace_id uuid NOT NULL,
  -- The db-main shipment the label belongs to.
  label_id uuid NOT NULL,
  -- The buyer records on the label (one per order; several for Ship together).
  pii_refs uuid[] NOT NULL CHECK (cardinality(pii_refs) BETWEEN 1 AND 20),
  bytes bigint NOT NULL CHECK (bytes BETWEEN 1 AND 2097152),
  delete_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, label_id)
);
CREATE INDEX label_files_refs ON vault.label_files USING gin (pii_refs);
CREATE INDEX label_files_delete_after ON vault.label_files (workspace_id, delete_after);
ALTER TABLE vault.label_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.label_files FORCE ROW LEVEL SECURITY;
CREATE POLICY label_files_tenant ON vault.label_files
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- A label is stored once and never rewritten; it is only ever deleted.
REVOKE UPDATE ON vault.label_files FROM vault_app;
-- Invariant 10: a hard DELETE is followed by VACUUM, which needs MAINTAIN (PostgreSQL 17+).
GRANT MAINTAIN ON vault.label_files TO vault_app;
