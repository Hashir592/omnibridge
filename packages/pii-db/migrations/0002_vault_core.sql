-- 0002 vault core (T-0402, DP-4 to DP-7, ADR-007). Runs as vault_owner.
-- Buyer PII lives only here, one encrypted value per field. Every table is keyed by workspace and
-- bound to app.workspace_id by forced row-level security, the same rule as db-main (invariant 1),
-- so a pii_ref of another workspace is simply not there (404). No plaintext and no masked string
-- is ever stored; blind indexes are HMACs under a per-workspace index key.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Wrapped per-workspace keys: 'data' (AES-256-GCM field key) and 'index' (blind-index HMAC key),
-- both wrapped by the PII master key, which lives only in pii-vault's Docker secret (invariant 9).
CREATE TABLE vault.workspace_keys (
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('data', 'index')),
  version integer NOT NULL CHECK (version > 0),
  kek_version integer NOT NULL CHECK (kek_version > 0),
  wrapped bytea NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, kind, version)
);

-- One record per subject (an order's buyer, an eBay message, a feedback username). kind is the
-- DP-5 list only; subject refs and channel accounts are IDs, never PII.
CREATE TABLE vault.records (
  workspace_id uuid NOT NULL,
  pii_ref uuid NOT NULL DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('buyer_contact', 'ebay_message', 'ebay_feedback')),
  channel_account_id uuid,
  subject_type text NOT NULL CHECK (subject_type IN ('order', 'conversation', 'feedback')),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 200),
  data_key_version integer NOT NULL CHECK (data_key_version > 0),
  delete_after timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, pii_ref)
);
CREATE INDEX records_subject ON vault.records (workspace_id, subject_type, subject_id);
CREATE INDEX records_channel_account ON vault.records (workspace_id, channel_account_id);
CREATE INDEX records_delete_after ON vault.records (delete_after) WHERE delete_after IS NOT NULL;

-- One AES-256-GCM ciphertext per field; the AAD binds it to workspace, table, field and pii_ref.
CREATE TABLE vault.record_fields (
  workspace_id uuid NOT NULL,
  pii_ref uuid NOT NULL,
  field text NOT NULL CHECK (field IN (
    'name', 'email', 'phone', 'address_line1', 'address_line2', 'address_line3', 'city', 'county',
    'postcode', 'country', 'delivery_instructions', 'channel_buyer_id', 'channel_username',
    'message_body', 'sender_username', 'buyer_username')),
  ciphertext bytea NOT NULL,
  PRIMARY KEY (workspace_id, pii_ref, field),
  FOREIGN KEY (workspace_id, pii_ref) REFERENCES vault.records (workspace_id, pii_ref)
);

-- Blind indexes: HMAC-SHA256 of the normalised value (search: name, email, phone, postcode,
-- channel buyer; match: the same-buyer key of ORD-9).
CREATE TABLE vault.blind_index (
  workspace_id uuid NOT NULL,
  pii_ref uuid NOT NULL,
  field text NOT NULL CHECK (field IN ('name', 'email', 'phone', 'postcode', 'buyer', 'match')),
  mac bytea NOT NULL CHECK (octet_length(mac) = 32),
  key_version integer NOT NULL CHECK (key_version > 0),
  PRIMARY KEY (workspace_id, pii_ref, field),
  FOREIGN KEY (workspace_id, pii_ref) REFERENCES vault.records (workspace_id, pii_ref)
);
CREATE INDEX blind_index_lookup ON vault.blind_index (workspace_id, field, mac);

-- Deleted refs (DEL-2): applied again after any restore. IDs only.
CREATE TABLE vault.tombstones (
  workspace_id uuid NOT NULL,
  pii_ref uuid NOT NULL,
  run_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, pii_ref)
);

-- Every full read and search (DP-7): who, which capability, why, which record. Never a value.
CREATE TABLE vault.access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  at timestamptz NOT NULL,
  caller text NOT NULL CHECK (caller IN ('web', 'worker', 'deletion')),
  capability text NOT NULL CHECK (capability IN ('read_full', 'search', 'match', 'delete')),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z_]{1,40}$'),
  actor_user_id uuid,
  pii_ref uuid,
  result_count integer NOT NULL CHECK (result_count >= 0)
);
CREATE INDEX access_log_workspace ON vault.access_log (workspace_id, at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_keys', 'records', 'record_fields', 'blind_index', 'tombstones',
                           'access_log']
  LOOP
    EXECUTE format('ALTER TABLE vault.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE vault.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON vault.%I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) '
      'WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t || '_workspace', t);
  END LOOP;
END
$$;

-- Keys, tombstones and the access log are append-only for the vault; a record changes only its
-- expiry (DEL-1 callers move delete_after at dispatch or delivery).
REVOKE UPDATE, DELETE ON vault.workspace_keys, vault.tombstones, vault.access_log FROM vault_app;
REVOKE UPDATE ON vault.records FROM vault_app;
GRANT UPDATE (delete_after) ON vault.records TO vault_app;
