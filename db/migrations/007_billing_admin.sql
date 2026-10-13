-- Stage 9: billing (Stripe), usage metering, feature flags, audited support access.

-- ------------------------------------------------------------------ subscriptions
-- One row per workspace. Written only by the server (checkout/webhooks/admin), never by
-- the app role. New workspaces start on a 14-day trial of the Growth plan.
CREATE TABLE workspace_subscriptions (
  workspace_id           uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan                   text NOT NULL DEFAULT 'growth',
  status                 text NOT NULL DEFAULT 'trialing'
                           CHECK (status IN ('trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'canceled', 'paused', 'none')),
  -- Set for the built-in trial; Stripe-managed subscriptions use current_period_end.
  trial_ends_at          timestamptz,
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_price_id        text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  -- Last Stripe event applied (events can arrive out of order; older ones are ignored).
  stripe_event_created   timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspace_subscriptions (workspace_id, plan, status, trial_ends_at)
SELECT id, 'growth', 'trialing', greatest(created_at, now()) + interval '14 days' FROM workspaces
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app.start_trial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO workspace_subscriptions (workspace_id, plan, status, trial_ends_at)
  VALUES (NEW.id, 'growth', 'trialing', now() + interval '14 days') ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_start_trial AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION app.start_trial();

-- Every Stripe event id is processed at most once.
CREATE TABLE billing_events (
  id            text PRIMARY KEY,
  type          text NOT NULL,
  workspace_id  uuid,
  created_at    timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'processed' CHECK (status IN ('processed', 'ignored', 'failed')),
  error         text
);
CREATE INDEX billing_events_ws_idx ON billing_events(workspace_id, received_at DESC);

-- ------------------------------------------------------------------ usage metering
-- kind: ai_message | ai_background | voice_session | tts_characters
CREATE TABLE usage_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id  uuid,
  user_id      uuid,
  kind         text NOT NULL,
  quantity     numeric NOT NULL DEFAULT 1,
  meta         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_ws_idx ON usage_events(workspace_id, kind, created_at);
CREATE INDEX usage_events_time_idx ON usage_events(created_at);

ALTER TABLE workspace_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY wsub_read ON workspace_subscriptions FOR SELECT USING (app.is_workspace_member(workspace_id));
CREATE POLICY usage_read ON usage_events FOR SELECT USING (app.is_workspace_member(workspace_id));
GRANT SELECT ON workspace_subscriptions, usage_events TO bca_app;

-- ------------------------------------------------------------------ feature flags
-- Flags default to on; a platform administrator can switch them off globally or per workspace.
INSERT INTO feature_flags (key, description, enabled) VALUES
  ('assistant', 'AI assistant (text), AI dashboard generation and AI narratives', true),
  ('voice', 'Streaming voice conversations with the assistant', true),
  ('external_actions', 'Proposing and executing approved changes in connected accounts', true)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------------ support access
-- A platform administrator holding an active, unexpired, unrevoked grant for a workspace
-- gets read-only (viewer) access to its businesses. Every request made that way is audited
-- in the customer's own audit log by the API.
CREATE OR REPLACE FUNCTION app.support_grant_active(p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM support_access_grants g JOIN users u ON u.id = g.admin_user_id
     WHERE g.workspace_id = p_workspace AND g.admin_user_id = app.current_user_id()
       AND g.revoked_at IS NULL AND g.expires_at > now()
       AND u.is_platform_admin AND u.disabled_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION app.business_role(p_business uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM businesses b
      JOIN workspace_memberships wm ON wm.workspace_id = b.workspace_id
      WHERE b.id = p_business AND wm.user_id = app.current_user_id() AND wm.role = 'owner'
    ) THEN 'owner'
    ELSE coalesce(
      (SELECT role FROM business_memberships WHERE business_id = p_business AND user_id = app.current_user_id()),
      (SELECT 'viewer' FROM businesses b WHERE b.id = p_business AND app.support_grant_active(b.workspace_id)))
  END
$$;

-- True when the current user's access to this business comes only from a support grant.
CREATE OR REPLACE FUNCTION app.is_support_access(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (
      SELECT 1 FROM businesses b JOIN workspace_memberships wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = p_business AND wm.user_id = app.current_user_id())
    AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = p_business AND app.support_grant_active(b.workspace_id))
$$;

CREATE INDEX support_grants_active_idx ON support_access_grants(workspace_id, admin_user_id) WHERE revoked_at IS NULL;

-- Workspace-level notifications (billing, support access) have no business.
ALTER TABLE notifications ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
DROP POLICY notif_read ON notifications;
CREATE POLICY notif_read ON notifications FOR SELECT USING (
  user_id = app.current_user_id()
  AND (CASE WHEN business_id IS NULL THEN app.is_workspace_member(workspace_id) ELSE app.can_access_business(business_id) END));

-- ------------------------------------------------------------------ retention support
-- Days before purged_before had their source records deleted by the retention policy:
-- their aggregated metrics are kept and never recomputed (recomputing would zero them).
ALTER TABLE connection_assets ADD COLUMN purged_before date;
-- Each Shopify customer's first order survives purging, so "new customer" stays correct.
CREATE TABLE customer_first_orders (
  asset_id    uuid NOT NULL,
  customer_id text NOT NULL,
  first_at    timestamptz NOT NULL,
  PRIMARY KEY (asset_id, customer_id)
);
