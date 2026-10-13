import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { BUSINESS_ROLES, businessInput, goalInput } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, inWorkspace, isUuid, toBusiness } from "../auth/access.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";

export const businessesRouter = Router();
businessesRouter.use(requireUser);

// ------------------------------------------------------------------ list / create (workspace scope)

businessesRouter.get("/workspaces/:workspaceId/businesses", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const rows = await inWorkspace(req, req.params.workspaceId, null, async ({ db, workspaceId }) => {
    const { rows } = await db.query(
      `SELECT b.*, app.business_role(b.id) AS role FROM businesses b
        WHERE b.workspace_id = $1 AND b.archived_at IS NULL AND ($2 = '' OR b.name ILIKE '%' || $2 || '%')
        ORDER BY b.is_demo, lower(b.name)`,
      [workspaceId, q.replace(/[%_\\]/g, (c) => `\\${c}`)],
    );
    // RLS already hides businesses the user can't access; role is never null here.
    return rows.filter((r) => r.role);
  });
  res.json(rows.map(toBusiness));
});

businessesRouter.post("/workspaces/:workspaceId/businesses", async (req, res) => {
  const body = businessInput.parse(req.body);
  const id = randomUUID();
  await inWorkspace(req, req.params.workspaceId, "business.create", async ({ db, workspaceId, userId }) => {
    await db.query(
      `INSERT INTO businesses (id, workspace_id, name, logo_url, industry, website, timezone, currency, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, workspaceId, body.name, body.logoUrl || null, body.industry, body.website || null, body.timezone, body.currency, body.description || null, userId],
    );
    await audit(db, { workspaceId, businessId: id, actorUserId: userId, action: "business.created", targetType: "business", targetId: id, metadata: { name: body.name }, ip: req.ip });
  });
  res.status(201).json({ id });
});

// ------------------------------------------------------------------ single business

businessesRouter.get("/businesses/:businessId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "business.read", async ({ business, role }) => toBusiness({ ...business, role }));
  res.json(out);
});

businessesRouter.patch("/businesses/:businessId", async (req, res) => {
  const body = businessInput.partial().parse(req.body);
  await inBusiness(req, req.params.businessId, "business.update", async ({ db, business, userId }) => {
    const map: Record<string, string> = {
      name: "name", logoUrl: "logo_url", industry: "industry", website: "website",
      timezone: "timezone", currency: "currency", description: "description",
    };
    const sets: string[] = [];
    const vals: unknown[] = [business.id];
    for (const [k, col] of Object.entries(map)) {
      const v = (body as Record<string, unknown>)[k];
      if (v === undefined) continue;
      vals.push(v === "" ? null : v);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return;
    await db.query(`UPDATE businesses SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "business.updated", targetType: "business", targetId: business.id, metadata: { fields: Object.keys(body) }, ip: req.ip });
  });
  res.json({ ok: true });
});

