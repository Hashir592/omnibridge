-- 0006 exact channel buyer index (T-0407, ADR-066: AT-10, DEL-1). Runs as vault_owner.
-- An eBay deletion notice cannot be undone, so it matches channel buyer IDs and usernames
-- exactly: a new blind-index field `buyer_exact` (trim only, never case-folded). The `buyer`
-- field stays case-folded for the DEL-4 erasure search. The previous vault never writes
-- `buyer_exact`, so it keeps working while this runs (expand/contract, ADR-045).
-- Existing records get their entry from the vault's start-up backfill (dev data only today).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Expand: the new list of fields. NOT VALID checks every new or updated row and takes no long
-- lock; every old row already meets it, because the list only grows (as in db-main 0005).
ALTER TABLE vault.blind_index
  ADD CONSTRAINT blind_index_fields
  CHECK (field IN ('name', 'email', 'phone', 'postcode', 'buyer', 'buyer_exact', 'match')) NOT VALID;

-- Contract: the old inline list from 0002 would refuse `buyer_exact`; it is replaced by
-- blind_index_fields above.
-- waiver: replaced by blind_index_fields; ADR-066
-- squawk-ignore ban-drop-constraint
ALTER TABLE vault.blind_index DROP CONSTRAINT IF EXISTS blind_index_field_check;
