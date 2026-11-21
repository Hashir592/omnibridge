-- 0038 validates the rules 0037 added NOT VALID (T-0701). Runs as ob_owner, in its own transaction
-- so the checks do not hold 0037's locks. Every row meets them: the provider list only grew, the
-- health columns are new, every credential got the default environment, and every credential's
-- account exists (accounts are archived, never deleted).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.channel_accounts VALIDATE CONSTRAINT channel_accounts_provider;
ALTER TABLE app.channel_accounts VALIDATE CONSTRAINT channel_accounts_health;
ALTER TABLE app.credentials VALIDATE CONSTRAINT credentials_environment;
ALTER TABLE app.credentials VALIDATE CONSTRAINT credentials_account_fk;
