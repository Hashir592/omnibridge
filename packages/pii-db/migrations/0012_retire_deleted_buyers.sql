-- 0012 retire vault.deleted_buyers (T-1004: DEL-1; ADR-085 2, PS-037). Runs as vault_owner.
--
-- No vault code has read or written this table since T-1003 (#167); its entries live in
-- vault.ebay_deleted_buyers (0011). It is retired, not dropped: every role loses every right on it,
-- the owner included, so nothing can use it while it waits. M22's first db-pii migration drops it,
-- with ADR-045's ban-drop-table waiver.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

REVOKE ALL ON TABLE vault.deleted_buyers FROM PUBLIC, vault_app, vault_owner;
