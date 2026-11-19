-- 0028 erasure request outcome (T-0410, ADR-069 A-006: DEL-4). Runs as ob_owner. Expand only.
-- Confirmed is not completed: the deletion job sets `completed` when it has run and `failed` when
-- its last attempt failed, and an admin may retry a failed request (the same refs, a new run).
-- A request stays overdue until it is completed. The previous app never writes the new states or
-- columns, so it keeps working while this runs (expand/contract, ADR-045).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.erasure_requests
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN failed_at timestamptz,
  ADD COLUMN retry_count bigint NOT NULL DEFAULT 0;

-- Expand: every state and its rule. NOT VALID checks every new or updated row; every old row
-- (open, confirmed or withdrawn, with no outcome yet) already meets it. 0029 validates it.
ALTER TABLE app.erasure_requests
  ADD CONSTRAINT erasure_requests_outcome_states
  CHECK (
    retry_count >= 0
    AND (
      (state = 'open' AND confirmed_at IS NULL AND withdrawn_at IS NULL
          AND completed_at IS NULL AND failed_at IS NULL)
      OR (state = 'confirmed' AND confirmed_at IS NOT NULL AND withdrawn_at IS NULL
          AND completed_at IS NULL AND failed_at IS NULL)
      OR (state = 'completed' AND confirmed_at IS NOT NULL AND withdrawn_at IS NULL
          AND completed_at IS NOT NULL AND failed_at IS NULL)
      OR (state = 'failed' AND confirmed_at IS NOT NULL AND withdrawn_at IS NULL
          AND completed_at IS NULL AND failed_at IS NOT NULL)
      OR (state = 'withdrawn' AND confirmed_at IS NULL AND withdrawn_at IS NOT NULL
          AND withdrawn_by IS NOT NULL AND withdraw_reason IS NOT NULL
          AND completed_at IS NULL AND failed_at IS NULL)
    )
  ) NOT VALID;

-- Contract: the 0026 rule allows only open, confirmed and withdrawn; the new rule replaces it.
-- waiver: replaced by erasure_requests_outcome_states; ADR-069
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.erasure_requests DROP CONSTRAINT IF EXISTS erasure_requests_states;

-- The deletion job (no user named, so app.may_manage_members() lets it through) sets the outcome;
-- an admin's retry clears the failure and counts the retry. The record itself is never deleted.
GRANT UPDATE (completed_at, failed_at, retry_count) ON app.erasure_requests TO ob_tenant_rw;
