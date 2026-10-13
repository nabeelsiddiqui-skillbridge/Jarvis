import { randomUUID } from "node:crypto";
import type pg from "pg";
import { can, dashboardSpec, type DashboardDetail, type DashboardSpec, type DashboardSummary, type EffectiveBusinessRole } from "@bca/shared";
import { conflict, forbidden, notFound } from "../lib/errors.js";

/**
 * Dashboard persistence. A dashboard's widgets live in dashboard_widgets; every
 * save also writes an immutable snapshot to dashboard_versions (restore = save an
 * old snapshot as a new version). Saves use optimistic concurrency on `version`.
 */

export async function saveNewDashboard(
  db: pg.PoolClient,
  p: { workspaceId: string; businessId: string; userId: string; spec: DashboardSpec; visibility?: "business" | "private"; note?: string },
): Promise<string> {
  const spec = dashboardSpec.parse(p.spec);
  // Id generated here: RLS evaluates RETURNING against the read policy, which can't see the new row yet.
  const id = randomUUID();
  await db.query(
    `INSERT INTO dashboards (id, workspace_id, business_id, name, description, date_range, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, p.workspaceId, p.businessId, spec.name, spec.description, JSON.stringify(spec.dateRange), p.visibility ?? "business", p.userId],
  );
  await writeWidgets(db, id, p.businessId, spec);
  await db.query(`INSERT INTO dashboard_versions (dashboard_id, business_id, version, spec, note, created_by) VALUES ($1, $2, 1, $3, $4, $5)`, [
    id, p.businessId, JSON.stringify(spec), p.note ?? "Created", p.userId,
  ]);
  return id;
}

async function writeWidgets(db: pg.PoolClient, dashboardId: string, businessId: string, spec: DashboardSpec) {
  await db.query("DELETE FROM dashboard_widgets WHERE dashboard_id = $1", [dashboardId]);
  if (!spec.widgets.length) return;
  await db.query(
    `INSERT INTO dashboard_widgets (id, dashboard_id, business_id, type, title, query, options, refresh, layout, position)
     SELECT id, $1, $2, type, title, query, options, refresh, layout, position
       FROM jsonb_to_recordset($3::jsonb) AS t(id text, type text, title text, query jsonb, options jsonb, refresh jsonb, layout jsonb, position int)`,
    [dashboardId, businessId, JSON.stringify(spec.widgets.map((w, i) => ({ ...w, position: i })))],
  );
}

interface DashRow {
  id: string;
  business_id: string;
  name: string;
  description: string;
  date_range: unknown;
  visibility: "business" | "private";
  version: number;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: Date;
  widget_count: number;
  share_edit: boolean | null;
}

const SELECT = `
  SELECT d.id, d.business_id, d.name, d.description, d.date_range, d.visibility, d.version, d.created_by, d.updated_at,
         u.name AS created_by_name,
         (SELECT count(*)::int FROM dashboard_widgets w WHERE w.dashboard_id = d.id) AS widget_count,
         (SELECT s.can_edit FROM dashboard_shares s WHERE s.dashboard_id = d.id AND s.user_id = $2) AS share_edit
    FROM dashboards d LEFT JOIN users u ON u.id = d.created_by`;

/** Edit rights: analysts and up, on dashboards they can see; private ones only for owner/admins/edit-shares. */
function canEdit(row: DashRow, userId: string, role: EffectiveBusinessRole) {
  if (!can(role, "dashboard.write")) return false;
  if (row.visibility === "business") return true;
  return row.created_by === userId || role === "owner" || role === "admin" || row.share_edit === true;
}

function summary(row: DashRow, userId: string, role: EffectiveBusinessRole): DashboardSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    version: row.version,
    widgetCount: row.widget_count,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: new Date(row.updated_at).toISOString(),
    canEdit: canEdit(row, userId, role),
    isOwner: row.created_by === userId,
  };
}

export async function listDashboards(db: pg.PoolClient, businessId: string, userId: string, role: EffectiveBusinessRole) {
  // RLS (app.can_view_dashboard) hides private dashboards the user may not see.
  const { rows } = await db.query<DashRow>(`${SELECT} WHERE d.business_id = $1 ORDER BY d.updated_at DESC`, [businessId, userId]);
  return rows.map((r) => summary(r, userId, role));
}

async function loadRow(db: pg.PoolClient, businessId: string, dashboardId: string, userId: string) {
  const { rows } = await db.query<DashRow>(`${SELECT} WHERE d.business_id = $1 AND d.id = $3`, [businessId, userId, dashboardId]);
  if (!rows[0]) throw notFound("Dashboard");
  return rows[0];
}

export async function getDashboard(db: pg.PoolClient, businessId: string, dashboardId: string, userId: string, role: EffectiveBusinessRole): Promise<DashboardDetail> {
  const row = await loadRow(db, businessId, dashboardId, userId);
  const widgets = await db.query(
    `SELECT id, type, title, query, options, refresh, layout FROM dashboard_widgets WHERE dashboard_id = $1 ORDER BY position`,
    [dashboardId],
  );
  const spec = dashboardSpec.parse({ name: row.name, description: row.description, dateRange: row.date_range, widgets: widgets.rows });
  return { ...summary(row, userId, role), spec };
}

export async function saveDashboard(
  db: pg.PoolClient,
  p: { businessId: string; dashboardId: string; userId: string; role: EffectiveBusinessRole; spec: DashboardSpec; expectedVersion: number; note?: string },
) {
  const row = await loadRow(db, p.businessId, p.dashboardId, p.userId);
  if (!canEdit(row, p.userId, p.role)) throw forbidden("You can view this dashboard but not edit it.");
  const spec = dashboardSpec.parse(p.spec);
  const next = row.version + 1;
  // Optimistic concurrency: refuse to overwrite someone else's newer save.
  const upd = await db.query(
    `UPDATE dashboards SET name = $3, description = $4, date_range = $5, version = $6, updated_at = now()
      WHERE id = $1 AND business_id = $2 AND version = $7`,
    [p.dashboardId, p.businessId, spec.name, spec.description, JSON.stringify(spec.dateRange), next, p.expectedVersion],
  );
  if (!upd.rowCount) throw conflict("This dashboard was changed by someone else. Reload to see the latest version.");
  await writeWidgets(db, p.dashboardId, p.businessId, spec);
  await db.query(`INSERT INTO dashboard_versions (dashboard_id, business_id, version, spec, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [
    p.dashboardId, p.businessId, next, JSON.stringify(spec), p.note ?? null, p.userId,
  ]);
  return next;
}

export async function listVersions(db: pg.PoolClient, businessId: string, dashboardId: string) {
  const { rows } = await db.query(
    `SELECT v.version, v.note, v.created_at, u.name AS created_by_name, jsonb_array_length(v.spec->'widgets') AS widgets
       FROM dashboard_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.dashboard_id = $1 AND v.business_id = $2 ORDER BY v.version DESC LIMIT 100`,
    [dashboardId, businessId],
  );
  return rows.map((r) => ({ version: r.version, note: r.note, createdAt: r.created_at, createdByName: r.created_by_name, widgets: r.widgets }));
}

export async function getVersionSpec(db: pg.PoolClient, businessId: string, dashboardId: string, version: number): Promise<DashboardSpec> {
  const { rows } = await db.query(`SELECT spec FROM dashboard_versions WHERE dashboard_id = $1 AND business_id = $2 AND version = $3`, [dashboardId, businessId, version]);
  if (!rows[0]) throw notFound("Version");
  return dashboardSpec.parse(rows[0].spec);
}
