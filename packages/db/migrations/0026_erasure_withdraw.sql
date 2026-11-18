-- 0026 withdrawing an erasure request (T-0408, ADR-067: DEL-4). Runs as ob_owner.
-- A wrong or empty erasure search is closed as `withdrawn`: nothing is deleted, and it is never
-- overdue. The reason is a code from a fixed list, never free text, so no buyer identifier can
-- reach db-main through it (invariant 7a). The previous app never writes `withdrawn`, so it keeps
-- working while this runs (expand/contract, ADR-045).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.erasure_requests
  ADD COLUMN withdrawn_by uuid,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdraw_reason text
    CHECK (withdraw_reason IN ('wrong_identifiers', 'no_match', 'duplicate', 'buyer_withdrew', 'other'));

-- Expand: the new states and their rule. NOT VALID checks every new or updated row; every old
-- row (open or confirmed, nothing withdrawn) already meets it.
ALTER TABLE app.erasure_requests
  ADD CONSTRAINT erasure_requests_states
  CHECK (
    (state = 'open' AND confirmed_at IS NULL AND withdrawn_at IS NULL)
    OR (state = 'confirmed' AND confirmed_at IS NOT NULL AND withdrawn_at IS NULL)
    OR (state = 'withdrawn' AND confirmed_at IS NULL AND withdrawn_at IS NOT NULL
        AND withdrawn_by IS NOT NULL AND withdraw_reason IS NOT NULL)
  ) NOT VALID;

-- Contract: the 0025 rules allow only open and confirmed; erasure_requests_states replaces both.
-- waiver: replaced by erasure_requests_states; ADR-067
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.erasure_requests DROP CONSTRAINT IF EXISTS erasure_requests_state_check;
-- waiver: replaced by erasure_requests_states; ADR-067
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.erasure_requests DROP CONSTRAINT IF EXISTS erasure_requests_check;

-- Admins withdraw (the 0025 admin-update policy applies); the record itself is never deleted.
GRANT UPDATE (withdrawn_by, withdrawn_at, withdraw_reason) ON app.erasure_requests TO ob_tenant_rw;
