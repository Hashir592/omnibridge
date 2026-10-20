-- 0005 split app.credentials.expires_at (F-M01-halfway-04, ADR-045). Runs as ob_owner.
-- expires_at is now only the provider's expiry; delete_after is when the purge hard-deletes a
-- retired (inactive) row. app.credentials holds no rows yet (nothing is deployed, ADR-029, and
-- M07 stores the first credential), so no backfill is needed.
--
-- Expand: the new column and its rule. NOT VALID checks every new or updated row; there are no
-- old rows to validate.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.credentials ADD COLUMN IF NOT EXISTS delete_after timestamptz;

ALTER TABLE app.credentials
  ADD CONSTRAINT credentials_inactive_delete_after
  CHECK (is_active OR delete_after IS NOT NULL) NOT VALID;

-- Contract: the old rule tied retirement to expires_at, which a retired refresh token with no
-- provider expiry cannot meet. It is replaced by credentials_inactive_delete_after above.
-- waiver: replaced by credentials_inactive_delete_after; F-M01-halfway-04
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.credentials DROP CONSTRAINT IF EXISTS credentials_inactive_expire;
