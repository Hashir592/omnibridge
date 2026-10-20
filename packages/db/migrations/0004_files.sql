-- 0004 file metadata (T-0105, NFR-5, SEC-2). Runs as ob_owner.
-- The bytes live encrypted on the files volume under a random id (ADR-012); this row holds what
-- the app needs to serve them. No original filename is stored: it may hold personal data.
-- A file is readable only in state 'clean'; uploads start in 'scanning' (SEC-2, ADR-021).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.files (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  content_type text NOT NULL
    CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  key_version bigint NOT NULL CHECK (key_version >= 1),
  state text NOT NULL DEFAULT 'scanning'
    CHECK (state IN ('scanning', 'clean', 'infected', 'scan_failed')),
  scanned_at timestamptz,
  delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id)
);

ALTER TABLE app.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.files FORCE ROW LEVEL SECURITY;
CREATE POLICY files_tenant ON app.files
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
