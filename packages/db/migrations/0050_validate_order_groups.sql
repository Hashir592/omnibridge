-- 0050 validates 0049's NOT VALID rules (T-1002). Runs as ob_owner.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.orders VALIDATE CONSTRAINT orders_group_fk;
ALTER TABLE app.workspaces VALIDATE CONSTRAINT workspaces_group_grace;
