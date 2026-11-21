-- 0041 the two M05 end Minors (T-0801 first commit, ADR-078 1). Runs as ob_owner. Expand only.
--
-- (1) F-M05e-01: event security notices resolve themselves.
-- (2) F-M05e-02: definers never rely on RLS alone for workspace scope (definers.int.test.ts).
--
-- An event alert (a sign-in from a new network, a lockout, a canary read) is one notice per event.
-- Nothing resolved them, so the 90-day purge of resolved notices never reached them. The security
-- sweep now resolves each one 7 days after its event; the platform side needs this lookup, as
-- platform notices are reached through definers only.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- The record IDs of the open platform notices of one type and record kind raised before p_before.
CREATE FUNCTION app.platform_notice_open_records_before(p_type text, p_record_kind text,
                                                        p_before timestamptz)
  RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT n.record_id FROM app.platform_notifications n
   WHERE n.type = p_type AND n.record_kind = p_record_kind AND n.resolved_at IS NULL
     AND n.created_at < p_before
   ORDER BY n.record_id
$$;
REVOKE ALL ON FUNCTION app.platform_notice_open_records_before(text, text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_notice_open_records_before(text, text, timestamptz)
  TO ob_worker;

-- (2) The eBay reservation writes the caller's own usage row; it now clears the console setting
-- on entry, so the console's owner policy on api_usage_daily can never widen what it sees.
CREATE OR REPLACE FUNCTION app.ebay_budget_reserve(p_account uuid, p_api text, p_day date, p_n bigint,
                                        p_cap bigint, p_percent int, p_now timestamptz)
  RETURNS TABLE (reserved boolean, calls bigint, cap bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  after bigint;
BEGIN
  -- F-M05e-02: never under a console setting the caller may have preset.
  PERFORM set_config('app.platform_console', '', true);
  IF ws IS NULL OR p_n < 1 OR p_cap < 1 OR p_percent NOT IN (80, 95) THEN
    RAISE EXCEPTION 'ebay_budget_reserve: bad arguments' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.ebay_budget_daily AS b (api, day, calls, cap, updated_at)
    VALUES (p_api, p_day, 0, p_cap, p_now)
  ON CONFLICT (api, day) DO UPDATE SET cap = excluded.cap
    WHERE b.cap <> excluded.cap;
  UPDATE app.ebay_budget_daily b SET calls = b.calls + p_n, updated_at = p_now
   WHERE b.api = p_api AND b.day = p_day AND (b.calls + p_n) * 100 <= b.cap * p_percent
  RETURNING b.calls INTO after;
  IF after IS NULL THEN
    RETURN QUERY SELECT false, b.calls, b.cap FROM app.ebay_budget_daily b
                  WHERE b.api = p_api AND b.day = p_day;
    RETURN;
  END IF;
  -- The account row of today's usage, under the caller's own workspace (RLS still applies).
  INSERT INTO app.api_usage_daily AS u (workspace_id, channel_account_id, provider, api, day,
                                       calls, cap, updated_at)
    VALUES (ws, p_account, 'ebay', p_api, p_day, p_n, p_cap, p_now)
  ON CONFLICT (workspace_id, channel_account_id, provider, api, day)
    DO UPDATE SET calls = u.calls + excluded.calls, cap = excluded.cap, updated_at = p_now;
  RETURN QUERY SELECT true, after, p_cap;
END
$$;
