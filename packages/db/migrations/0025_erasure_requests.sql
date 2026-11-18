-- 0025 erasure requests (T-0404, DEL-4). Runs as ob_owner. Expand only.
-- An admin enters a buyer's identifiers; the vault finds the matches and web keeps only their
-- refs here, never the identifiers or any value (invariant 7a, DP-8). Confirming queues one
-- deletion of those refs. Due one month after the request (DEL-4).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.erasure_requests (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  pii_refs uuid[] NOT NULL CHECK (cardinality(pii_refs) <= 5000),
  state text NOT NULL CHECK (state IN ('open', 'confirmed')),
  confirmed_by uuid,
  confirmed_at timestamptz,
  job_id uuid,
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CHECK ((state = 'open') = (confirmed_at IS NULL))
);
CREATE INDEX erasure_requests_due ON app.erasure_requests (workspace_id, state, due_at);

ALTER TABLE app.erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.erasure_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY erasure_requests_tenant ON app.erasure_requests
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- Admins only, in the database too (PERM-5, as for member writes in 0021).
CREATE POLICY erasure_requests_admin_insert ON app.erasure_requests AS RESTRICTIVE FOR INSERT
  TO ob_tenant_rw WITH CHECK (app.may_manage_members());
CREATE POLICY erasure_requests_admin_update ON app.erasure_requests AS RESTRICTIVE FOR UPDATE
  TO ob_tenant_rw USING (app.may_manage_members()) WITH CHECK (app.may_manage_members());
-- A request is kept as the record of what was done: never deleted; only its confirmation is set.
REVOKE UPDATE, DELETE, TRUNCATE ON app.erasure_requests FROM ob_tenant_rw;
GRANT UPDATE (state, confirmed_by, confirmed_at, job_id) ON app.erasure_requests TO ob_tenant_rw;
