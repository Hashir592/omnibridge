-- 0011 vault-wide deleted buyers (T-1003: DEL-1, DEL-2, AT-10, EBAY-2, DP-6; PS-035, ADR-081 8).
-- Runs as vault_owner. Expand only: the previous vault keeps using vault.deleted_buyers (0008),
-- whose rows cannot be moved (MACs under workspace keys, no value kept); a later migration drops it.
--
-- An eBay deletion notice leaves one entry per identifier for the whole vault, so it also covers a
-- workspace that holds nothing yet. No workspace_id, so no workspace policy: an entry is a MAC under
-- a key of its own, and says nothing without it. Kept when a workspace closes.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- The vault's own keys, wrapped by the PII master key like every workspace key (invariant 9).
CREATE TABLE vault.vault_keys (
  kind text NOT NULL CHECK (kind = 'deleted_buyers'),
  version bigint NOT NULL CHECK (version > 0),
  kek_version bigint NOT NULL CHECK (kek_version > 0),
  wrapped bytea NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (kind, version)
);
REVOKE UPDATE, DELETE ON vault.vault_keys FROM vault_app;

CREATE TABLE vault.ebay_deleted_buyers (
  key_version bigint NOT NULL CHECK (key_version > 0),
  field text NOT NULL CHECK (field IN ('ebay_user_id', 'ebay_username')),
  mac bytea NOT NULL CHECK (octet_length(mac) = 32),
  -- When the account was closed, as the notice says (at most when it arrived): a username refuses
  -- the orders placed before it.
  noticed_at timestamptz NOT NULL,
  -- When the last notice arrived: the entry goes 180 days later.
  received_at timestamptz NOT NULL,
  PRIMARY KEY (key_version, field, mac)
);
CREATE INDEX ebay_deleted_buyers_received ON vault.ebay_deleted_buyers (received_at);
-- A repeat notice moves the dates; the vault deletes only through the purge below.
REVOKE UPDATE, DELETE ON vault.ebay_deleted_buyers FROM vault_app;
GRANT UPDATE (noticed_at, received_at) ON vault.ebay_deleted_buyers TO vault_app;

-- Deletes the entries past their 180 days and returns how many (no order placed before a notice
-- can be stored that late: PRD 7.3's 90 days). The cut-off is fixed here, never a parameter.
CREATE FUNCTION vault.purge_deleted_buyers() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM vault.ebay_deleted_buyers WHERE received_at < now() - interval '180 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION vault.purge_deleted_buyers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault.purge_deleted_buyers() TO vault_app;

-- The channel's time of the update a record's fields came with, so an older one never replaces it.
ALTER TABLE vault.records ADD COLUMN source_updated_at timestamptz;
GRANT UPDATE (source_updated_at) ON vault.records TO vault_app;
