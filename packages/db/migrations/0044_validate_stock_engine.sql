-- 0044 validates the listing stock rule 0043 added NOT VALID (T-0901). Runs as ob_owner, in its
-- own transaction so the check does not hold 0043's locks. Every row meets it: the new columns
-- start as auto with no manual quantity.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.listings VALIDATE CONSTRAINT listings_stock;
