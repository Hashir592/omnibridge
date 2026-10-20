-- 0007 tenancy core for db-main (T-0201, TEN-1, TEN-2, TEN-3, TEN-6, TEN-10, ADR-006). Runs as
-- ob_owner. Workspaces, companies, channel accounts, users and memberships, each behind forced
-- row-level security.
--
-- Every app transaction sets, with SET LOCAL (packages/db Tenancy):
--   app.workspace_id  the one workspace it acts in
--   app.company_ids   an explicit list of company ids, never a wildcard; unset or empty = none
--   app.user_id       the signed-in user, when there is one
-- Rules that must see rows outside the caller's company list run in SECURITY DEFINER functions
-- owned by ob_owner. ob_owner is still bound by the workspace policies (FORCE), so they see the
-- current workspace only, and the company policies (TO ob_app) do not narrow them.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Workspaces (TEN-6, TEN-10). Billing is not built: plan and limits are a place to grow into.
CREATE TABLE app.workspaces (
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  plan text NOT NULL DEFAULT 'free_internal' CHECK (plan IN ('free_internal')),
  -- Enforced only when set (TEN-10).
  max_channel_accounts bigint CHECK (max_channel_accounts >= 1),
  max_users bigint CHECK (max_users >= 1),
  timezone text NOT NULL DEFAULT 'Europe/London' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
  default_vat_rate_bp bigint NOT NULL DEFAULT 2000
    CHECK (default_vat_rate_bp BETWEEN 0 AND 10000),
  -- Fixed and shown read-only (TEN-6, section 7.3): no role may write it.
  pii_retention_days bigint NOT NULL DEFAULT 25 CHECK (pii_retention_days = 25),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant ON app.workspaces
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- The scheduler fan-out lists workspace ids and nothing else (invariant 2).
CREATE POLICY workspaces_platform_list ON app.workspaces FOR SELECT TO ob_platform USING (true);

REVOKE ALL ON app.workspaces FROM ob_app;
GRANT SELECT ON app.workspaces TO ob_app;
-- A new workspace is inserted inside a transaction for its own id (the WITH CHECK above).
GRANT INSERT (id, name, max_channel_accounts, max_users) ON app.workspaces TO ob_app;
GRANT UPDATE (name, timezone, default_vat_rate_bp) ON app.workspaces TO ob_app;
GRANT SELECT (id) ON app.workspaces TO ob_platform;

-- Companies (TEN-2). Addresses are the company's own registered office, not buyer data.
CREATE TABLE app.companies (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  trading_name text NOT NULL CHECK (char_length(trading_name) BETWEEN 1 AND 200),
  company_number text CHECK (company_number ~ '^[A-Z0-9]{8}$'),
  vat_number text CHECK (vat_number ~ '^GB([0-9]{9}|[0-9]{12})$'),
  address_line1 text NOT NULL CHECK (char_length(address_line1) BETWEEN 1 AND 200),
  address_line2 text CHECK (char_length(address_line2) BETWEEN 1 AND 200),
  address_city text NOT NULL CHECK (char_length(address_city) BETWEEN 1 AND 100),
  address_postcode text NOT NULL CHECK (char_length(address_postcode) BETWEEN 2 AND 10),
  address_country text NOT NULL DEFAULT 'GB' CHECK (address_country ~ '^[A-Z]{2}$'),
  -- VAT quarter stagger (section 5.8, VQ-1); every launch company starts on stagger 1.
  vat_period text NOT NULL DEFAULT 'stagger_1'
    CHECK (vat_period IN ('stagger_1', 'stagger_2', 'stagger_3', 'monthly')),
  -- No column default: the companies_first_defaults trigger fills a flag left out (TEN-2), and
  -- keeps a value the caller gave.
  is_fulfilment_provider boolean NOT NULL,
  is_purchasing_company boolean NOT NULL,
  badge_colour text NOT NULL DEFAULT '#0F6B66' CHECK (badge_colour ~ '^#[0-9A-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id)
);

ALTER TABLE app.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companies FORCE ROW LEVEL SECURITY;
CREATE POLICY companies_tenant ON app.companies
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- The caller's companies only (PERM-3, invariant 4). A new company is not in anyone's list yet,
-- so INSERT is limited by the workspace policy and by the route's permissions alone.
CREATE POLICY companies_scope_select ON app.companies AS RESTRICTIVE FOR SELECT TO ob_app
  USING (id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                            '{}'::uuid[])));
CREATE POLICY companies_scope_update ON app.companies AS RESTRICTIVE FOR UPDATE TO ob_app
  USING (id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                            '{}'::uuid[])))
  WITH CHECK (id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                 '{}'::uuid[])));
-- Companies are never deleted by the app: workspace closure goes through the deletion service.
REVOKE DELETE ON app.companies FROM ob_app;

-- Channel accounts (TEN-3). Connection details and credentials arrive in M07.
CREATE TABLE app.channel_accounts (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  company_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('amazon', 'amazon_ads', 'ebay', 'website')),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  -- Set once, when the account's first order is stored (M10); its company is fixed from then on.
  orders_seen_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CONSTRAINT channel_accounts_company_fk FOREIGN KEY (workspace_id, company_id)
    REFERENCES app.companies (workspace_id, id)
);
CREATE INDEX channel_accounts_company ON app.channel_accounts (workspace_id, company_id);

