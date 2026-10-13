import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { TEMPLATES, can, dashboardSpec, instantiate } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, inWorkspace, isUuid } from "../auth/access.js";
import { withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { availableBaseMetrics, loadAvailability } from "../metrics/engine.js";
import { getDashboard, getVersionSpec, listDashboards, listVersions, saveDashboard, saveNewDashboard } from "../dashboards/store.js";
import { createDemoBusiness } from "../demo/generate.js";
import { runDetection } from "../jobs/handlers.js";
import { enqueue } from "../jobs/queue.js";
import { nextRunAt } from "../automations/schedule.js";

export const dashboardsRouter = Router();
dashboardsRouter.use(requireUser);

const newId = () => randomUUID().slice(0, 8);

dashboardsRouter.get("/businesses/:businessId/dashboards", async (req, res) => {
  res.json(await inBusiness(req, req.params.businessId, "dashboard.read", ({ db, business, userId, role }) => listDashboards(db, business.id, userId, role)));
});

/** Templates with what each would contain for this business's data. */
dashboardsRouter.get("/businesses/:businessId/dashboard-templates", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business }) => {
    const available = availableBaseMetrics(await loadAvailability(db, business));
    return Object.entries(TEMPLATES).map(([id, t]) => {
      const { spec, omitted } = instantiate(t.name, t.widgets, available, newId);
      return { id, name: t.name, description: t.description, recommended: t.industries.includes("*") || t.industries.includes(business.industry), widgetCount: spec.widgets.length, omitted };
    });
  });
  res.json(out);
});

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  template: z.string().max(40).optional(),
  spec: dashboardSpec.optional(),
  visibility: z.enum(["business", "private"]).default("business"),
});

dashboardsRouter.post("/businesses/:businessId/dashboards", async (req, res) => {
  const body = createBody.parse(req.body);
  const out = await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId }) => {
    let spec = body.spec ? { ...body.spec, name: body.name } : { name: body.name, description: "", dateRange: { preset: "last_30_days" as const }, widgets: [] };
    let omitted: { title: string; missing: string[] }[] = [];
    if (body.template) {
      const t = TEMPLATES[body.template];
      if (!t) throw badRequest("Unknown template");
      const available = availableBaseMetrics(await loadAvailability(db, business));
      ({ spec, omitted } = instantiate(body.name, t.widgets, available, newId));
      spec.description = t.description;
    }
    const id = await saveNewDashboard(db, { workspaceId: business.workspace_id, businessId: business.id, userId, spec: dashboardSpec.parse(spec), visibility: body.visibility, note: body.template ? `Created from "${TEMPLATES[body.template]!.name}" template` : "Created" });
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "dashboard.created", targetType: "dashboard", targetId: id, metadata: { name: body.name, template: body.template } });
    return { id, omitted };
  });
  res.status(201).json(out);
});

dashboardsRouter.get("/businesses/:businessId/dashboards/:dashboardId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business, userId, role }) => {
    if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
    return getDashboard(db, business.id, String(req.params.dashboardId), userId, role);
  });
  res.json(out);
});

const saveBody = z.object({ spec: dashboardSpec, expectedVersion: z.number().int().min(1), note: z.string().max(200).optional() });

dashboardsRouter.put("/businesses/:businessId/dashboards/:dashboardId", async (req, res) => {
  const body = saveBody.parse(req.body);
  const version = await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId, role }) => {
    if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
    return saveDashboard(db, { businessId: business.id, dashboardId: String(req.params.dashboardId), userId, role, spec: body.spec, expectedVersion: body.expectedVersion, note: body.note });
  });
  res.json({ version });
});

dashboardsRouter.post("/businesses/:businessId/dashboards/:dashboardId/duplicate", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId, role }) => {
    if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
    const src = await getDashboard(db, business.id, String(req.params.dashboardId), userId, role);
    const spec = { ...src.spec, name: `${src.spec.name} (copy)`.slice(0, 120), widgets: src.spec.widgets.map((w) => ({ ...w, id: newId() })) };
    const id = await saveNewDashboard(db, { workspaceId: business.workspace_id, businessId: business.id, userId, spec, note: `Duplicated from "${src.name}"` });
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "dashboard.duplicated", targetType: "dashboard", targetId: id, metadata: { from: src.id } });
    return { id };
  });
  res.status(201).json(out);
});

dashboardsRouter.delete("/businesses/:businessId/dashboards/:dashboardId", async (req, res) => {
  await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId, role }) => {
    if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
    const d = await getDashboard(db, business.id, String(req.params.dashboardId), userId, role);
    if (!d.isOwner && role !== "owner" && role !== "admin") throw forbidden("Only the dashboard's creator or a business administrator can delete it.");
    await db.query("DELETE FROM dashboards WHERE id = $1 AND business_id = $2", [d.id, business.id]);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "dashboard.deleted", targetType: "dashboard", targetId: d.id, metadata: { name: d.name } });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ versions

dashboardsRouter.get("/businesses/:businessId/dashboards/:dashboardId/versions", async (req, res) => {
  res.json(
    await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business, userId, role }) => {
      if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
      await getDashboard(db, business.id, String(req.params.dashboardId), userId, role); // visibility check
      return listVersions(db, business.id, String(req.params.dashboardId));
    }),
  );
});

dashboardsRouter.get("/businesses/:businessId/dashboards/:dashboardId/versions/:version", async (req, res) => {
  res.json(
    await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business, userId, role }) => {
      if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
      await getDashboard(db, business.id, String(req.params.dashboardId), userId, role);
      return getVersionSpec(db, business.id, String(req.params.dashboardId), Number(req.params.version));
    }),
  );
});

