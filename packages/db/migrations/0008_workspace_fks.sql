-- 0008 workspace foreign keys on the M01 tables (T-0201, TEN-1, invariant 1). Runs as ob_owner.
-- M01 created these tables before app.workspaces existed. Expand: each key is added NOT VALID,
-- so it checks every new or changed row at once without scanning old ones; 0009 validates them.
-- The tables hold no rows yet (nothing is deployed, ADR-029).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.data_keys
  ADD CONSTRAINT data_keys_workspace_fk FOREIGN KEY (workspace_id)
  REFERENCES app.workspaces (id) NOT VALID;
ALTER TABLE app.credentials
  ADD CONSTRAINT credentials_workspace_fk FOREIGN KEY (workspace_id)
  REFERENCES app.workspaces (id) NOT VALID;
ALTER TABLE app.job_records
  ADD CONSTRAINT job_records_workspace_fk FOREIGN KEY (workspace_id)
  REFERENCES app.workspaces (id) NOT VALID;
ALTER TABLE app.job_leases
  ADD CONSTRAINT job_leases_workspace_fk FOREIGN KEY (workspace_id)
  REFERENCES app.workspaces (id) NOT VALID;
ALTER TABLE app.files
  ADD CONSTRAINT files_workspace_fk FOREIGN KEY (workspace_id)
  REFERENCES app.workspaces (id) NOT VALID;
