-- 0027 validates the erasure request state rule 0026 added NOT VALID (T-0409, S5-20261118
-- hardening 7, ADR-068). Runs as ob_owner, in its own transaction so the check does not hold
-- 0026's locks. Every row meets it: 0026's own rule replaced the two it dropped.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.erasure_requests VALIDATE CONSTRAINT erasure_requests_states;
