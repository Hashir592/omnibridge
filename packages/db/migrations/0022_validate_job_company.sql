-- 0022 validates the job company key 0021 added NOT VALID (T-0401, F-M02e-03). Runs as ob_owner,
-- in its own transaction so the check does not hold 0021's locks.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.job_records VALIDATE CONSTRAINT job_records_company;