/** Permanently deletes the business and all of its data (connections, facts, dashboards, conversations…). */
businessesRouter.delete("/businesses/:businessId", async (req, res) => {
  const body = z.object({ confirmName: z.string() }).parse(req.body);
  await inBusiness(req, req.params.businessId, "business.delete", async ({ db, business, userId }) => {
    if (body.confirmName !== business.name) throw badRequest("Type the business name exactly to confirm deletion.");
    await audit(db, { workspaceId: business.workspace_id, businessId: null, actorUserId: userId, action: "business.deleted", targetType: "business", targetId: business.id, metadata: { name: business.name }, ip: req.ip });
    await db.query("DELETE FROM businesses WHERE id = $1", [business.id]);
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ business access (who can see this business)

businessesRouter.get("/businesses/:businessId/access", async (req, res) => {
  const rows = await inBusiness(req, req.params.businessId, "business.read", async ({ db, business }) => {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, wm.role AS workspace_role, bm.role AS business_role
         FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id
         LEFT JOIN business_memberships bm ON bm.user_id = wm.user_id AND bm.business_id = $2
        WHERE wm.workspace_id = $1 ORDER BY u.name`,
      [business.workspace_id, business.id],
    );
    return rows;
  });
  res.json(
    rows.map((r) => ({
      userId: r.id,
      name: r.name,
      email: r.email,
      workspaceRole: r.workspace_role,
      role: r.workspace_role === "owner" ? "owner" : r.business_role ?? null,
    })),
  );
});

businessesRouter.put("/businesses/:businessId/access/:userId", async (req, res) => {
  const body = z.object({ role: z.enum(BUSINESS_ROLES).nullable() }).parse(req.body);
  await inBusiness(req, req.params.businessId, "business.members.manage", async ({ db, business, userId, role: myRole }) => {
    const target = String(req.params.userId);
    if (!isUuid(target)) throw notFound("Member");
    const wm = await db.query("SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2", [business.workspace_id, target]);
    if (!wm.rows[0]) throw badRequest("Invite this person to the workspace first.");
    if (wm.rows[0].role === "owner") throw badRequest("Workspace owners always have full access to every business.");
    // Admins can't mint other admins; only owners can.
    if (body.role === "admin" && myRole !== "owner") throw badRequest("Only workspace owners can grant the administrator role.");
    if (body.role === null) {
      await db.query("DELETE FROM business_memberships WHERE business_id = $1 AND user_id = $2", [business.id, target]);
    } else {
      await db.query(
        `INSERT INTO business_memberships (business_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, user_id) DO UPDATE SET role = excluded.role`,
        [business.id, business.workspace_id, target, body.role],
      );
    }
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "business.access_changed", targetType: "user", targetId: target, metadata: { role: body.role }, ip: req.ip });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ goals (always user-confirmed)

const toGoal = (r: any) => ({
  id: r.id,
  businessId: r.business_id,
  title: r.title,
  metricKey: r.metric_key,
  targetValue: r.target_value,
  period: r.period,
  notes: r.notes,
  confirmedByUser: true,
  createdAt: r.created_at,
});

businessesRouter.get("/businesses/:businessId/goals", async (req, res) => {
  const rows = await inBusiness(req, req.params.businessId, "business.read", async ({ db, business }) =>
    (await db.query("SELECT * FROM business_goals WHERE business_id = $1 ORDER BY created_at", [business.id])).rows,
  );
  res.json(rows.map(toGoal));
});

businessesRouter.post("/businesses/:businessId/goals", async (req, res) => {
  const body = goalInput.parse(req.body);
  const row = await inBusiness(req, req.params.businessId, "goals.write", async ({ db, business, userId }) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO business_goals (id, workspace_id, business_id, title, metric_key, target_value, period, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, business.workspace_id, business.id, body.title, body.metricKey ?? null, body.targetValue ?? null, body.period, body.notes ?? null, userId],
    );
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "goal.created", targetType: "goal", targetId: id, metadata: { title: body.title }, ip: req.ip });
    return (await db.query("SELECT * FROM business_goals WHERE id = $1", [id])).rows[0];
  });
  res.status(201).json(toGoal(row));
});

businessesRouter.patch("/businesses/:businessId/goals/:goalId", async (req, res) => {
  const body = goalInput.partial().parse(req.body);
  await inBusiness(req, req.params.businessId, "goals.write", async ({ db, business, userId }) => {
    if (!isUuid(req.params.goalId)) throw notFound("Goal");
    const r = await db.query(
      `UPDATE business_goals SET title = coalesce($3, title), metric_key = CASE WHEN $4::boolean THEN $5 ELSE metric_key END,
              target_value = CASE WHEN $6::boolean THEN $7::numeric ELSE target_value END, period = coalesce($8, period), notes = coalesce($9, notes)
        WHERE id = $1 AND business_id = $2`,
      [req.params.goalId, business.id, body.title ?? null, body.metricKey !== undefined, body.metricKey ?? null, body.targetValue !== undefined, body.targetValue ?? null, body.period ?? null, body.notes ?? null],
    );
    if (!r.rowCount) throw notFound("Goal");
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "goal.updated", targetType: "goal", targetId: String(req.params.goalId), ip: req.ip });
  });
  res.json({ ok: true });
});

businessesRouter.delete("/businesses/:businessId/goals/:goalId", async (req, res) => {
  await inBusiness(req, req.params.businessId, "goals.write", async ({ db, business, userId }) => {
    if (!isUuid(req.params.goalId)) throw notFound("Goal");
    await db.query("DELETE FROM business_goals WHERE id = $1 AND business_id = $2", [req.params.goalId, business.id]);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "goal.deleted", targetType: "goal", targetId: String(req.params.goalId), ip: req.ip });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ audit trail

businessesRouter.get("/businesses/:businessId/audit", async (req, res) => {
  const rows = await inBusiness(req, req.params.businessId, "audit.read", async ({ db, business }) =>
    (
      await db.query(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.actor_type, a.created_at, u.name AS actor_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.business_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
        [business.id],
      )
    ).rows,
  );
  res.json(rows.map((r) => ({ id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id, metadata: r.metadata, actorType: r.actor_type, actorName: r.actor_name, createdAt: r.created_at })));
});
