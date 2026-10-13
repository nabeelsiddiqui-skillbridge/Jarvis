import { randomUUID } from "node:crypto";
import { Router } from "express";
import { automationInput, type Automation, type AutomationRun } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { emailConfigured } from "../lib/mail.js";
import { withAccess } from "../lib/notify.js";
import { createRun, performActions } from "../automations/engine.js";
import { nextRunAt } from "../automations/schedule.js";

/** Automation builder API: CRUD, run now, run history, approvals and retries. */
export const automationsRouter = Router();
automationsRouter.use(requireUser);

const toRun = (r: any): AutomationRun => ({ id: r.id, automationId: r.automation_id, status: r.status, triggerInfo: r.trigger_info, attempts: r.attempts, output: r.output, error: r.error, pendingActions: r.pending_actions, decidedBy: r.decided_by_name ?? null, decidedAt: r.decided_at, createdAt: r.created_at, finishedAt: r.finished_at });
const toAutomation = (r: any, lastRun: any): Automation => ({
  id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, trigger: r.trigger, conditions: r.conditions, scope: r.scope, actions: r.actions,
  timezone: r.timezone, approvalPolicy: r.approval_policy, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastRun: lastRun ? toRun(lastRun) : null, createdAt: r.created_at,
});

const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };

automationsRouter.get("/businesses/:businessId/automations", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "automation.read", async ({ db, business }) => {
    const { rows } = await db.query(`SELECT * FROM automations WHERE business_id = $1 ORDER BY created_at`, [business.id]);
    const last = (await db.query(
      `SELECT DISTINCT ON (r.automation_id) r.*, u.name AS decided_by_name FROM automation_runs r LEFT JOIN users u ON u.id = r.decided_by
        WHERE r.business_id = $1 ORDER BY r.automation_id, r.created_at DESC`, [business.id])).rows;
    const byAuto = new Map(last.map((r) => [r.automation_id, r]));
    return { automations: rows.map((r) => toAutomation(r, byAuto.get(r.id))), emailConfigured: emailConfigured(), timezone: business.timezone };
  });
  res.json(out);
});

async function validate(db: import("pg").PoolClient, business: { id: string; timezone: string }, body: unknown) {
  const a = automationInput.parse(body);
  const tz = a.timezone ?? business.timezone;
  if (!validTz(tz)) throw badRequest("Unknown timezone");
  const users = [...a.actions.notify.userIds, ...(a.actions.task?.assigneeId ? [a.actions.task.assigneeId] : [])];
  if (users.length) {
    const ok = await withSystem((s) => withAccess(s, business.id, users));
    if (ok.length !== new Set(users).size) throw badRequest("Every recipient and assignee must have access to this business.");
  }
  if (a.scope.connectionIds.length) {
    const n = (await db.query(`SELECT count(*)::int AS n FROM connections WHERE business_id = $1 AND id = ANY($2::uuid[])`, [business.id, a.scope.connectionIds])).rows[0].n;
    if (n !== a.scope.connectionIds.length) throw badRequest("Unknown connection in scope");
  }
  return { a, tz, next: a.enabled ? nextRunAt(a.trigger, tz) : null };
}

automationsRouter.post("/businesses/:businessId/automations", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "automation.write", async ({ db, business, userId }) => {
    const { a, tz, next } = await validate(db, business, req.body);
    const id = randomUUID();
    await db.query(
      `INSERT INTO automations (id, workspace_id, business_id, name, kind, enabled, trigger, conditions, scope, actions, timezone, approval_policy, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, business.workspace_id, business.id, a.name, a.kind, a.enabled, JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.scope), JSON.stringify(a.actions), tz, a.approvalPolicy, next, userId],
    );
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "automation.created", targetType: "automation", targetId: id, metadata: { kind: a.kind, name: a.name } });
    return toAutomation((await db.query(`SELECT * FROM automations WHERE id = $1`, [id])).rows[0], null);
  });
  res.status(201).json(out);
});

automationsRouter.put("/businesses/:businessId/automations/:automationId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "automation.write", async ({ db, business, userId }) => {
    if (!isUuid(req.params.automationId)) throw notFound("Automation");
    const { a, tz, next } = await validate(db, business, req.body);
    const r = await db.query(
      `UPDATE automations SET name = $3, kind = $4, enabled = $5, trigger = $6, conditions = $7, scope = $8, actions = $9, timezone = $10, approval_policy = $11, next_run_at = $12, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [req.params.automationId, business.id, a.name, a.kind, a.enabled, JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.scope), JSON.stringify(a.actions), tz, a.approvalPolicy, next],
    );
    if (!r.rowCount) throw notFound("Automation");
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "automation.updated", targetType: "automation", targetId: String(req.params.automationId), metadata: { enabled: a.enabled } });
    return toAutomation((await db.query(`SELECT * FROM automations WHERE id = $1`, [req.params.automationId])).rows[0], null);
  });
  res.json(out);
});

