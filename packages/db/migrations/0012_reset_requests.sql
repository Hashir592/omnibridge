-- 0012 caps on password reset mail (USR-7, SEC-1, F-M02h-05). Runs as ob_owner. Expand only.
--
-- Reset mail is a paid, capped resource (ADR-020) and must not be usable to mail-bomb an
-- address. Every reset request is counted here, real email or not, keyed like the sign-in
-- counters by an HMAC of the normalised email, so no plaintext email is stored (ADR-048).
-- A request is allowed while: at most 3 allowed for the same email in the last hour, 10 from
-- the same client address in the last hour, and 100 in the last 24 hours overall. Over a cap
-- the route still answers 202 and nothing is sent. Rows older than 24 hours are dropped.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.reset_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key bytea NOT NULL CHECK (octet_length(key) = 32),
  ip inet NOT NULL,
  requested_at timestamptz NOT NULL,
  allowed boolean NOT NULL
);
CREATE INDEX reset_requests_key ON app.reset_requests (key, requested_at);
CREATE INDEX reset_requests_ip ON app.reset_requests (ip, requested_at);
CREATE INDEX reset_requests_at ON app.reset_requests (requested_at);

-- Forced RLS, open only to ob_owner (the definer below), as for the other auth tables.
ALTER TABLE app.reset_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reset_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY reset_requests_definer_only ON app.reset_requests TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.reset_requests FROM ob_app;

-- Records one reset request and says whether a mail may go out for it.
CREATE FUNCTION app.auth_reset_allow(p_key bytea, p_ip inet, p_now timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ok boolean;
BEGIN
  -- One request at a time, so concurrent requests cannot all pass the same count.
  PERFORM pg_advisory_xact_lock(hashtext('app.auth_reset_allow'));
  DELETE FROM app.reset_requests r WHERE r.requested_at < p_now - interval '24 hours';
  ok := (SELECT count(*) FROM app.reset_requests r
          WHERE r.allowed AND r.key = p_key AND r.requested_at > p_now - interval '1 hour') < 3
    AND (SELECT count(*) FROM app.reset_requests r
          WHERE r.allowed AND r.ip = p_ip AND r.requested_at > p_now - interval '1 hour') < 10
    AND (SELECT count(*) FROM app.reset_requests r
          WHERE r.allowed AND r.requested_at > p_now - interval '24 hours') < 100;
  INSERT INTO app.reset_requests (key, ip, requested_at, allowed) VALUES (p_key, p_ip, p_now, ok);
  RETURN ok;
END
$$;

REVOKE ALL ON FUNCTION app.auth_reset_allow(bytea, inet, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_reset_allow(bytea, inet, timestamptz) TO ob_app;
