import { Router } from "express";
import { z } from "zod";
import { can, taskInput, type Task } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { badRequest, forbidden, notFound, prerequisite } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { withAccess } from "../lib/notify.js";
import { aiConfigured } from "../ai/complete.js";
import { enqueue } from "../jobs/queue.js";
import { runDetection } from "../jobs/handlers.js";
import { toInsight } from "../insights/store.js";
import { randomUUID } from "node:crypto";

/** Insights (deterministic findings + optional AI explanations) and internal tasks. */
export const insightsRouter = Router();
insightsRouter.use(requireUser);

const SELECT = `SELECT i.*, u.name AS status_by_name FROM insights i LEFT JOIN users u ON u.id = i.status_by`;

insightsRouter.get("/businesses/:businessId/insights", async (req, res) => {
  const status = String(req.query.status ?? "open");
  const out = await inBusiness(req, req.params.businessId, "insight.read", async ({ db, business }) => {
    const { rows } = await db.query(
      `${SELECT} WHERE i.business_id = $1 AND ($2 = 'all' OR i.status = $2)
        ORDER BY CASE WHEN i.status = 'open' THEN 0 ELSE 1 END, CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'positive' THEN 2 ELSE 3 END, i.detected_at DESC LIMIT 200`,
      [business.id, ["open", "acknowledged", "dismissed", "resolved", "all"].includes(status) ? status : "open"],
    );
    const counts = (await db.query(`SELECT status, count(*)::int AS n FROM insights WHERE business_id = $1 GROUP BY status`, [business.id])).rows;
    const lastRun = (await db.query(`SELECT max(finished_at) AS at FROM jobs WHERE business_id = $1 AND type = 'insights.detect' AND status = 'succeeded'`, [business.id])).rows[0]?.at ?? null;
    return { insights: rows.map(toInsight), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), lastDetectedAt: lastRun, aiConfigured: aiConfigured() };
  });
  res.json(out);
});

insightsRouter.get("/businesses/:businessId/insights/:insightId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "insight.read", async ({ db, business }) => {
    if (!isUuid(req.params.insightId)) throw notFound("Insight");
    const r = (await db.query(`${SELECT} WHERE i.id = $1 AND i.business_id = $2`, [req.params.insightId, business.id])).rows[0];
    if (!r) throw notFound("Insight");
    return toInsight(r);
  });
  res.json(out);
});

insightsRouter.patch("/businesses/:businessId/insights/:insightId", async (req, res) => {
  const body = z.object({ status: z.enum(["open", "acknowledged", "dismissed", "resolved"]) }).parse(req.body);
  const out = await inBusiness(req, req.params.businessId, "insight.manage", async ({ db, business, userId }) => {
    if (!isUuid(req.params.insightId)) throw notFound("Insight");
    const r = await db.query(`UPDATE insights SET status = $3, status_by = $4, status_at = now(), updated_at = now() WHERE id = $1 AND business_id = $2`, [req.params.insightId, business.id, body.status, userId]);
    if (!r.rowCount) throw notFound("Insight");
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: `insight.${body.status}`, targetType: "insight", targetId: String(req.params.insightId) });
    return toInsight((await db.query(`${SELECT} WHERE i.id = $1`, [req.params.insightId])).rows[0]);
  });
  res.json(out);
});

/** Run detection now (same rules as the scheduled run). */
insightsRouter.post("/businesses/:businessId/insights/detect", rateLimit({ name: "detect", max: 10, windowMs: 60_000, key: (r) => r.user?.id ?? r.ip ?? "" }), async (req, res) => {
  const business = await inBusiness(req, req.params.businessId, "insight.manage", async ({ business }) => business);
  const result = await withSystem((db) => runDetection(db, business));
  res.json(result);
});

insightsRouter.post("/businesses/:businessId/insights/:insightId/explain", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "insight.manage", async ({ db, business }) => {
    if (!aiConfigured()) throw prerequisite("AI explanations need ANTHROPIC_API_KEY on the platform. The finding itself is complete without it.");
    if (!isUuid(req.params.insightId)) throw notFound("Insight");
    const r = (await db.query(`SELECT id FROM insights WHERE id = $1 AND business_id = $2`, [req.params.insightId, business.id])).rows[0];
    if (!r) throw notFound("Insight");
    return business;
  });
  await withSystem(async (db) => {
    await db.query(`UPDATE insights SET explanation_status = 'pending' WHERE id = $1`, [req.params.insightId]);
    await enqueue(db, { type: "insight.explain", workspaceId: out.workspace_id, businessId: out.id, payload: { insightId: req.params.insightId }, dedupeKey: `explain:${req.params.insightId}`, maxAttempts: 3 });
  });
  res.status(202).json({ queued: true });
});