ALTER TABLE app.channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_accounts_tenant ON app.channel_accounts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY channel_accounts_scope ON app.channel_accounts AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
-- An account is archived, never deleted (TEN-3).
REVOKE DELETE ON app.channel_accounts FROM ob_app;

-- Users (USR-1, USR-2): one login per person, across workspaces, so no workspace_id. Staff email
-- addresses are not buyer PII. Login lookups by email arrive with T-0203.
CREATE TABLE app.users (
  id uuid NOT NULL,
  email text NOT NULL
    CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254 AND email LIKE '_%@_%'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Platform operators (ARCHITECTURE.md §6.3). ob_app can never set it.
  platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (email)
);

-- Memberships: which users belong to which workspace. Roles and ticks grow in T-0204.
CREATE TABLE app.memberships (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user ON app.memberships (user_id);

ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant ON app.memberships
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE ON app.memberships FROM ob_app;
GRANT UPDATE (role) ON app.memberships TO ob_app;

-- Membership lookup for the users policy, as a SECURITY DEFINER function so the users and
-- memberships policies never call each other (S1, 20 Oct 2026). It answers for the current
-- workspace only.
CREATE FUNCTION app.is_co_member(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.memberships m
     WHERE m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
       AND m.user_id = target)
$$;
REVOKE ALL ON FUNCTION app.is_co_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_co_member(uuid) TO ob_app;

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
-- A user sees themselves and the members of the current workspace, nobody else.
CREATE POLICY users_visible ON app.users FOR SELECT TO ob_app
  USING (id = nullif(current_setting('app.user_id', true), '')::uuid OR app.is_co_member(id));
CREATE POLICY users_self_insert ON app.users FOR INSERT TO ob_app
  WITH CHECK (id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY users_self_update ON app.users FOR UPDATE TO ob_app
  USING (id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.user_id', true), '')::uuid);
REVOKE ALL ON app.users FROM ob_app;
GRANT SELECT ON app.users TO ob_app;
GRANT INSERT (id, email, name) ON app.users TO ob_app;
GRANT UPDATE (name) ON app.users TO ob_app;

-- Every company id of the current workspace, for admins and workspace-wide jobs (S1, 20 Oct
-- 2026): the context builder sets app.company_ids from it, so there is never a wildcard.
CREATE FUNCTION app.workspace_company_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(array_agg(c.id ORDER BY c.id), '{}'::uuid[])
    FROM app.companies c
   WHERE c.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION app.workspace_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_company_ids() TO ob_app;

-- TEN-2 defaults for a flag the caller left out: true for the workspace's first company (it is
-- both the fulfilment provider and the purchasing company), false for later ones. A value the
-- caller gave is kept. The workspace row lock makes two first companies at once take turns.
CREATE FUNCTION app.companies_first_defaults() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  first boolean;
BEGIN
  PERFORM 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  first := NOT EXISTS (SELECT 1 FROM app.companies c WHERE c.workspace_id = NEW.workspace_id);
  NEW.is_fulfilment_provider := coalesce(NEW.is_fulfilment_provider, first);
  NEW.is_purchasing_company := coalesce(NEW.is_purchasing_company, first);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.companies_first_defaults() FROM PUBLIC;
CREATE TRIGGER companies_first_defaults
  BEFORE INSERT ON app.companies
  FOR EACH ROW EXECUTE FUNCTION app.companies_first_defaults();

-- TEN-3: once a channel account has orders, its company never changes and the mark stays.
CREATE FUNCTION app.channel_accounts_company_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.orders_seen_at IS NOT NULL THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'a channel account with orders cannot move to another company; archive it'
        USING ERRCODE = 'OBC01';
    END IF;
    IF NEW.orders_seen_at IS DISTINCT FROM OLD.orders_seen_at THEN
      RAISE EXCEPTION 'orders_seen_at is set once and never changes'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER channel_accounts_company_guard
  BEFORE UPDATE ON app.channel_accounts
  FOR EACH ROW EXECUTE FUNCTION app.channel_accounts_company_guard();

-- TEN-10: limits are enforced only when set. Counts run as ob_owner, so a caller who sees only
-- some companies still counts every account; the workspace row lock serialises two adds at once.
CREATE FUNCTION app.channel_accounts_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cap bigint;
  used bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN
    RETURN NEW; -- only a new or un-archived account takes a place
  END IF;
  SELECT w.max_channel_accounts INTO cap
    FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO used
    FROM app.channel_accounts a
   WHERE a.workspace_id = NEW.workspace_id AND a.archived_at IS NULL AND a.id <> NEW.id;
  IF used >= cap THEN
    RAISE EXCEPTION 'workspace limit reached: max_channel_accounts' USING ERRCODE = 'OBL01';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.channel_accounts_limit() FROM PUBLIC;
CREATE TRIGGER channel_accounts_limit
  BEFORE INSERT OR UPDATE OF archived_at ON app.channel_accounts
  FOR EACH ROW EXECUTE FUNCTION app.channel_accounts_limit();

CREATE FUNCTION app.memberships_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cap bigint;
  used bigint;
BEGIN
  SELECT w.max_users INTO cap
    FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO used FROM app.memberships m WHERE m.workspace_id = NEW.workspace_id;
  IF used >= cap THEN
    RAISE EXCEPTION 'workspace limit reached: max_users' USING ERRCODE = 'OBL01';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.memberships_limit() FROM PUBLIC;
CREATE TRIGGER memberships_limit
  BEFORE INSERT ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.memberships_limit();
