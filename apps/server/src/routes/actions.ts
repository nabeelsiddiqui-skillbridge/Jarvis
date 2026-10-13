import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { can } from "@bca/shared";
import { decide, listActionTypes, listTargets, loadProposals, notifyApprovers, propose, queueExecution } from "../actions/engine.js";

/**
 * External actions API. Proposing needs action.propose (analyst+); approving needs
 * action.approve (owner/admin) and the exact payload hash the approver reviewed.
 * Execution happens in the worker after re-verification.
 */
export const actionsRouter = Router();
actionsRouter.use(requireUser);

const perUser = (r: any) => r.user?.id ?? r.ip ?? "";

actionsRouter.get("/businesses/:businessId/actions/types", async (req, res) => {
  res.json(await inBusiness(req, req.params.businessId, "business.read", ({ db, business }) => listActionTypes(db, business.id)));
});

actionsRouter.get("/businesses/:businessId/actions/targets", rateLimit({ name: "action-targets", max: 30, windowMs: 60_000, key: perUser }), async (req, res) => {
  const q = z.object({ connectionId: z.string().uuid(), type: z.string().max(80) }).parse(req.query);
  res.json(await inBusiness(req, req.params.businessId, "action.propose", ({ db, business }) => listTargets(db, business.id, q.connectionId, q.type)));
});

const proposeBody = z.object({
  connectionId: z.string().uuid(),
  type: z.string().max(80),
  targetId: z.string().min(1).max(100),
  params: z.record(z.string(), z.union([z.string().max(100), z.number().finite()])),
});

actionsRouter.post("/businesses/:businessId/actions", rateLimit({ name: "action-propose", max: 20, windowMs: 60_000, key: perUser }), async (req, res) => {
  const body = proposeBody.parse(req.body);
  const out = await inBusiness(req, req.params.businessId, "action.propose", async ({ db, business, userId }) => {
    const { id } = await propose(db, { business, userId, connectionId: body.connectionId, type: body.type, targetId: body.targetId, params: body.params, source: "user" });
    return { business, proposal: (await loadProposals(db, business.id, "p.id = $2", [id]))[0]! };
  });
  await withSystem((db) => notifyApprovers(db, out.business, out.proposal.id, `${out.proposal.actionLabel} — ${out.proposal.target.name}`, req.user!.id));
  res.status(201).json(out.proposal);
});

actionsRouter.get("/businesses/:businessId/actions", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "all";
  res.json(await inBusiness(req, req.params.businessId, "business.read", ({ db, business }) =>
    status === "pending" ? loadProposals(db, business.id, "p.status = 'pending_approval'") : loadProposals(db, business.id)));
});

actionsRouter.get("/businesses/:businessId/actions/:actionId", async (req, res) => {
  if (!isUuid(req.params.actionId)) throw notFound("Action");
  const out = await inBusiness(req, req.params.businessId, "business.read", async ({ db, business }) => (await loadProposals(db, business.id, "p.id = $2", [req.params.actionId]))[0]);
  if (!out) throw notFound("Action");
  res.json(out);
});

const decisionBody = z.object({ payloadHash: z.string().regex(/^[0-9a-f]{64}$/), comment: z.string().max(500).optional() });

for (const decision of ["approved", "rejected"] as const) {
  actionsRouter.post(`/businesses/:businessId/actions/:actionId/${decision === "approved" ? "approve" : "reject"}`, rateLimit({ name: "action-decide", max: 30, windowMs: 60_000, key: perUser }), async (req, res) => {
    const body = decisionBody.parse(req.body);
    if (!isUuid(req.params.actionId)) throw notFound("Action");
    const row = await inBusiness(req, req.params.businessId, "action.approve", ({ db, business, userId }) =>
      decide(db, { business, userId, proposalId: String(req.params.actionId), payloadHash: body.payloadHash, decision, comment: body.comment }));
    if (decision === "approved") await withSystem((db) => queueExecution(db, row));
    res.json({ ok: true, status: decision === "approved" ? "approved" : "rejected" });
  });
}

actionsRouter.post("/businesses/:businessId/actions/:actionId/cancel", async (req, res) => {
  if (!isUuid(req.params.actionId)) throw notFound("Action");
  await inBusiness(req, req.params.businessId, "action.propose", async ({ db, business, userId, role }) => {
    const row = (await db.query(`SELECT * FROM action_proposals WHERE id = $1 AND business_id = $2 FOR UPDATE`, [req.params.actionId, business.id])).rows[0];
    if (!row) throw notFound("Action");
    if (row.proposed_by !== userId && !can(role, "action.approve")) throw forbidden("Only the proposer or an administrator can cancel this.");
    if (row.status !== "pending_approval") throw conflict("Only actions waiting for approval can be cancelled.");
    await db.query(`UPDATE action_proposals SET status = 'cancelled', updated_at = now() WHERE id = $1`, [row.id]);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "action.cancelled", targetType: "action", targetId: row.id });
  });
  res.json({ ok: true });
});
