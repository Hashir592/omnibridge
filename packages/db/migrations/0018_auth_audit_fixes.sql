-- 0018 fixes from the T-0206 security audit (T-0210, ADR-061). Runs as ob_owner. Expand only:
-- the 0011/0012 signatures stay and delegate to the new ones, so the previous app version keeps
-- working while this one rolls out; a later contract step may drop them.
--
-- S5-20261117-01: only reset mails that go out count toward the platform-wide cap, so junk
--   requests for emails with no account can no longer switch reset off for everyone.
-- S5-20261117-02: a failed sign-in writes its auth.login_failed row inside auth_record_failure,
--   so a real and an unknown email make the same database calls.
-- S5-20261117-03: at most one lock notice per user per 24 hours, and 100 a day platform-wide.
-- Needs validation 1: an IPv6 client is counted per /64, the block it usually controls.
-- Hardening 3: setting a password marks the user's open reset links used.

-- Every migration runs in one transaction; SET LOCAL keeps these to that transaction.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- The address a counter is kept under: IPv4 (and IPv4-mapped IPv6) as is, other IPv6 by its /64.
CREATE FUNCTION app.counter_ip(p_ip inet) RETURNS inet
  LANGUAGE sql IMMUTABLE STRICT
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN family(p_ip) = 4 OR p_ip << inet '::ffff:0:0/96' THEN host(p_ip)::inet
           ELSE set_masklen(network(set_masklen(p_ip, 64))::inet, 128)
         END
$$;
REVOKE ALL ON FUNCTION app.counter_ip(inet) FROM PUBLIC, ob_tenant_rw;

-- ---- S5-20261117-01: reset mail ----

-- True when a mail went out for the request: only those count toward the 100 a day.
ALTER TABLE app.reset_requests ADD COLUMN mailed boolean NOT NULL DEFAULT false;

