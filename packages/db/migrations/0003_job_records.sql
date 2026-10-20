-- 0003 job records (T-0104, NFR-3, NFR-4). Runs as ob_owner.
-- One row per workspace job: the idempotency key that makes a repeat send a no-op, and the
-- progress that GET /jobs/{id} reports. The job itself lives in pg-boss; the row id is the
-- pg-boss job id of the first send. Results hold counts and ids only, never PII (invariant 7).

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.job_records (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'active', 'retrying', 'completed', 'failed')),
  attempt bigint NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  percent bigint NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CONSTRAINT job_records_idempotency UNIQUE (workspace_id, type, idempotency_key)
);

ALTER TABLE app.job_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.job_records FORCE ROW LEVEL SECURITY;
CREATE POLICY job_records_tenant ON app.job_records
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Leases for N-parallel caps (OPS-10): at most `cap` slots per scope (a channel account) are
-- held at once, across every worker. pg-boss groupConcurrency alone is best effort under
-- concurrent fetches, so this table is the hard limit. A lease expires if its worker dies, and
-- is renewed while the job runs.
CREATE TABLE app.job_leases (
  workspace_id uuid NOT NULL,
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 200),
  slot bigint NOT NULL CHECK (slot >= 0),
  holder uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, scope_key, slot)
);

ALTER TABLE app.job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.job_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY job_leases_tenant ON app.job_leases
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
