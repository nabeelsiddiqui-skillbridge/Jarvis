-- Stage 1: identity, workspaces, businesses, permissions, audit.
--
-- Security model
--   * The API runs every request inside a transaction that does
--       SET LOCAL ROLE bca_app;  SELECT set_config('app.user_id', <uuid>, true);
--     bca_app has no BYPASSRLS, so the row-level-security policies below apply
--     on top of the API's own permission checks (defence in depth).
--   * The background worker connects as the table owner and scopes every query
--     explicitly by workspace/business.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bca_app') THEN
    CREATE ROLE bca_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- The connecting (owner) role must be able to SET ROLE bca_app.
DO $$ BEGIN
  EXECUTE format('GRANT bca_app TO %I', current_user);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO bca_app;
GRANT USAGE ON SCHEMA public TO bca_app;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ------------------------------------------------------------------ users & sessions

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  name              text NOT NULL,
  password_hash     text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

-- Only a SHA-256 of the session token is stored.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text,
  ip          inet
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ------------------------------------------------------------------ workspaces

CREATE TABLE workspaces (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  data_retention_days integer NOT NULL DEFAULT 730 CHECK (data_retention_days BETWEEN 30 AND 3650),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user_idx ON workspace_memberships(user_id);

CREATE TABLE workspace_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  workspace_role  text NOT NULL CHECK (workspace_role IN ('owner', 'member')),
  -- [{ "businessId": uuid, "role": "admin|analyst|viewer" }]
  business_grants jsonb NOT NULL DEFAULT '[]',
  token_hash      text NOT NULL UNIQUE,
  invited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX workspace_invitations_ws_idx ON workspace_invitations(workspace_id);

-- ------------------------------------------------------------------ businesses

CREATE TABLE businesses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  logo_url      text,
  industry      text NOT NULL DEFAULT 'other',
  website       text,
  timezone      text NOT NULL DEFAULT 'UTC',
  currency      char(3) NOT NULL DEFAULT 'USD',
  description   text,
  -- Demo businesses hold seeded sample data only and are labelled everywhere.
  is_demo       boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  UNIQUE (workspace_id, id)
);
CREATE INDEX businesses_ws_idx ON businesses(workspace_id);

