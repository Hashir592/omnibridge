-- 0058 a closed line no longer takes its channel line ID (T-1004: F-M10-end-05). Runs as ob_owner.
-- 0057's partial index keeps the rule for open lines. Safe with the previous app version: it never
-- closes a line, so for it both rules are the same, and no statement names this one.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- waiver: replaced by order_lines_external_live (0057), the same rule for open lines; F-M10-end-05
-- squawk-ignore ban-drop-constraint
ALTER TABLE app.order_lines DROP CONSTRAINT order_lines_external;
