-- 0006 file scan states only move forward (F-M01-end-08, SEC-2, ADR-021). Runs as ob_owner.
-- A file is readable only in 'clean', and only a clamd verdict may put it there: a new row starts
-- in 'scanning', and 'scanning' may move once to 'clean', 'infected' or 'scan_failed', never
-- back. So no bug or injection in a process holding ob_app can mark an unscanned or infected
-- file readable.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.files_state_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'scanning' THEN
      RAISE EXCEPTION 'a new file must start in state scanning, not %', NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (OLD.state = 'scanning' AND NEW.state IN ('clean', 'infected', 'scan_failed')) THEN
    RAISE EXCEPTION 'file state cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER files_state_guard
  BEFORE INSERT OR UPDATE OF state ON app.files
  FOR EACH ROW EXECUTE FUNCTION app.files_state_guard();