-- Records one reset request. The per-email (3 an hour) and per-address (10 an hour) caps count
-- every request, real email or not, as before. p_mail says the email has an account a mail
-- would go to; only then is the platform-wide cap (100 mails in 24 hours) consulted and used.
-- Returns 'ok' (a mail may go out when p_mail), 'capped' (an email or address cap) or
-- 'global_capped' (the platform-wide cap: the caller logs it at warn).
CREATE FUNCTION app.auth_reset_allow(p_key bytea, p_ip inet, p_now timestamptz, p_mail boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  addr inet := app.counter_ip(p_ip);
  verdict text;
BEGIN
  -- One request at a time, so concurrent requests cannot all pass the same count.
  PERFORM pg_advisory_xact_lock(hashtext('app.auth_reset_allow'));
  DELETE FROM app.reset_requests r WHERE r.requested_at < p_now - interval '24 hours';
  IF (SELECT count(*) FROM app.reset_requests r
       WHERE r.allowed AND r.key = p_key AND r.requested_at > p_now - interval '1 hour') >= 3
     OR (SELECT count(*) FROM app.reset_requests r
          WHERE r.allowed AND r.ip = addr AND r.requested_at > p_now - interval '1 hour') >= 10
  THEN
    verdict := 'capped';
  ELSIF p_mail AND (SELECT count(*) FROM app.reset_requests r
                     WHERE r.mailed AND r.requested_at > p_now - interval '24 hours') >= 100
  THEN
    verdict := 'global_capped';
  ELSE
    verdict := 'ok';
  END IF;
  INSERT INTO app.reset_requests (key, ip, requested_at, allowed, mailed)
    VALUES (p_key, addr, p_now, verdict <> 'capped', verdict = 'ok' AND p_mail);
  RETURN verdict;
END
$$;
REVOKE ALL ON FUNCTION app.auth_reset_allow(bytea, inet, timestamptz, boolean)
  FROM PUBLIC, ob_tenant_rw;
GRANT EXECUTE ON FUNCTION app.auth_reset_allow(bytea, inet, timestamptz, boolean) TO ob_auth;

-- The previous app version asks before its lookup: treat every one of its requests as a mail.
CREATE OR REPLACE FUNCTION app.auth_reset_allow(p_key bytea, p_ip inet, p_now timestamptz)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT app.auth_reset_allow(p_key, p_ip, p_now, true) = 'ok'
$$;

-- ---- IPv6 /64 on the sign-in counters ----

CREATE OR REPLACE FUNCTION app.auth_lock_state(p_key bytea, p_ip inet, p_now timestamptz)
  RETURNS TABLE (locked_until timestamptz, ip_blocked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (SELECT c.locked_until FROM app.login_counters c
           WHERE c.key = p_key AND c.locked_until > p_now),
         (SELECT i.blocked_until FROM app.ip_counters i
           WHERE i.ip = app.counter_ip(p_ip) AND i.blocked_until > p_now)
$$;

-- ---- S5-20261117-03: lock notices ----

-- When each user was last sent a lock notice. No foreign key: a row is a user id and a time,
-- dropped after 24 hours, and never blocks deleting a user.
CREATE TABLE app.lock_notices (
  user_id uuid NOT NULL PRIMARY KEY,
  sent_at timestamptz NOT NULL
);
CREATE INDEX lock_notices_at ON app.lock_notices (sent_at);
ALTER TABLE app.lock_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lock_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY lock_notices_definer_only ON app.lock_notices TO ob_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON app.lock_notices FROM PUBLIC, ob_app, ob_tenant_rw;

-- ---- S5-20261117-02: one call per failure ----

-- Records one failed sign-in (USR-5, ADR-008), as 0011 did, keyed per /64 for IPv6. With
-- p_user (the email has an account) it also writes the auth.login_failed row, so a real and an
-- unknown email make exactly this one call. On the failure that starts a lock it writes
-- auth.locked and decides the notice: 'send', 'recent' (one went to this user in the last 24
-- hours: audited only) or 'platform_capped' (100 notices in 24 hours: the caller logs at warn).
CREATE FUNCTION app.auth_record_failure(p_key bytea, p_ip inet, p_now timestamptz,
                                        p_user uuid, p_failure text)
  RETURNS TABLE (locked_until timestamptz, newly_locked boolean, ip_blocked_until timestamptz,
                 notice text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  addr inet := app.counter_ip(p_ip);
  c app.login_counters%ROWTYPE;
  i app.ip_counters%ROWTYPE;
  fresh boolean;
BEGIN
  DELETE FROM app.login_counters o WHERE o.last_failure_at < p_now - interval '24 hours';
  DELETE FROM app.ip_counters o WHERE o.last_failure_at < p_now - interval '24 hours';

  SELECT * INTO c FROM app.login_counters o WHERE o.key = p_key FOR UPDATE;
  fresh := NOT FOUND
        OR coalesce(c.locked_until <= p_now, false)
        OR (c.locked_until IS NULL AND c.window_started_at <= p_now - interval '15 minutes');
  IF NOT FOUND THEN
    INSERT INTO app.login_counters (key, failures, window_started_at, last_failure_at)
      VALUES (p_key, 1, p_now, p_now) RETURNING * INTO c;
  ELSIF fresh THEN
    UPDATE app.login_counters o SET failures = 1, window_started_at = p_now,
                                    last_failure_at = p_now, locked_until = NULL
     WHERE o.key = p_key RETURNING * INTO c;
  ELSIF c.locked_until IS NULL THEN
    UPDATE app.login_counters o SET failures = o.failures + 1, last_failure_at = p_now
     WHERE o.key = p_key RETURNING * INTO c;
  END IF;
  newly_locked := false;
  IF c.locked_until IS NULL AND c.failures >= 10 THEN
    UPDATE app.login_counters o SET locked_until = p_now + interval '15 minutes'
     WHERE o.key = p_key RETURNING * INTO c;
    newly_locked := true;
  END IF;
  locked_until := c.locked_until;

  SELECT * INTO i FROM app.ip_counters o WHERE o.ip = addr FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO app.ip_counters (ip, failures, last_failure_at) VALUES (addr, 1, p_now)
      RETURNING * INTO i;
  ELSIF i.last_failure_at <= p_now - interval '15 minutes' THEN
    UPDATE app.ip_counters o SET failures = 1, last_failure_at = p_now, blocked_until = NULL
     WHERE o.ip = addr RETURNING * INTO i;
  ELSE
    UPDATE app.ip_counters o SET failures = o.failures + 1, last_failure_at = p_now
     WHERE o.ip = addr RETURNING * INTO i;
  END IF;
  IF i.failures > 3 THEN
    UPDATE app.ip_counters o
       SET blocked_until = p_now + least(30, power(2, i.failures - 4)) * interval '1 second'
     WHERE o.ip = addr RETURNING * INTO i;
  END IF;
  ip_blocked_until := i.blocked_until;

  notice := NULL;
  IF p_user IS NOT NULL THEN
    -- No workspace is chosen yet: failures are kept per person (ADR-052). The real address.
    INSERT INTO app.auth_events (user_id, action, ip, detail, occurred_at)
      VALUES (p_user, 'auth.login_failed', p_ip,
              jsonb_build_object('failure', coalesce(p_failure, 'password')), p_now);
    IF newly_locked THEN
      INSERT INTO app.auth_events (user_id, action, ip, detail, occurred_at)
        VALUES (p_user, 'auth.locked', p_ip,
                jsonb_build_object('locked_until',
                  to_char(c.locked_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
                p_now);
      PERFORM pg_advisory_xact_lock(hashtext('app.lock_notices'));
      DELETE FROM app.lock_notices n WHERE n.sent_at <= p_now - interval '24 hours';
      IF EXISTS (SELECT 1 FROM app.lock_notices n WHERE n.user_id = p_user) THEN
        notice := 'recent';
      ELSIF (SELECT count(*) FROM app.lock_notices) >= 100 THEN
        notice := 'platform_capped';
      ELSE
        INSERT INTO app.lock_notices (user_id, sent_at) VALUES (p_user, p_now);
        notice := 'send';
      END IF;
    END IF;
  END IF;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION app.auth_record_failure(bytea, inet, timestamptz, uuid, text)
  FROM PUBLIC, ob_tenant_rw;
GRANT EXECUTE ON FUNCTION app.auth_record_failure(bytea, inet, timestamptz, uuid, text)
  TO ob_auth;

-- The previous app version: the counters only, as before (it writes its own audit rows).
CREATE OR REPLACE FUNCTION app.auth_record_failure(p_key bytea, p_ip inet, p_now timestamptz)
  RETURNS TABLE (locked_until timestamptz, newly_locked boolean, ip_blocked_until timestamptz)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT f.locked_until, f.newly_locked, f.ip_blocked_until
    FROM app.auth_record_failure(p_key, p_ip, p_now, NULL, NULL) f
$$;

-- ---- hardening 3: a new password voids open reset links ----

CREATE OR REPLACE FUNCTION app.auth_password_set(p_user uuid, p_hash text, p_now timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.user_auth (user_id, password_hash, password_set_at)
    VALUES (p_user, p_hash, p_now)
    ON CONFLICT (user_id) DO UPDATE
      SET password_hash = excluded.password_hash, password_set_at = excluded.password_set_at;
  INSERT INTO app.password_history (user_id, password_hash, set_at) VALUES (p_user, p_hash, p_now);
  DELETE FROM app.password_history h
   WHERE h.user_id = p_user
     AND h.set_at NOT IN (SELECT k.set_at FROM app.password_history k
                           WHERE k.user_id = p_user ORDER BY k.set_at DESC LIMIT 10);
  -- A link mailed before the change must not undo it.
  UPDATE app.password_resets r SET used_at = p_now WHERE r.user_id = p_user AND r.used_at IS NULL;
END
$$;

-- ---- retention: lock notice rows go with the daily sweep too ----

-- As 0016, plus lock_notices older than 24 hours, so a user id never outlives its window even
-- when no further lock happens (a deleted user's id included).
CREATE OR REPLACE FUNCTION app.auth_purge()
  RETURNS TABLE (sessions bigint, resets bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s bigint;
  r bigint;
BEGIN
  DELETE FROM app.sessions x WHERE least(x.revoked_at, x.expires_at) < now() - interval '30 days';
  GET DIAGNOSTICS s = ROW_COUNT;
  DELETE FROM app.password_resets x
   WHERE least(x.used_at, x.expires_at) < now() - interval '7 days';
  GET DIAGNOSTICS r = ROW_COUNT;
  DELETE FROM app.lock_notices x WHERE x.sent_at < now() - interval '24 hours';
  RETURN QUERY SELECT s, r;
END
$$;
