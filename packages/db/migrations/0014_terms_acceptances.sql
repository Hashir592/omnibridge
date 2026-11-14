-- 0014 terms and privacy policy acceptance (WWW-7, T-0603). Runs as ob_owner. Expand only.
--
-- A user accepts the current terms and privacy policy at sign-in, and again after a material
-- change (a new version). Acceptance belongs to the person, not to a workspace, and happens
-- before a workspace is chosen, so it is logged here, per user, like the other user-level auth
-- records (ADR-052: an admin of one workspace never sees a user's activity in another). The log
-- is append-only: a row is never changed or removed. Reached only through the definers below.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.terms_acceptances (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users (id),
  version text NOT NULL CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  accepted_at timestamptz NOT NULL,
  ip inet,
  UNIQUE (user_id, version)
);

ALTER TABLE app.terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.terms_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY terms_acceptances_definer_only ON app.terms_acceptances TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.terms_acceptances FROM PUBLIC;

-- Append-only, for every role.
CREATE FUNCTION app.terms_acceptances_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'terms acceptances are append-only' USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION app.terms_acceptances_append_only() FROM PUBLIC;
CREATE TRIGGER terms_acceptances_no_change BEFORE UPDATE OR DELETE ON app.terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION app.terms_acceptances_append_only();
CREATE TRIGGER terms_acceptances_no_truncate BEFORE TRUNCATE ON app.terms_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION app.terms_acceptances_append_only();

-- Whether the user has accepted this version.
CREATE FUNCTION app.terms_accepted(p_user uuid, p_version text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.terms_acceptances t
                  WHERE t.user_id = p_user AND t.version = p_version)
$$;

-- Records an acceptance once; a repeat of the same version keeps the first.
CREATE FUNCTION app.terms_accept(p_user uuid, p_version text, p_now timestamptz, p_ip inet)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.terms_acceptances (user_id, version, accepted_at, ip)
    VALUES (p_user, p_version, p_now, p_ip)
    ON CONFLICT (user_id, version) DO NOTHING
$$;

REVOKE ALL ON FUNCTION app.terms_accepted(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.terms_accept(uuid, text, timestamptz, inet) FROM PUBLIC;
-- Web only (ADR-051): the same group as the other auth definers.
GRANT EXECUTE ON FUNCTION app.terms_accepted(uuid, text) TO ob_auth;
GRANT EXECUTE ON FUNCTION app.terms_accept(uuid, text, timestamptz, inet) TO ob_auth;
