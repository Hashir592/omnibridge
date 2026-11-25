-- 0055 validates 0054's NOT VALID rule (T-1004). Runs as ob_owner.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.orders VALIDATE CONSTRAINT orders_amounts_differ;
