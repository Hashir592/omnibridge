-- 0036 validates the auth_events action rule 0035 added NOT VALID (T-0507). Runs as ob_owner, in
-- its own transaction so the check does not hold 0035's locks. Every row meets it: the new rule
-- is the old one plus auth.login.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.auth_events VALIDATE CONSTRAINT auth_events_action;
