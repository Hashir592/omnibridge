-- 0009 validate the workspace foreign keys of 0008 (T-0201, TEN-1, invariant 1). Runs as ob_owner.
-- Contract: VALIDATE scans the existing rows under a SHARE UPDATE EXCLUSIVE lock, which does not
-- block reads or writes.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.data_keys VALIDATE CONSTRAINT data_keys_workspace_fk;
ALTER TABLE app.credentials VALIDATE CONSTRAINT credentials_workspace_fk;
ALTER TABLE app.job_records VALIDATE CONSTRAINT job_records_workspace_fk;
ALTER TABLE app.job_leases VALIDATE CONSTRAINT job_leases_workspace_fk;
ALTER TABLE app.files VALIDATE CONSTRAINT files_workspace_fk;
