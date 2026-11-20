-- 0034 app secrets store (T-0505: PLAT-4; SEC-5, SEC-6, AMZ-10). Runs as ob_owner. Expand only.
--
-- The app-level secrets of OmniBridge itself (Amazon LWA and Ads client credentials, the eBay
-- keyset, verification tokens): set only from the platform console, never shown back. Each value
-- is AES-256-GCM ciphertext under the platform data key (0011 app.platform_keys), which the
-- secrets master key wraps (envelope encryption, ARCHITECTURE 6.7); the master key is a Docker
-- secret of web and worker only. `current` and `next` slots hold Amazon's 7-day overlap (AMZ-10).
-- A slot is overwritten in place: no old value is kept. Not tenant data, so no workspace_id; the
-- table is reached only through the definers below.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.app_secrets (
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND char_length(name) <= 64),
  slot text NOT NULL CHECK (slot IN ('current', 'next')),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 30 AND 20000),
  key_version bigint NOT NULL CHECK (key_version >= 1),
  set_at timestamptz NOT NULL,
  set_by uuid NOT NULL REFERENCES app.users (id),
  PRIMARY KEY (name, slot)
);
ALTER TABLE app.app_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.app_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY app_secrets_definer_only ON app.app_secrets TO ob_owner USING (true) WITH CHECK (true);
REVOKE ALL ON app.app_secrets FROM PUBLIC, ob_tenant_rw;

-- Sets one slot (PLAT-4), for a platform admin with MFA only. The audit row, in the same
-- transaction, holds the name and slot, never the value.
CREATE FUNCTION app.app_secret_put(p_user uuid, p_name text, p_slot text, p_ciphertext bytea,
                                   p_key_version bigint, p_now timestamptz, p_ip inet)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  INSERT INTO app.app_secrets (name, slot, ciphertext, key_version, set_at, set_by)
    VALUES (p_name, p_slot, p_ciphertext, p_key_version, p_now, p_user)
  ON CONFLICT (name, slot) DO UPDATE
    SET ciphertext = excluded.ciphertext, key_version = excluded.key_version,
        set_at = excluded.set_at, set_by = excluded.set_by;
  INSERT INTO app.platform_audit_events (occurred_at, user_id, action, params, ip)
    VALUES (p_now, p_user, 'app_secret.set', jsonb_build_object('name', p_name, 'slot', p_slot),
            p_ip);
END
$$;

-- Names, slots and set-on dates only (PLAT-4: never a value).
CREATE FUNCTION app.app_secret_list(p_user uuid)
  RETURNS TABLE (name text, slot text, set_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  RETURN QUERY SELECT s.name, s.slot, s.set_at FROM app.app_secrets s ORDER BY s.name, s.slot;
END
$$;

-- Promotes `next` to `current` (AMZ-10 overlap): the old current value is deleted. False when
-- there is no next value. Audited, name only.
CREATE FUNCTION app.app_secret_promote(p_user uuid, p_name text, p_now timestamptz, p_ip inet)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app.console_require(p_user);
  PERFORM 1 FROM app.app_secrets s WHERE s.name = p_name FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.app_secrets s WHERE s.name = p_name AND s.slot = 'next') THEN
    RETURN false;
  END IF;
  DELETE FROM app.app_secrets s WHERE s.name = p_name AND s.slot = 'current';
  UPDATE app.app_secrets s SET slot = 'current' WHERE s.name = p_name AND s.slot = 'next';
  INSERT INTO app.platform_audit_events (occurred_at, user_id, action, params, ip)
    VALUES (p_now, p_user, 'app_secret.promoted', jsonb_build_object('name', p_name), p_ip);
  RETURN true;
END
$$;

-- The ciphertext of one slot, for the typed reader in the worker (provider calls) and web (the
-- OAuth code exchange only). Useless without the secrets master key.
CREATE FUNCTION app.app_secret_read(p_name text, p_slot text)
  RETURNS TABLE (ciphertext bytea, key_version bigint, set_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.ciphertext, s.key_version, s.set_at FROM app.app_secrets s
   WHERE s.name = p_name AND s.slot = p_slot
$$;

REVOKE ALL ON FUNCTION
  app.app_secret_put(uuid, text, text, bytea, bigint, timestamptz, inet),
  app.app_secret_list(uuid),
  app.app_secret_promote(uuid, text, timestamptz, inet),
  app.app_secret_read(text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.app_secret_put(uuid, text, text, bytea, bigint, timestamptz, inet),
  app.app_secret_list(uuid),
  app.app_secret_promote(uuid, text, timestamptz, inet)
  TO ob_auth;
GRANT EXECUTE ON FUNCTION app.app_secret_read(text, text) TO ob_tenant_rw;
-- The worker opens app secrets with the platform data key (it never makes one: web does).
GRANT EXECUTE ON FUNCTION app.platform_key_get(bigint) TO ob_worker;
