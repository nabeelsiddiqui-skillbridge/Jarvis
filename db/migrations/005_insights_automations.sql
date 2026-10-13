-- Stage 7: insights, internal tasks, automations + runs, reports/briefings,
-- in-app notifications and AI dashboard commentary.
-- Numeric findings are computed by deterministic rules (worker, system role);
-- AI only adds clearly-labelled explanations and narratives.

CREATE TABLE insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  business_id     uuid NOT NULL,
  rule            text NOT NULL,                 -- period_change | anomaly | threshold | data_health | goal_pacing
  dedupe_key      text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('critical', 'warning', 'info', 'positive')),
  title           text NOT NULL,                 -- the finding, one line
  finding         text NOT NULL,                 -- deterministic description
  impact          text,                          -- deterministic possible impact
  next_step       text,                          -- suggested next step
  metric_key      text,
  period          jsonb,                         -- {from, to}
  comparison      jsonb,                         -- {from, to} or null
  evidence        jsonb NOT NULL DEFAULT '[]',   -- MetricEvidence / ConnectionsEvidence snapshots
  drivers         jsonb NOT NULL DEFAULT '[]',   -- largest contributors by dimension
  dashboard_id    uuid REFERENCES dashboards(id) ON DELETE SET NULL,
  explanation     text,                          -- AI: possible explanations (unverified)
  explanation_status text NOT NULL DEFAULT 'none' CHECK (explanation_status IN ('none', 'pending', 'ready', 'failed', 'unavailable')),
  explanation_model text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'dismissed', 'resolved')),
  status_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  status_at       timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  automation_id   uuid,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, dedupe_key),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX insights_biz_idx ON insights(business_id, status, detected_at DESC);

CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  business_id   uuid NOT NULL,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  assignee_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date      date,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'insight', 'automation')),
  insight_id    uuid REFERENCES insights(id) ON DELETE SET NULL,
  automation_run_id uuid,
  dedupe_key    text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX tasks_biz_idx ON tasks(business_id, status, created_at DESC);
CREATE UNIQUE INDEX tasks_dedupe_idx ON tasks(business_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE automations (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  business_id     uuid NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('daily_briefing', 'weekly_report', 'threshold_alert', 'connection_alert', 'insight_tasks')),
  enabled         boolean NOT NULL DEFAULT true,
  trigger         jsonb NOT NULL,   -- {type: "schedule", frequency, hour, weekday} | {type: "event", event}
  conditions      jsonb NOT NULL DEFAULT '{}',
  scope           jsonb NOT NULL DEFAULT '{}',   -- {sources: [...], connectionIds: [...]} (empty = all)
  actions         jsonb NOT NULL DEFAULT '{}',   -- {notify: {userIds, email}, task: {assigneeId}}
  timezone        text NOT NULL,
  approval_policy text NOT NULL DEFAULT 'auto' CHECK (approval_policy IN ('auto', 'approval_required')),
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX automations_due_idx ON automations(next_run_at) WHERE enabled;

-- One run per automation per logical occurrence (dedupe_key = schedule slot or event key).
CREATE TABLE automation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id  uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  business_id    uuid NOT NULL,
  dedupe_key     text NOT NULL,
  trigger_info   jsonb NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'awaiting_approval', 'rejected')),
  attempts       int NOT NULL DEFAULT 0,
  output         jsonb NOT NULL DEFAULT '{}',
  error          text,
  pending_actions jsonb,              -- actions held for approval
  decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  UNIQUE (automation_id, dedupe_key)
);
CREATE INDEX automation_runs_auto_idx ON automation_runs(automation_id, created_at DESC);

CREATE TABLE reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  business_id       uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('daily_briefing', 'weekly_report', 'custom')),
  title             text NOT NULL,
  period            jsonb NOT NULL,
  comparison        jsonb,
  content           jsonb NOT NULL,      -- sections with metric evidence, insights, goals, data health
  narrative         text,                -- AI summary citing evidence ids
  narrative_status  text NOT NULL DEFAULT 'none' CHECK (narrative_status IN ('none', 'ready', 'failed', 'unavailable')),
  narrative_model   text,
  is_demo           boolean NOT NULL DEFAULT false,
  automation_run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX reports_biz_idx ON reports(business_id, kind, created_at DESC);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  business_id  uuid NOT NULL,
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  link         text,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Cached AI commentary per dashboard version + date range + data freshness.
CREATE TABLE dashboard_commentary (
  id            uuid PRIMARY KEY,
  dashboard_id  uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  business_id   uuid NOT NULL,
  cache_key     text NOT NULL,
  text          text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '[]',
  model         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dashboard_id, cache_key)
);

ALTER TABLE insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_commentary ENABLE ROW LEVEL SECURITY;

CREATE POLICY ins_read ON insights FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY ins_update ON insights FOR UPDATE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));

CREATE POLICY task_read ON tasks FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY task_insert ON tasks FOR INSERT WITH CHECK (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));
CREATE POLICY task_update ON tasks FOR UPDATE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst') OR (assignee_id = app.current_user_id() AND app.can_access_business(business_id)));
CREATE POLICY task_delete ON tasks FOR DELETE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));

CREATE POLICY auto_read ON automations FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY auto_insert ON automations FOR INSERT WITH CHECK (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));
CREATE POLICY auto_update ON automations FOR UPDATE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));
CREATE POLICY auto_delete ON automations FOR DELETE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));

CREATE POLICY run_read ON automation_runs FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY run_update ON automation_runs FOR UPDATE USING (app.business_role(business_id) IN ('owner', 'admin'));

CREATE POLICY rep_read ON reports FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY rep_delete ON reports FOR DELETE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));

CREATE POLICY notif_read ON notifications FOR SELECT USING (user_id = app.current_user_id() AND app.can_access_business(business_id));
CREATE POLICY notif_update ON notifications FOR UPDATE USING (user_id = app.current_user_id());

CREATE POLICY comm_read ON dashboard_commentary FOR SELECT USING (app.can_view_dashboard(dashboard_id));
CREATE POLICY comm_insert ON dashboard_commentary FOR INSERT WITH CHECK (app.can_view_dashboard(dashboard_id));

GRANT SELECT ON insights, automation_runs, reports TO bca_app;
GRANT UPDATE (status, status_by, status_at, updated_at) ON insights TO bca_app;
GRANT UPDATE (status, decided_by, decided_at) ON automation_runs TO bca_app;
GRANT DELETE ON reports TO bca_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks, automations TO bca_app;
GRANT SELECT, UPDATE (read_at) ON notifications TO bca_app;
GRANT SELECT, INSERT ON dashboard_commentary TO bca_app;
