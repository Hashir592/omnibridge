-- 0002 credential store for db-main (T-0103, SEC-6, INT-3). Runs as ob_owner.
-- Provider tokens are envelope-encrypted: each workspace has data keys (DEKs) wrapped by the
-- secrets master key (KEK), which lives only in a Docker secret, never here (ADR-014).
-- workspace_id gets its foreign key to the workspace table in T-0201, and channel_account_id to
-- channel accounts in M07 (expand migrations).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- One row per DEK version per workspace. wrapped_key is [0x01][kek version][nonce][key][tag].
CREATE TABLE app.data_keys (
  workspace_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 4294967295),
  kek_version bigint NOT NULL CHECK (kek_version BETWEEN 1 AND 4294967295),
  wrapped_key bytea NOT NULL CHECK (octet_length(wrapped_key) = 65),
  created_at timestamptz NOT NULL DEFAULT now(),
  rewrapped_at timestamptz,
  PRIMARY KEY (workspace_id, version)
);

ALTER TABLE app.data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY data_keys_tenant ON app.data_keys
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- A DEK is never deleted or replaced by the app (that would destroy data); KEK rotation may only
-- re-wrap it.
REVOKE DELETE, UPDATE ON app.data_keys FROM ob_app;
GRANT UPDATE (kek_version, wrapped_key, rewrapped_at) ON app.data_keys TO ob_app;

-- Credentials with current/next slots (AMZ-8, AMZ-10). An inactive row is kept until expires_at
-- and then hard-deleted by the purge.
CREATE TABLE app.credentials (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{1,63}$'),
  channel_account_id uuid,
  slot text NOT NULL CHECK (slot IN ('current', 'next')),
  encrypted_value bytea NOT NULL,
  key_version bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CONSTRAINT credentials_inactive_expire CHECK (is_active OR expires_at IS NOT NULL),
  CONSTRAINT credentials_data_key_fk FOREIGN KEY (workspace_id, key_version)
    REFERENCES app.data_keys (workspace_id, version)
);

-- At most one active credential per workspace, kind, account and slot.
CREATE UNIQUE INDEX credentials_one_active
  ON app.credentials (workspace_id, kind, channel_account_id, slot) NULLS NOT DISTINCT
  WHERE is_active;
CREATE INDEX credentials_purge ON app.credentials (workspace_id, expires_at) WHERE NOT is_active;

ALTER TABLE app.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credentials_tenant ON app.credentials
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