automationsRouter.delete("/businesses/:businessId/automations/:automationId", async (req, res) => {
  await inBusiness(req, req.params.businessId, "automation.write", async ({ db, business, userId }) => {
    if (!isUuid(req.params.automationId)) throw notFound("Automation");
    const r = await db.query(`DELETE FROM automations WHERE id = $1 AND business_id = $2`, [req.params.automationId, business.id]);
    if (!r.rowCount) throw notFound("Automation");
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "automation.deleted", targetType: "automation", targetId: String(req.params.automationId) });
  });
  res.json({ ok: true });
});

/** Run a scheduled automation now. One manual run per minute (duplicate clicks collapse). */
automationsRouter.post("/businesses/:businessId/automations/:automationId/run", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "automation.write", async ({ db, business, userId }) => {
    if (!isUuid(req.params.automationId)) throw notFound("Automation");
    const a = (await db.query(`SELECT * FROM automations WHERE id = $1 AND business_id = $2`, [req.params.automationId, business.id])).rows[0];
    if (!a) throw notFound("Automation");
    if (a.trigger.type === "event") throw badRequest("This automation runs when its event happens; it can't be run on demand.");
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "automation.run_requested", targetType: "automation", targetId: a.id });
    return a;
  });
  const minute = new Date().toISOString().slice(0, 16);
  const runId = await withSystem((db) => createRun(db, out, `manual:${minute}`, { manual: true, requestedBy: req.user!.id }));
  res.status(202).json({ runId, duplicate: !runId });
});

automationsRouter.get("/businesses/:businessId/automations/:automationId/runs", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "automation.read", async ({ db, business }) => {
    if (!isUuid(req.params.automationId)) throw notFound("Automation");
    const { rows } = await db.query(
      `SELECT r.*, u.name AS decided_by_name FROM automation_runs r LEFT JOIN users u ON u.id = r.decided_by
        WHERE r.automation_id = $1 AND r.business_id = $2 ORDER BY r.created_at DESC LIMIT 50`, [req.params.automationId, business.id]);
    return rows.map(toRun);
  });
  res.json(out);
});

automationsRouter.get("/businesses/:businessId/automation-runs/:runId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "automation.read", async ({ db, business }) => {
    if (!isUuid(req.params.runId)) throw notFound("Run");
    const r = (await db.query(`SELECT r.*, u.name AS decided_by_name FROM automation_runs r LEFT JOIN users u ON u.id = r.decided_by WHERE r.id = $1 AND r.business_id = $2`, [req.params.runId, business.id])).rows[0];
    if (!r) throw notFound("Run");
    return toRun(r);
  });
  res.json(out);
});

/** Approve or reject held actions. Permission is re-checked here, not just in the UI. */
for (const decision of ["approve", "reject"] as const) {
  automationsRouter.post(`/businesses/:businessId/automation-runs/:runId/${decision}`, async (req, res) => {
    const run = await inBusiness(req, req.params.businessId, "action.approve", async ({ db, business, userId }) => {
      if (!isUuid(req.params.runId)) throw notFound("Run");
      // Claim the decision atomically so two approvers can't both execute it.
      const r = await db.query(
        `UPDATE automation_runs SET status = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND business_id = $2 AND status = 'awaiting_approval' RETURNING *`,
        [req.params.runId, business.id, decision === "approve" ? "running" : "rejected", userId],
      );
      if (!r.rows[0]) throw conflict("This run isn't waiting for approval (it may already have been decided).");
      await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: `automation.run_${decision === "approve" ? "approved" : "rejected"}`, targetType: "automation_run", targetId: String(req.params.runId) });
      return { ...r.rows[0], business };
    });
    if (decision === "approve") {
      try {
        await withSystem(async (db) => {
          const res2 = await performActions(db, run.business, run.pending_actions ?? {}, run.id);
          await db.query(`UPDATE automation_runs SET status = 'succeeded', output = output || $2::jsonb, finished_at = now() WHERE id = $1`, [run.id, JSON.stringify(res2)]);
        });
      } catch (e) {
        await withSystem((db) => db.query(`UPDATE automation_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [run.id, (e as Error).message]));
        throw e;
      }
    }
    res.json({ ok: true, status: decision === "approve" ? "succeeded" : "rejected" });
  });
}

automationsRouter.post("/businesses/:businessId/automation-runs/:runId/retry", async (req, res) => {
  const run = await inBusiness(req, req.params.businessId, "automation.write", async ({ db, business, userId }) => {
    if (!isUuid(req.params.runId)) throw notFound("Run");
    const r = (await db.query(`SELECT r.*, a.workspace_id FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.id = $1 AND r.business_id = $2`, [req.params.runId, business.id])).rows[0];
    if (!r) throw notFound("Run");
    if (r.status !== "failed") throw conflict("Only failed runs can be retried.");
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "automation.run_retried", targetType: "automation_run", targetId: r.id });
    return r;
  });
  await withSystem(async (db) => {
    await db.query(`UPDATE automation_runs SET status = 'queued', error = NULL WHERE id = $1 AND status = 'failed'`, [run.id]);
    const { enqueue } = await import("../jobs/queue.js");
    await enqueue(db, { type: "automation.run", workspaceId: run.workspace_id, businessId: run.business_id, payload: { runId: run.id }, dedupeKey: `autorun:${run.id}`, maxAttempts: 4 });
  });
  res.status(202).json({ queued: true });
});
