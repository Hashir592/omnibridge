-- 0007 security log retention and the 0006 check validated (T-0409, ADR-068). Runs as vault_owner.
--
-- Hardening 7: validate the blind-index field rule 0006 added NOT VALID. Every row meets it (the
-- list only grew).
--
-- Hardening 4: vault.access_log and vault.canary_events hold staff user IDs. They follow PRD 7.3
-- for security logs: kept 6 years, also after a workspace closes, then deleted. The vault cannot
-- delete from them (0002, 0005); the one way is vault.purge_security_logs(), a definer with the
-- cut-off fixed here, never a parameter, which the vault runs daily. It reaches every workspace
-- through a policy that holds only while the function runs, and only for rows past 6 years.
-- Expand only: the previous vault never calls it.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE vault.blind_index VALIDATE CONSTRAINT blind_index_fields;

CREATE POLICY access_log_retention_read ON vault.access_log FOR SELECT TO vault_owner
  USING (current_setting('vault.retention_purge', true) = 'on'
         AND at < now() - interval '6 years');
CREATE POLICY access_log_retention_delete ON vault.access_log FOR DELETE TO vault_owner
  USING (current_setting('vault.retention_purge', true) = 'on'
         AND at < now() - interval '6 years');
CREATE POLICY canary_events_retention_read ON vault.canary_events FOR SELECT TO vault_owner
  USING (current_setting('vault.retention_purge', true) = 'on'
         AND at < now() - interval '6 years');
CREATE POLICY canary_events_retention_delete ON vault.canary_events FOR DELETE TO vault_owner
  USING (current_setting('vault.retention_purge', true) = 'on'
         AND at < now() - interval '6 years');

-- Deletes every access-log row and canary event older than 6 years, in every workspace, and
-- returns how many. IDs only ever lived there, so no VACUUM is needed for privacy.
CREATE FUNCTION vault.purge_security_logs() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cutoff timestamptz := now() - interval '6 years';
  a bigint;
  b bigint;
BEGIN
  PERFORM set_config('vault.retention_purge', 'on', true);
  DELETE FROM vault.access_log WHERE at < cutoff;
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM vault.canary_events WHERE at < cutoff;
  GET DIAGNOSTICS b = ROW_COUNT;
  PERFORM set_config('vault.retention_purge', '', true);
  RETURN a + b;
END
$$;
REVOKE ALL ON FUNCTION vault.purge_security_logs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault.purge_security_logs() TO vault_app;
