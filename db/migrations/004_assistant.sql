-- Stage 5: AI assistant conversations and AI dashboard proposals.
-- Conversations are private to the user who started them and scoped to exactly
-- one business; RLS enforces both.

CREATE TABLE conversations (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  business_id   uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT 'New conversation',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX conversations_user_biz_idx ON conversations(business_id, user_id, updated_at DESC);

-- One row per user message and per assistant reply. `api_messages` holds the exact
-- Messages API turns produced for this row (assistant content incl. thinking and
-- tool_use blocks, user tool_result turns) so history is replayed append-only and
-- unchanged. `display` is what the UI renders: text plus server-built evidence.
CREATE TABLE conversation_messages (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  business_id     uuid NOT NULL,
  seq             int NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  status          text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'error', 'refused', 'truncated')),
  display         jsonb NOT NULL,
  api_messages    jsonb NOT NULL DEFAULT '[]',
  model           text,
  usage           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX conversation_messages_conv_idx ON conversation_messages(conversation_id, seq);

-- Dashboards proposed by the assistant. Nothing is saved to a dashboard until the
-- user applies the proposal; applying records the version it produced so it can be undone.
CREATE TABLE dashboard_proposals (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL,
  business_id      uuid NOT NULL,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('create', 'edit')),
  dashboard_id     uuid REFERENCES dashboards(id) ON DELETE SET NULL,
  base_version     int,
  spec             jsonb NOT NULL,
  summary          text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded', 'undone')),
  applied_version  int,
  applied_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX dashboard_proposals_biz_idx ON dashboard_proposals(business_id, user_id, created_at DESC);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_proposals ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.owns_conversation(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversations c
     WHERE c.id = p_conversation AND c.user_id = app.current_user_id() AND app.can_access_business(c.business_id)
  )
$$;

CREATE POLICY conv_read ON conversations FOR SELECT USING (user_id = app.current_user_id() AND app.can_access_business(business_id));
CREATE POLICY conv_insert ON conversations FOR INSERT WITH CHECK (user_id = app.current_user_id() AND app.can_access_business(business_id));
CREATE POLICY conv_update ON conversations FOR UPDATE USING (user_id = app.current_user_id() AND app.can_access_business(business_id));
CREATE POLICY conv_delete ON conversations FOR DELETE USING (user_id = app.current_user_id());

CREATE POLICY cm_read ON conversation_messages FOR SELECT USING (app.owns_conversation(conversation_id));
CREATE POLICY cm_insert ON conversation_messages FOR INSERT WITH CHECK (app.owns_conversation(conversation_id));

CREATE POLICY dp_read ON dashboard_proposals FOR SELECT USING (user_id = app.current_user_id() AND app.can_access_business(business_id));
CREATE POLICY dp_insert ON dashboard_proposals FOR INSERT WITH CHECK (user_id = app.current_user_id() AND app.can_access_business(business_id));
CREATE POLICY dp_update ON dashboard_proposals FOR UPDATE USING (user_id = app.current_user_id() AND app.can_access_business(business_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO bca_app;
GRANT SELECT, INSERT ON conversation_messages TO bca_app;
GRANT SELECT, INSERT, UPDATE ON dashboard_proposals TO bca_app;
GRANT EXECUTE ON FUNCTION app.owns_conversation(uuid) TO bca_app;
