-- 0029 validates the erasure request state rule 0028 added NOT VALID (T-0410, ADR-069). Runs
-- as ob_owner, in its own transaction so the check does not hold 0028's locks. Every row meets
-- it: no row had an outcome before 0028.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.erasure_requests VALIDATE CONSTRAINT erasure_requests_outcome_states;