dashboardsRouter.post("/businesses/:businessId/dashboards/:dashboardId/versions/:version/restore", async (req, res) => {
  const body = z.object({ expectedVersion: z.number().int() }).parse(req.body);
  const version = await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId, role }) => {
    if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
    const v = Number(req.params.version);
    const spec = await getVersionSpec(db, business.id, String(req.params.dashboardId), v);
    const next = await saveDashboard(db, { businessId: business.id, dashboardId: String(req.params.dashboardId), userId, role, spec, expectedVersion: body.expectedVersion, note: `Restored version ${v}` });
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "dashboard.version_restored", targetType: "dashboard", targetId: String(req.params.dashboardId), metadata: { restored: v, newVersion: next } });
    return next;
  });
  res.json({ version });
});

// ------------------------------------------------------------------ sharing

dashboardsRouter.get("/businesses/:businessId/dashboards/:dashboardId/sharing", async (req, res) => {
  res.json(
    await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business, userId, role }) => {
      if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
      const d = await getDashboard(db, business.id, String(req.params.dashboardId), userId, role);
      const shares = await db.query(
        `SELECT s.user_id, s.can_edit, u.name, u.email FROM dashboard_shares s JOIN users u ON u.id = s.user_id WHERE s.dashboard_id = $1 ORDER BY u.name`,
        [d.id],
      );
      return { visibility: d.visibility, shares: shares.rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, canEdit: r.can_edit })) };
    }),
  );
});

const sharingBody = z.object({
  visibility: z.enum(["business", "private"]),
  shares: z.array(z.object({ userId: z.uuid(), canEdit: z.boolean() })).max(200),
});

/** Sharing is limited to people who already have access to the business. */
dashboardsRouter.put("/businesses/:businessId/dashboards/:dashboardId/sharing", async (req, res) => {
  const body = sharingBody.parse(req.body);
  await inBusiness(req, req.params.businessId, "dashboard.share", async ({ db, business, userId, role }) => {
    if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
    const d = await getDashboard(db, business.id, String(req.params.dashboardId), userId, role);
    if (!d.isOwner && role !== "owner" && role !== "admin") throw forbidden("Only the dashboard's creator or a business administrator can change sharing.");
    for (const s of body.shares) {
      const target = await db.query(
        `SELECT CASE WHEN wm.role = 'owner' THEN 'owner' ELSE bm.role END AS role
           FROM workspace_memberships wm LEFT JOIN business_memberships bm ON bm.user_id = wm.user_id AND bm.business_id = $2
          WHERE wm.workspace_id = $1 AND wm.user_id = $3`,
        [business.workspace_id, business.id, s.userId],
      );
      const targetRole = target.rows[0]?.role;
      if (!targetRole) throw badRequest("You can only share with people who have access to this business.");
      if (s.canEdit && !can(targetRole, "dashboard.write")) throw badRequest("Viewers can't be given edit rights; grant them the analyst role first.");
    }
    await db.query("UPDATE dashboards SET visibility = $3, updated_at = now() WHERE id = $1 AND business_id = $2", [d.id, business.id, body.visibility]);
    await db.query("DELETE FROM dashboard_shares WHERE dashboard_id = $1", [d.id]);
    for (const s of body.shares) {
      await db.query("INSERT INTO dashboard_shares (dashboard_id, business_id, user_id, can_edit) VALUES ($1, $2, $3, $4)", [d.id, business.id, s.userId, s.canEdit]);
    }
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "dashboard.sharing_changed", targetType: "dashboard", targetId: d.id, metadata: body });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ demo mode

dashboardsRouter.post("/workspaces/:workspaceId/demo-business", async (req, res) => {
  const body = z.object({ currency: z.string().length(3).optional(), timezone: z.string().max(60).optional() }).parse(req.body ?? {});
  await inWorkspace(req, req.params.workspaceId, "business.create", async () => undefined);
  // Demo seeding writes connections/facts, which only system code paths may do.
  const out = await withSystem((db) => createDemoBusiness(db, String(req.params.workspaceId), req.user!.id, body.currency ?? "USD", body.timezone ?? "America/New_York"));
  // Demo extras (labelled demo): insights from the sample data, two automations, and a first briefing.
  await withSystem(async (db) => {
    const business = (await db.query(`SELECT * FROM businesses WHERE id = $1`, [out.businessId])).rows[0];
    await runDetection(db, business);
    const tz = business.timezone;
    for (const a of [
      { name: "Daily briefing", kind: "daily_briefing", trigger: { type: "schedule", frequency: "daily", hour: 8, minute: 0, weekday: 1 } },
      { name: "Connection failure alerts", kind: "connection_alert", trigger: { type: "event", event: "connection_failed" } },
    ]) {
      await db.query(
        `INSERT INTO automations (id, workspace_id, business_id, name, kind, enabled, trigger, timezone, next_run_at, created_by) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9)`,
        [randomUUID(), business.workspace_id, business.id, a.name, a.kind, JSON.stringify(a.trigger), tz, nextRunAt(a.trigger as any, tz), req.user!.id],
      );
    }
    await enqueue(db, { type: "report.generate", workspaceId: business.workspace_id, businessId: business.id, payload: { kind: "daily_briefing", userId: req.user!.id }, dedupeKey: `report:${business.id}:demo` });
  });
  res.status(201).json({ id: out.businessId });
});
