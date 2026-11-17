-- 0023 drops the functions 0020 retired (T-0401, ADR-063). Runs as ob_owner. Contract step:
-- 0020 already revoked them from every role, the test that no role may call them passed, and no
-- app code names them (rollout-functions.test.ts). Must land before the first app deploy.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- waiver: replaced by auth_record_failure; ADR-063
-- squawk-ignore ban-drop-function
DROP FUNCTION app.auth_record_failure(bytea, inet, timestamptz);
-- waiver: replaced by auth_reset_allow; ADR-063
-- squawk-ignore ban-drop-function
DROP FUNCTION app.auth_reset_allow(bytea, inet, timestamptz);
-- waiver: replaced by auth_user_workspaces_modules; ADR-063
-- squawk-ignore ban-drop-function
DROP FUNCTION app.auth_user_workspaces(uuid);
