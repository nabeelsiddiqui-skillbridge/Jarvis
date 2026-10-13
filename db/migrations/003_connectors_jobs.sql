-- Stage 3: connector framework — OAuth state, source records, durable jobs, webhook receipts.

-- One-time OAuth state, bound to the user and business that started the flow.
CREATE TABLE oauth_states (
  state_hash    text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL,
  business_id   uuid NOT NULL,
  provider      text NOT NULL,
  connection_id uuid,                    -- set when re-authorizing an existing connection
  input         jsonb NOT NULL DEFAULT '{}',
  code_verifier text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);

-- Raw-but-normalized provider records (orders, deals…) with provenance. Facts are
-- recomputed from these, which makes re-syncs, webhooks and reconciliation idempotent.
CREATE TABLE source_records (
  workspace_id      uuid NOT NULL,
  business_id       uuid NOT NULL,
  connection_id     uuid NOT NULL,
  asset_id          uuid NOT NULL,
  provider          text NOT NULL,
  record_type       text NOT NULL,
  provider_id       text NOT NULL,
  local_date        date NOT NULL,          -- reporting day in the asset's timezone
  occurred_at       timestamptz NOT NULL,
  source_updated_at timestamptz,
  payload           jsonb NOT NULL,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  sync_job_id       uuid,
  PRIMARY KEY (asset_id, record_type, provider_id),
  FOREIGN KEY (business_id, asset_id) REFERENCES connection_assets(business_id, id) ON DELETE CASCADE
);
CREATE INDEX source_records_date_idx ON source_records(asset_id, record_type, local_date);
CREATE INDEX source_records_ingested_idx ON source_records(business_id, ingested_at);

-- ------------------------------------------------------------------ durable job queue
-- Claimed with FOR UPDATE SKIP LOCKED by any number of workers. dedupe_key prevents
-- the same work (e.g. "sync connection X") being queued twice concurrently.
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  workspace_id  uuid,
  business_id   uuid,
  connection_id uuid,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority      integer NOT NULL DEFAULT 0,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 6,
  dedupe_key    text,
  locked_by     text,
  locked_at     timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  last_error    text,
  result        jsonb,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs(run_at, priority DESC) WHERE status = 'queued';
CREATE INDEX jobs_connection_idx ON jobs(connection_id, created_at DESC);
CREATE INDEX jobs_business_idx ON jobs(business_id, created_at DESC);
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs(dedupe_key) WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL;

-- Every inbound webhook delivery, verified and de-duplicated by provider delivery id.
CREATE TABLE webhook_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  delivery_id   text NOT NULL,
  topic         text NOT NULL,
  account_ref   text,
  connection_id uuid,
  business_id   uuid,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error         text,
  UNIQUE (provider, delivery_id)
);
CREATE INDEX webhook_receipts_conn_idx ON webhook_receipts(connection_id, received_at DESC);

-- ------------------------------------------------------------------ RLS & grants
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_receipts ENABLE ROW LEVEL SECURITY;

-- Business members can read their business's records and job history; all writes are system-side.
CREATE POLICY sr_read ON source_records FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY jobs_read ON jobs FOR SELECT USING (business_id IS NOT NULL AND app.can_access_business(business_id));
CREATE POLICY wr_read ON webhook_receipts FOR SELECT USING (business_id IS NOT NULL AND app.business_role(business_id) IN ('owner', 'admin'));

GRANT SELECT ON source_records, webhook_receipts TO bca_app;
GRANT SELECT (id, type, business_id, connection_id, status, run_at, attempts, max_attempts, started_at, finished_at, last_error, result, created_at) ON jobs TO bca_app;
