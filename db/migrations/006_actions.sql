-- Stage 8: approved external actions (changes made in a connected provider account).
-- A proposal captures the exact payload and its hash; approvals are bound to that
-- hash. Execution is idempotent (one key per proposal) and every step is recorded.

CREATE TABLE action_proposals (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL,
  business_id      uuid NOT NULL,
  connection_id    uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  asset_id         uuid REFERENCES connection_assets(id) ON DELETE SET NULL,
  provider         text NOT NULL,
  action_type      text NOT NULL,
  payload          jsonb NOT NULL,        -- canonical {type, connectionId, assetId, target, params}
  payload_hash     text NOT NULL,         -- sha256 of the canonical payload
  target           jsonb NOT NULL,        -- {kind, id, name}
  current_state    jsonb NOT NULL,        -- provider state read when proposed
  proposed_state   jsonb NOT NULL,
  expected_effect  text NOT NULL,
  risk             text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  status           text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'executing', 'needs_check', 'succeeded', 'failed', 'rejected', 'expired', 'superseded', 'cancelled')),
  source           text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'assistant')),
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  proposed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  supersedes       uuid REFERENCES action_proposals(id) ON DELETE SET NULL,
  idempotency_key  text NOT NULL UNIQUE,
  attempts         int NOT NULL DEFAULT 0,
  provider_response jsonb,
  result           jsonb,
  error            text,
  expires_at       timestamptz NOT NULL,
  executed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX action_proposals_biz_idx ON action_proposals(business_id, status, created_at DESC);

CREATE TABLE action_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   uuid NOT NULL REFERENCES action_proposals(id) ON DELETE CASCADE,
  business_id   uuid NOT NULL,
  payload_hash  text NOT NULL,           -- must equal the proposal's hash at execution time
  decision      text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id)                    -- one decision per proposal
);

-- Every execution attempt, with what the provider said.
CREATE TABLE action_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   uuid NOT NULL REFERENCES action_proposals(id) ON DELETE CASCADE,
  business_id   uuid NOT NULL,
  attempt       int NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('status_check', 'execute')),
  outcome       text NOT NULL,             -- applied | not_applied | unknown | succeeded | failed | ambiguous | drift
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_attempts_idx ON action_attempts(proposal_id, created_at);

ALTER TABLE action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_attempts ENABLE ROW LEVEL SECURITY;

-- Everyone on the business can see proposals and their history; writes go through the API
-- (which re-checks action.propose / action.approve) running as the user, or the worker.
CREATE POLICY ap_read ON action_proposals FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY ap_insert ON action_proposals FOR INSERT WITH CHECK (app.business_role(business_id) IN ('owner', 'admin', 'analyst') AND proposed_by = app.current_user_id());
CREATE POLICY ap_update ON action_proposals FOR UPDATE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));
CREATE POLICY aa_read ON action_approvals FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY aa_insert ON action_approvals FOR INSERT WITH CHECK (app.business_role(business_id) IN ('owner', 'admin') AND decided_by = app.current_user_id());
CREATE POLICY at_read ON action_attempts FOR SELECT USING (app.can_access_business(business_id));

GRANT SELECT, INSERT ON action_proposals TO bca_app;
GRANT UPDATE (status, updated_at) ON action_proposals TO bca_app;
GRANT SELECT, INSERT ON action_approvals TO bca_app;
GRANT SELECT ON action_attempts TO bca_app;
