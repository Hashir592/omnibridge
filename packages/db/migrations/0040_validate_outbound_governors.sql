-- 0040 validates the platform settings rules 0039 added NOT VALID (T-0702). Runs as ob_owner, in
-- its own transaction so the checks do not hold 0039's locks. Every row meets them: the rules are
-- the 0033 ones plus the maintenance key.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.platform_settings VALIDATE CONSTRAINT platform_settings_key;
ALTER TABLE app.platform_settings VALIDATE CONSTRAINT platform_settings_value;
