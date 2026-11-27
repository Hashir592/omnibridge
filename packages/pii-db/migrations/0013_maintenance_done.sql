-- 0013 one-time vault maintenance (T-1101: F-M10-end-26, ORD-9). Runs as vault_owner. Expand only.
--
-- A vault job that must run once records here that it has finished, so a later start reads no
-- record again: today the name and match-key re-index of F-M10-end-15. A name and a time only.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE vault.maintenance_done (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$'),
  done_at timestamptz NOT NULL
);
-- Written once and read; never changed or removed by the vault (the baseline's default grants
-- give it all four).
REVOKE UPDATE, DELETE ON vault.maintenance_done FROM vault_app;
