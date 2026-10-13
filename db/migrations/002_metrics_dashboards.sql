-- Stage 2: connections (base), normalized metric facts, calculated metrics, dashboards.

-- ------------------------------------------------------------------ connections
-- A provider account authorized for one business. Credentials are AES-256-GCM
-- ciphertext and are never readable by the app role (column-level grants below).
CREATE TABLE connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  business_id         uuid NOT NULL,
  provider            text NOT NULL,
  display_name        text NOT NULL,
  external_account_id text,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'selecting_assets', 'syncing', 'active', 'error', 'reauth_required', 'disconnected')),
  -- Demo connections hold seeded sample data and may only exist in demo businesses.
  is_demo             boolean NOT NULL DEFAULT false,
  scopes              text[] NOT NULL DEFAULT '{}',
  credentials_enc     text,
  token_expires_at    timestamptz,
  settings            jsonb NOT NULL DEFAULT '{}',
  last_sync_started_at timestamptz,
  last_success_at     timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  disconnected_at     timestamptz,
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (business_id, id)
);
CREATE INDEX connections_biz_idx ON connections(business_id);
CREATE UNIQUE INDEX connections_unique_account ON connections(business_id, provider, external_account_id)
  WHERE disconnected_at IS NULL AND external_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.check_connection_demo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_demo <> (SELECT is_demo FROM businesses WHERE id = NEW.business_id) THEN
    RAISE EXCEPTION 'demo connections are only allowed in demo businesses (and real ones only in real businesses)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_demo_guard BEFORE INSERT OR UPDATE OF is_demo, business_id ON connections
  FOR EACH ROW EXECUTE FUNCTION app.check_connection_demo();

-- Provider assets discovered under a connection (store, GA4 property, Search Console site, Ads customer, HubSpot portal).
CREATE TABLE connection_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  business_id        uuid NOT NULL,
  connection_id      uuid NOT NULL,
  provider_asset_id  text NOT NULL,
  name               text NOT NULL,
  kind               text NOT NULL,
  currency           char(3),
  timezone           text,
  selected           boolean NOT NULL DEFAULT false,
  metadata           jsonb NOT NULL DEFAULT '{}',
  sync_cursor        jsonb NOT NULL DEFAULT '{}',
  latest_data_date   date,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, connection_id) REFERENCES connections(business_id, id) ON DELETE CASCADE,
  UNIQUE (connection_id, provider_asset_id),
  UNIQUE (business_id, id)
);
CREATE INDEX connection_assets_biz_idx ON connection_assets(business_id);

-- ------------------------------------------------------------------ normalized facts
-- One row per (asset, metric, reporting day, dimension value). dim_key = '' holds
-- the day's total; dimensional rows hold breakdowns for one dimension. Connectors
-- write explicit total rows (including zeros) for every day they cover, so a
-- missing total row means "no data", never zero.
CREATE TABLE metric_facts (
  workspace_id   uuid NOT NULL,
  business_id    uuid NOT NULL,
  connection_id  uuid NOT NULL,
  asset_id       uuid NOT NULL,
  provider       text NOT NULL,
  metric_key     text NOT NULL,
  date           date NOT NULL,                 -- reporting day in the asset's timezone
  dim_key        text NOT NULL DEFAULT '',
  dim_value      text NOT NULL DEFAULT '',
  value          numeric NOT NULL,
  currency       char(3),
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  sync_job_id    uuid,
  PRIMARY KEY (business_id, asset_id, metric_key, date, dim_key, dim_value),
  FOREIGN KEY (business_id, asset_id) REFERENCES connection_assets(business_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_facts_query_idx ON metric_facts(business_id, metric_key, dim_key, date);

-- ------------------------------------------------------------------ calculated metrics
CREATE TABLE calculated_metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  business_id  uuid NOT NULL,
  name         text NOT NULL,
  expression   text NOT NULL,
  ast          jsonb NOT NULL,
  unit         text NOT NULL CHECK (unit IN ('currency', 'count', 'percent', 'multiplier', 'number')),
  description  text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX calculated_metrics_biz_idx ON calculated_metrics(business_id);

-- ------------------------------------------------------------------ dashboards
CREATE TABLE dashboards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  business_id  uuid NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  date_range   jsonb NOT NULL DEFAULT '{"preset":"last_30_days"}',
  -- business: everyone with access to the business can view; private: owner + explicit shares (+ business admins).
  visibility   text NOT NULL DEFAULT 'business' CHECK (visibility IN ('business', 'private')),
  version      integer NOT NULL DEFAULT 1,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, business_id) REFERENCES businesses(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (business_id, id)
);
CREATE INDEX dashboards_biz_idx ON dashboards(business_id);

CREATE TABLE dashboard_widgets (
  id           text NOT NULL,
  dashboard_id uuid NOT NULL,
  business_id  uuid NOT NULL,
  type         text NOT NULL,
  title        text NOT NULL,
  query        jsonb,
  options      jsonb NOT NULL DEFAULT '{}',
  refresh      jsonb NOT NULL DEFAULT '{"mode":"on_new_data"}',
  layout       jsonb NOT NULL,
  position     integer NOT NULL,
  PRIMARY KEY (dashboard_id, id),
  FOREIGN KEY (business_id, dashboard_id) REFERENCES dashboards(business_id, id) ON DELETE CASCADE
);

-- Every save writes an immutable snapshot; restoring = saving an old snapshot as a new version.
CREATE TABLE dashboard_versions (
  dashboard_id uuid NOT NULL,
  business_id  uuid NOT NULL,
  version      integer NOT NULL,
  spec         jsonb NOT NULL,
  note         text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, version),
  FOREIGN KEY (business_id, dashboard_id) REFERENCES dashboards(business_id, id) ON DELETE CASCADE
);