CREATE TABLE business_memberships (
  business_id  uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE,
  -- Business access requires workspace membership.
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX business_memberships_user_idx ON business_memberships(user_id);

-- Effective role of the current user on a business: 'owner' | 'admin' | 'analyst' | 'viewer' | NULL.
CREATE OR REPLACE FUNCTION app.business_role(p_business uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM businesses b
      JOIN workspace_memberships wm ON wm.workspace_id = b.workspace_id
      WHERE b.id = p_business AND wm.user_id = app.current_user_id() AND wm.role = 'owner'
    ) THEN 'owner'
    ELSE (SELECT role FROM business_memberships WHERE business_id = p_business AND user_id = app.current_user_id())
  END
$$;

CREATE OR REPLACE FUNCTION app.can_access_business(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app.business_role(p_business) IS NOT NULL $$;

CREATE OR REPLACE FUNCTION app.is_workspace_member(p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = p_workspace AND user_id = app.current_user_id())
$$;

CREATE OR REPLACE FUNCTION app.is_workspace_owner(p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = p_workspace AND user_id = app.current_user_id() AND role = 'owner')
$$;

-- ------------------------------------------------------------------ goals & preferences

-- Goals are always user-confirmed (the assistant may suggest, never silently store).
CREATE TABLE business_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  business_id  uuid NOT NULL,
  title        text NOT NULL,
  metric_key   text,
  target_value numeric,
  period       text NOT NULL DEFAULT 'month' CHECK (period IN ('month', 'quarter', 'year')),
  notes        text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX business_goals_biz_idx ON business_goals(business_id);

CREATE TABLE user_preferences (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_workspace_id     uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  recent_business_ids   uuid[] NOT NULL DEFAULT '{}',
  onboarding            jsonb NOT NULL DEFAULT '{}',
  assistant_panel_open  boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ audit

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid,
  business_id   uuid,
  actor_user_id uuid,
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'support')),
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_ws_idx ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX audit_logs_biz_idx ON audit_logs(business_id, created_at DESC);

-- ------------------------------------------------------------------ platform

CREATE TABLE feature_flags (
  key          text PRIMARY KEY,
  description  text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT false,
  -- Optional per-workspace overrides: { "<workspace uuid>": true|false }
  overrides    jsonb NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Time-limited, reasoned, audited access by platform staff to one workspace's data.
CREATE TABLE support_access_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

-- ------------------------------------------------------------------ row-level security

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ws_read ON workspaces FOR SELECT USING (app.is_workspace_member(id));
CREATE POLICY ws_update ON workspaces FOR UPDATE USING (app.is_workspace_owner(id));
CREATE POLICY ws_delete ON workspaces FOR DELETE USING (app.is_workspace_owner(id));

CREATE POLICY wsm_read ON workspace_memberships FOR SELECT USING (app.is_workspace_member(workspace_id));
CREATE POLICY wsm_write ON workspace_memberships FOR ALL
  USING (app.is_workspace_owner(workspace_id)) WITH CHECK (app.is_workspace_owner(workspace_id));

-- Creating a workspace inserts the workspace and its first owner atomically.
CREATE OR REPLACE FUNCTION app.create_workspace(p_id uuid, p_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  INSERT INTO workspaces (id, name, created_by) VALUES (p_id, p_name, app.current_user_id());
  INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (p_id, app.current_user_id(), 'owner');
END $$;
REVOKE ALL ON FUNCTION app.create_workspace(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_workspace(uuid, text) TO bca_app;

CREATE POLICY wsi_all ON workspace_invitations FOR ALL
  USING (app.is_workspace_owner(workspace_id)) WITH CHECK (app.is_workspace_owner(workspace_id));

CREATE POLICY biz_read ON businesses FOR SELECT USING (app.can_access_business(id));
CREATE POLICY biz_insert ON businesses FOR INSERT WITH CHECK (app.is_workspace_owner(workspace_id));
CREATE POLICY biz_update ON businesses FOR UPDATE USING (app.business_role(id) IN ('owner', 'admin'));
CREATE POLICY biz_delete ON businesses FOR DELETE USING (app.business_role(id) = 'owner');

CREATE POLICY bm_read ON business_memberships FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY bm_write ON business_memberships FOR ALL
  USING (app.business_role(business_id) IN ('owner', 'admin'))
  WITH CHECK (app.business_role(business_id) IN ('owner', 'admin'));

CREATE POLICY goals_read ON business_goals FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY goals_write ON business_goals FOR ALL
  USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'))
  WITH CHECK (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));

CREATE POLICY prefs_own ON user_preferences FOR ALL
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

-- Audit rows are append-only for the app role and readable by business admins / workspace owners.
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (true);
CREATE POLICY audit_read ON audit_logs FOR SELECT USING (
  (business_id IS NOT NULL AND app.business_role(business_id) IN ('owner', 'admin'))
  OR (business_id IS NULL AND workspace_id IS NOT NULL AND app.is_workspace_owner(workspace_id))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, workspace_memberships, workspace_invitations,
  businesses, business_memberships, business_goals, user_preferences TO bca_app;
GRANT SELECT, INSERT ON audit_logs TO bca_app;
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO bca_app;
-- users/sessions/feature_flags/support grants are only touched through owner-level auth code paths.

-- Members may see the name/email of people they share a workspace with (nothing else).
CREATE OR REPLACE FUNCTION app.shares_workspace(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_user = app.current_user_id() OR EXISTS (
    SELECT 1 FROM workspace_memberships a JOIN workspace_memberships b ON a.workspace_id = b.workspace_id
     WHERE a.user_id = app.current_user_id() AND b.user_id = p_user)
$$;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT USING (app.shares_workspace(id));
GRANT SELECT (id, name, email, created_at) ON users TO bca_app;
