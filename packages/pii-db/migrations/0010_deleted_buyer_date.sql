-- 0010 a repeat eBay notice moves a deleted buyer's date forward (T-1001 fixes: DEL-1, AT-10,
-- ADR-068). Runs as vault_owner. A username can be reused, and its new owner's account deleted too.
-- The date is the only column the vault may change; the previous version never updates it.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

GRANT UPDATE (created_at) ON vault.deleted_buyers TO vault_app;
