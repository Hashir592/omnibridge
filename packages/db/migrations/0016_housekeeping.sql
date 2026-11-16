-- 0016 housekeeping (T-0207: F-M01-end-05, F-M02h-06; ADR-047). Runs as ob_owner.
-- Expand only. The indexes these purges delete by come in 0017, which runs outside a
-- transaction so it can build them CONCURRENTLY.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Job results hold counts and ids only (invariant 7); 16 KiB is far above any real one, and the
-- cap stops a handler bug from growing db-main. NOT VALID: it binds every new or changed row;
-- there are no old rows to validate (nothing is deployed, ADR-029).
ALTER TABLE app.job_records
  ADD CONSTRAINT job_records_result_size
  CHECK (result IS NULL OR octet_length(result::text) <= 16384) NOT VALID;

-- Sessions revoked or expired more than 30 days ago, and reset links used or expired more than
-- 7 days ago, are deleted (F-M02h-06). Hash-only rows, kept a while for support questions.
-- The cut-offs are fixed here, never a parameter, so a caller cannot reach a live session.
CREATE FUNCTION app.auth_purge()
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
  RETURN QUERY SELECT s, r;
END
$$;
-- Default privileges would give it to ob_tenant_rw: only the worker's housekeeping runs it.
REVOKE ALL ON FUNCTION app.auth_purge() FROM PUBLIC, ob_tenant_rw;
GRANT EXECUTE ON FUNCTION app.auth_purge() TO ob_worker;
