-- 0049 same-buyer order groups (T-1002: ORD-9, AT-26; docs/plan/client-changes-20261112.md C3).
-- Runs as ob_owner. Expand only; 0050 validates the NOT VALID rules.
--
-- Matching happens inside pii-vault (capability `match`); db-main stores only the result: a group
-- per channel account and the link on each order (C3.2). Company-scoped like orders (6.1).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.order_groups (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  -- open: shown together; dismissed: "Not the same buyer"; closed: fewer than two members left.
  state text NOT NULL CHECK (state IN ('open', 'dismissed', 'closed')),
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT order_groups_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id),
  CONSTRAINT order_groups_account_fk FOREIGN KEY (workspace_id, channel_account_id)
    REFERENCES app.channel_accounts (workspace_id, id)
);
CREATE INDEX order_groups_account ON app.order_groups (workspace_id, channel_account_id)
  WHERE state = 'open';
ALTER TABLE app.order_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.order_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY order_groups_tenant ON app.order_groups
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY order_groups_scope ON app.order_groups AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE DELETE ON app.order_groups FROM ob_tenant_rw;

-- Pairs of orders that are never grouped again (C3.3): every pair of a dismissed group, and a
-- removed member with each order it was grouped with (ADR-057). order_a < order_b.
CREATE TABLE app.order_group_exclusions (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  order_a uuid NOT NULL,
  order_b uuid NOT NULL,
  company_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dismissed', 'removed')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, order_a, order_b),
  CONSTRAINT order_group_exclusions_order CHECK (order_a < order_b),
  CONSTRAINT order_group_exclusions_a_fk FOREIGN KEY (workspace_id, order_a)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT order_group_exclusions_b_fk FOREIGN KEY (workspace_id, order_b)
    REFERENCES app.orders (workspace_id, id),
  CONSTRAINT order_group_exclusions_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
ALTER TABLE app.order_group_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.order_group_exclusions FORCE ROW LEVEL SECURITY;
CREATE POLICY order_group_exclusions_tenant ON app.order_group_exclusions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY order_group_exclusions_scope ON app.order_group_exclusions AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
REVOKE UPDATE, DELETE ON app.order_group_exclusions FROM ob_tenant_rw;

-- The link on each order (C3.2). NOT VALID: 0050 validates it.
ALTER TABLE app.orders ADD COLUMN order_group_id uuid;
ALTER TABLE app.orders ADD CONSTRAINT orders_group_fk FOREIGN KEY (workspace_id, order_group_id)
  REFERENCES app.order_groups (workspace_id, id) NOT VALID;

-- C3.1 (b): orders on adjacent London days still group within this many hours (default 3).
ALTER TABLE app.workspaces ADD COLUMN group_midnight_grace_hours bigint NOT NULL DEFAULT 3;
ALTER TABLE app.workspaces ADD CONSTRAINT workspaces_group_grace
  CHECK (group_midnight_grace_hours BETWEEN 0 AND 12) NOT VALID;