CREATE TABLE dashboard_shares (
  dashboard_id uuid NOT NULL,
  business_id  uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_edit     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, user_id),
  FOREIGN KEY (business_id, dashboard_id) REFERENCES dashboards(business_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION app.can_view_dashboard(p_dashboard uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM dashboards d
     WHERE d.id = p_dashboard
       AND app.business_role(d.business_id) IS NOT NULL
       AND (d.visibility = 'business'
            OR d.created_by = app.current_user_id()
            OR app.business_role(d.business_id) IN ('owner', 'admin')
            OR EXISTS (SELECT 1 FROM dashboard_shares s WHERE s.dashboard_id = d.id AND s.user_id = app.current_user_id()))
  )
$$;

-- ------------------------------------------------------------------ change notifications
-- Listeners (the API's SSE endpoint) refresh dashboards when new data lands.
CREATE OR REPLACE FUNCTION app.notify_business(p_business uuid, p_kind text, p_payload jsonb DEFAULT '{}') RETURNS void
LANGUAGE sql AS $$
  SELECT pg_notify('bca_events', json_build_object('businessId', p_business, 'kind', p_kind, 'payload', p_payload)::text)
$$;

-- ------------------------------------------------------------------ RLS & grants
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE calculated_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY conn_read ON connections FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY assets_read ON connection_assets FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY facts_read ON metric_facts FOR SELECT USING (app.can_access_business(business_id));

CREATE POLICY calc_read ON calculated_metrics FOR SELECT USING (app.can_access_business(business_id));
CREATE POLICY calc_insert ON calculated_metrics FOR INSERT WITH CHECK (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));
CREATE POLICY calc_delete ON calculated_metrics FOR DELETE USING (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));

CREATE POLICY dash_read ON dashboards FOR SELECT USING (app.can_view_dashboard(id));
-- Separate write policies: a FOR ALL policy would also grant SELECT and bypass visibility.
CREATE POLICY dash_insert ON dashboards FOR INSERT WITH CHECK (app.business_role(business_id) IN ('owner', 'admin', 'analyst'));
CREATE POLICY dash_update ON dashboards FOR UPDATE
  USING (app.can_view_dashboard(id) AND app.business_role(business_id) IN ('owner', 'admin', 'analyst'))
  WITH CHECK (app.business_role(business_id) IS NOT NULL);
CREATE POLICY dash_delete ON dashboards FOR DELETE
  USING (app.can_view_dashboard(id) AND app.business_role(business_id) IN ('owner', 'admin', 'analyst'));
CREATE POLICY dw_read ON dashboard_widgets FOR SELECT USING (app.can_view_dashboard(dashboard_id));
CREATE POLICY dw_insert ON dashboard_widgets FOR INSERT WITH CHECK (app.can_view_dashboard(dashboard_id));
CREATE POLICY dw_delete ON dashboard_widgets FOR DELETE USING (app.can_view_dashboard(dashboard_id));
CREATE POLICY dv_read ON dashboard_versions FOR SELECT USING (app.can_view_dashboard(dashboard_id));
CREATE POLICY dv_insert ON dashboard_versions FOR INSERT WITH CHECK (app.can_view_dashboard(dashboard_id));
CREATE POLICY ds_read ON dashboard_shares FOR SELECT USING (app.can_view_dashboard(dashboard_id));
CREATE POLICY ds_insert ON dashboard_shares FOR INSERT WITH CHECK (app.can_view_dashboard(dashboard_id));
CREATE POLICY ds_delete ON dashboard_shares FOR DELETE USING (app.can_view_dashboard(dashboard_id));

-- Connections: readable without credentials; all writes go through server-side system paths.
GRANT SELECT (id, workspace_id, business_id, provider, display_name, external_account_id, status, is_demo, scopes,
              token_expires_at, settings, last_sync_started_at, last_success_at, last_error, last_error_at,
              consecutive_failures, created_by, created_at, updated_at, disconnected_at) ON connections TO bca_app;
GRANT SELECT ON connection_assets, metric_facts TO bca_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON calculated_metrics, dashboards, dashboard_widgets, dashboard_shares TO bca_app;
GRANT SELECT, INSERT ON dashboard_versions TO bca_app;
GRANT EXECUTE ON FUNCTION app.notify_business(uuid, text, jsonb) TO bca_app;