// ------------------------------------------------------------------ tasks

const toTask = (r: any): Task => ({ id: r.id, title: r.title, description: r.description, status: r.status, assigneeId: r.assignee_id, assigneeName: r.assignee_name ?? null, dueDate: r.due_date ? String(r.due_date).slice(0, 10) : null, source: r.source, insightId: r.insight_id, createdAt: r.created_at, completedAt: r.completed_at });
const TASKS = `SELECT t.*, t.due_date::text AS due_date, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id`;

insightsRouter.get("/businesses/:businessId/tasks", async (req, res) => {
  const status = req.query.status === "done" ? "done" : req.query.status === "all" ? "all" : "open";
  const out = await inBusiness(req, req.params.businessId, "insight.read", async ({ db, business }) => {
    const { rows } = await db.query(`${TASKS} WHERE t.business_id = $1 AND ($2 = 'all' OR t.status = $2) ORDER BY t.status, t.due_date NULLS LAST, t.created_at DESC LIMIT 300`, [business.id, status]);
    return rows.map(toTask);
  });
  res.json(out);
});

insightsRouter.post("/businesses/:businessId/tasks", async (req, res) => {
  const body = taskInput.parse(req.body);
  const out = await inBusiness(req, req.params.businessId, "insight.manage", async ({ db, business, userId }) => {
    if (body.assigneeId && !(await withSystem((s) => withAccess(s, business.id, [body.assigneeId!]))).length) throw badRequest("The assignee doesn't have access to this business.");
    if (body.insightId && !(await db.query(`SELECT 1 FROM insights WHERE id = $1 AND business_id = $2`, [body.insightId, business.id])).rowCount) throw notFound("Insight");
    const id = randomUUID();
    await db.query(
      `INSERT INTO tasks (id, workspace_id, business_id, title, description, assignee_id, due_date, source, insight_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, business.workspace_id, business.id, body.title, body.description, body.assigneeId, body.dueDate, body.insightId ? "insight" : "manual", body.insightId, userId],
    );
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "task.created", targetType: "task", targetId: id });
    return toTask((await db.query(`${TASKS} WHERE t.id = $1`, [id])).rows[0]);
  });
  res.status(201).json(out);
});

insightsRouter.patch("/businesses/:businessId/tasks/:taskId", async (req, res) => {
  const body = z.object({ status: z.enum(["open", "done"]).optional(), title: z.string().trim().min(1).max(200).optional(), assigneeId: z.string().uuid().nullable().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).parse(req.body);
  const out = await inBusiness(req, req.params.businessId, "insight.read", async ({ db, business, role }) => {
    if (!isUuid(req.params.taskId)) throw notFound("Task");
    if (!can(role, "insight.manage") && (body.title !== undefined || body.assigneeId !== undefined || body.dueDate !== undefined)) throw forbidden("You can mark your own tasks done; ask an analyst or administrator to change other details.");
    if (body.assigneeId && !(await withSystem((s) => withAccess(s, business.id, [body.assigneeId!]))).length) throw badRequest("The assignee doesn't have access to this business.");
    // RLS: analysts and up can edit any task; others only tasks assigned to them.
    const r = await db.query(
      `UPDATE tasks SET status = COALESCE($3, status), title = COALESCE($4, title),
              assignee_id = CASE WHEN $5::boolean THEN $6::uuid ELSE assignee_id END,
              due_date = CASE WHEN $7::boolean THEN $8::date ELSE due_date END,
              completed_at = CASE WHEN $3 = 'done' THEN now() WHEN $3 = 'open' THEN NULL ELSE completed_at END
        WHERE id = $1 AND business_id = $2`,
      [req.params.taskId, business.id, body.status ?? null, body.title ?? null, body.assigneeId !== undefined, body.assigneeId ?? null, body.dueDate !== undefined, body.dueDate ?? null],
    );
    if (!r.rowCount) throw notFound("Task");
    return toTask((await db.query(`${TASKS} WHERE t.id = $1`, [req.params.taskId])).rows[0]);
  });
  res.json(out);
});

insightsRouter.delete("/businesses/:businessId/tasks/:taskId", async (req, res) => {
  await inBusiness(req, req.params.businessId, "insight.manage", async ({ db, business }) => {
    if (!isUuid(req.params.taskId)) throw notFound("Task");
    const r = await db.query(`DELETE FROM tasks WHERE id = $1 AND business_id = $2`, [req.params.taskId, business.id]);
    if (!r.rowCount) throw notFound("Task");
  });
  res.json({ ok: true });
});
