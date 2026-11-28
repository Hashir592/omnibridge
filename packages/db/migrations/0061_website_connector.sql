-- 0061 website connector (T-1101: WEB-1, WEB-2, WEB-3, AT-14, OPS-12). Runs as ob_owner. Expand
-- only: new tables and one function.
--
-- A Website channel account keeps its base URL and the SHA-256 of the inbound key it issued; the
-- key itself is shown once and never stored. The signing secret and the website's own key are
-- credentials (app.credentials, encrypted). The website calls /api/v1/website/{connectionId}
-- before any tenant context exists, so one definer function finds that connection alone and
-- answers its workspace, company, key hash and module flag; ob_app never reads another row.
-- Idempotency records hold the request's hash and the IDs answered, never a value (invariant 7a).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.website_connections (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  channel_account_id uuid NOT NULL,
  company_id uuid NOT NULL,
  base_url text NOT NULL CHECK (base_url ~ '^https://' AND char_length(base_url) <= 500),
  inbound_key_hash bytea NOT NULL CHECK (octet_length(inbound_key_hash) = 32),
  inbound_key_hint text NOT NULL CHECK (inbound_key_hint ~ '^[A-Za-z0-9_-]{4}$'),
  keys_issued_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, channel_account_id),
  FOREIGN KEY (workspace_id, channel_account_id) REFERENCES app.channel_accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, company_id) REFERENCES app.companies (workspace_id, id)
);
ALTER TABLE app.website_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.website_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY website_connections_tenant ON app.website_connections
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY website_connections_scope ON app.website_connections AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
-- The inbound lookup below reads the one connection it names, as ob_owner, and nothing else.
CREATE POLICY website_connections_inbound ON app.website_connections FOR SELECT TO ob_owner
  USING (channel_account_id = nullif(current_setting('app.website_connection', true), '')::uuid);
-- A connection goes with its account (Disconnect keeps the account, archived), never on its own.
REVOKE DELETE ON app.website_connections FROM ob_tenant_rw;

CREATE TABLE app.website_idempotency (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  channel_account_id uuid NOT NULL,
  company_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  route text NOT NULL CHECK (route ~ '^[a-zA-Z]{1,40}$'),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status bigint NOT NULL CHECK (status BETWEEN 200 AND 299),
  -- The IDs answered (an OmniBridge order ID, a count): never a value the website sent.
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, channel_account_id, idempotency_key),
  FOREIGN KEY (workspace_id, channel_account_id) REFERENCES app.channel_accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, company_id) REFERENCES app.companies (workspace_id, id)
);
CREATE INDEX website_idempotency_created ON app.website_idempotency (created_at);
ALTER TABLE app.website_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.website_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY website_idempotency_tenant ON app.website_idempotency
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY website_idempotency_scope ON app.website_idempotency AS RESTRICTIVE TO ob_app
  USING (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                    '{}'::uuid[])))
  WITH CHECK (company_id = ANY (coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                                         '{}'::uuid[])));
-- An answer is kept as given (WEB-2: same key, same result).
REVOKE UPDATE ON app.website_idempotency FROM ob_tenant_rw;

-- WEB-2, ADR-059: the one connection a website call names, before any tenant context. Answers
-- nothing for an unknown connection, an account that is not a website or one that is archived.
CREATE FUNCTION app.website_inbound(p_connection uuid)
  RETURNS TABLE (workspace_id uuid, company_id uuid, inbound_key_hash bytea, module_on boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  outer_workspace text := current_setting('app.workspace_id', true);
  c record;
BEGIN
  PERFORM set_config('app.website_connection', p_connection::text, true);
  SELECT w.workspace_id, w.company_id, w.inbound_key_hash INTO c
    FROM app.website_connections w
   WHERE w.channel_account_id = p_connection;
  PERFORM set_config('app.website_connection', '', true);
  IF c.workspace_id IS NULL THEN
    RETURN;
  END IF;
  -- The workspace and account policies apply to ob_owner too: look at that workspace only.
  PERFORM set_config('app.workspace_id', c.workspace_id::text, true);
  RETURN QUERY
    SELECT c.workspace_id, c.company_id, c.inbound_key_hash,
           coalesce((ws.modules ->> 'website_connector')::boolean, false)
      FROM app.workspaces ws
      JOIN app.channel_accounts a ON a.workspace_id = ws.id AND a.id = p_connection
     WHERE ws.id = c.workspace_id AND a.provider = 'website' AND a.archived_at IS NULL;
  PERFORM set_config('app.workspace_id', coalesce(outer_workspace, ''), true);
END
$$;
REVOKE ALL ON FUNCTION app.website_inbound(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.website_inbound(uuid) TO ob_app;
