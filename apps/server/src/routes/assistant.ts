import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { dashboardSpec, type AssistantStreamEvent, type ConversationSummary, type DisplayMessage, type ProposalSummary } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { audit } from "../lib/audit.js";
import { conflict, notFound, prerequisite } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { assistantConfigured, runTurn } from "../assistant/agent.js";
import { getDashboard, getVersionSpec, saveDashboard, saveNewDashboard } from "../dashboards/store.js";

/**
 * AI assistant API. Conversations are private to their user and scoped to one
 * business. Replies stream as server-sent events on the POST response.
 */
export const assistantRouter = Router();
assistantRouter.use(requireUser);

const DAILY_LIMIT = Number(process.env.ASSISTANT_DAILY_MESSAGES ?? 300);

assistantRouter.get("/businesses/:businessId/assistant/status", async (req, res) => {
  await inBusiness(req, req.params.businessId, "assistant.use", async () => undefined);
  res.json({
    configured: assistantConfigured(),
    reason: assistantConfigured() ? null : "The platform operator hasn't configured an AI provider key (ANTHROPIC_API_KEY), so the assistant can't answer yet.",
    dailyLimit: DAILY_LIMIT,
  });
});

assistantRouter.get("/businesses/:businessId/assistant/conversations", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "assistant.use", async ({ db, business }) => {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.updated_at, (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id) AS n
         FROM conversations c WHERE c.business_id = $1 ORDER BY c.updated_at DESC LIMIT 100`,
      [business.id],
    );
    return rows.map((r): ConversationSummary => ({ id: r.id, title: r.title, updatedAt: r.updated_at, messageCount: r.n }));
  });
  res.json(out);
});

assistantRouter.post("/businesses/:businessId/assistant/conversations", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "assistant.use", async ({ db, business, userId }) => {
    const id = randomUUID();
    await db.query(`INSERT INTO conversations (id, workspace_id, business_id, user_id) VALUES ($1, $2, $3, $4)`, [id, business.workspace_id, business.id, userId]);
    return { id };
  });
  res.status(201).json(out);
});

assistantRouter.get("/businesses/:businessId/assistant/conversations/:conversationId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "assistant.use", async ({ db, business }) => {
    if (!isUuid(req.params.conversationId)) throw notFound("Conversation");
    const conv = (await db.query(`SELECT id, title, updated_at FROM conversations WHERE id = $1 AND business_id = $2`, [req.params.conversationId, business.id])).rows[0];
    if (!conv) throw notFound("Conversation");
    const rows = (await db.query(`SELECT display FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq`, [conv.id])).rows;
    const messages = rows.map((r) => r.display as DisplayMessage);
    // Proposal status changes after the message was written (applied, undone…): refresh it.
    const ids = messages.flatMap((m) => m.proposals.map((p) => p.id));
    if (ids.length) {
      const st = new Map((await db.query(`SELECT id, status, applied_version, dashboard_id FROM dashboard_proposals WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.id, r]));
      for (const m of messages) for (const p of m.proposals) {
        const s = st.get(p.id);
        if (s) Object.assign(p, { status: s.status, appliedVersion: s.applied_version, dashboardId: s.dashboard_id });
      }
    }
    return { id: conv.id, title: conv.title, updatedAt: conv.updated_at, messages };
  });
  res.json(out);
});

assistantRouter.delete("/businesses/:businessId/assistant/conversations/:conversationId", async (req, res) => {
  await inBusiness(req, req.params.businessId, "assistant.use", async ({ db, business }) => {
    if (!isUuid(req.params.conversationId)) throw notFound("Conversation");
    const r = await db.query(`DELETE FROM conversations WHERE id = $1 AND business_id = $2`, [req.params.conversationId, business.id]);
    if (!r.rowCount) throw notFound("Conversation");
  });
  res.json({ ok: true });
});

const messageBody = z.object({ text: z.string().trim().min(1, "Type a question").max(4000), voice: z.boolean().optional() });
const perUser = (req: Request) => req.user?.id ?? req.ip ?? "anon";

assistantRouter.post(
  "/businesses/:businessId/assistant/conversations/:conversationId/messages",
  rateLimit({ name: "assistant", max: 20, windowMs: 60_000, key: perUser }),
  async (req, res) => {
    const body = messageBody.parse(req.body);
    if (!isUuid(req.params.conversationId)) throw notFound("Conversation");
    await inBusiness(req, req.params.businessId, "assistant.use", async ({ db, business, userId }) => {
      if (!assistantConfigured()) throw prerequisite("The AI assistant isn't configured on this platform yet: an administrator must set ANTHROPIC_API_KEY.");
      const conv = await db.query(`SELECT 1 FROM conversations WHERE id = $1 AND business_id = $2`, [req.params.conversationId, business.id]);
      if (!conv.rowCount) throw notFound("Conversation");
      const today = await db.query(
        `SELECT count(*)::int AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = $1 AND m.role = 'user' AND m.created_at > now() - interval '1 day'`,
        [userId],
      );
      if (today.rows[0].n >= DAILY_LIMIT) throw prerequisite(`You've reached today's limit of ${DAILY_LIMIT} assistant messages. It resets over the next 24 hours.`);
    });

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    const emit = (e: AssistantStreamEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000);
    try {
      await runTurn({ userId: req.user!.id, businessId: String(req.params.businessId), conversationId: String(req.params.conversationId), text: body.text, voice: body.voice ?? false, signal: abort.signal, emit });
    } catch (e) {
      console.error("[assistant] turn crashed", e);
      emit({ type: "error", message: "Something went wrong while generating the answer." });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  },
);

// ------------------------------------------------------------------ dashboard proposals

function toSummary(r: any): ProposalSummary {
  return { id: r.id, kind: r.kind, dashboardId: r.dashboard_id, name: r.spec.name, summary: r.summary, widgetCount: r.spec.widgets.length, status: r.status, appliedVersion: r.applied_version };
}

async function loadProposal(db: import("pg").PoolClient, businessId: string, id: unknown) {
  if (!isUuid(id)) throw notFound("Proposal");
  const r = (await db.query(`SELECT * FROM dashboard_proposals WHERE id = $1 AND business_id = $2`, [id, businessId])).rows[0];
  if (!r) throw notFound("Proposal");
  return r;
}

assistantRouter.get("/businesses/:businessId/assistant/proposals/:proposalId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "assistant.use", async ({ db, business }) => {
    const p = await loadProposal(db, business.id, req.params.proposalId);
    return { ...toSummary(p), spec: dashboardSpec.parse(p.spec), baseVersion: p.base_version };
  });
  res.json(out);
});

assistantRouter.post("/businesses/:businessId/assistant/proposals/:proposalId/apply", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId, role }) => {
    const p = await loadProposal(db, business.id, req.params.proposalId);
    if (p.status !== "pending") throw conflict(`This proposal was already ${p.status}.`);
    const spec = dashboardSpec.parse(p.spec);
    let dashboardId: string, version: number;
    if (p.kind === "create") {
      dashboardId = await saveNewDashboard(db, { workspaceId: business.workspace_id, businessId: business.id, userId, spec, note: "Created by the AI assistant" });
      version = 1;
    } else {
      dashboardId = p.dashboard_id;
      version = await saveDashboard(db, { businessId: business.id, dashboardId, userId, role, spec, expectedVersion: p.base_version, note: `AI assistant: ${p.summary}`.slice(0, 200) }).catch((e) => {
        if (e?.status === 409) throw conflict("The dashboard changed after this proposal was made. Ask the assistant for a fresh proposal.");
        throw e;
      });
    }
    await db.query(`UPDATE dashboard_proposals SET status = 'applied', applied_version = $2, dashboard_id = $3, applied_at = now() WHERE id = $1`, [p.id, version, dashboardId]);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: p.kind === "create" ? "dashboard.created" : "dashboard.updated", targetType: "dashboard", targetId: dashboardId, metadata: { via: "assistant", proposalId: p.id, name: spec.name } });
    return { ...toSummary({ ...p, status: "applied", applied_version: version, dashboard_id: dashboardId }) };
  });
  res.json(out);
});

assistantRouter.post("/businesses/:businessId/assistant/proposals/:proposalId/discard", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "assistant.use", async ({ db, business }) => {
    const p = await loadProposal(db, business.id, req.params.proposalId);
    if (p.status !== "pending") throw conflict(`This proposal was already ${p.status}.`);
    await db.query(`UPDATE dashboard_proposals SET status = 'discarded' WHERE id = $1`, [p.id]);
    return toSummary({ ...p, status: "discarded" });
  });
  res.json(out);
});

/** Undo an applied proposal: delete a created dashboard, or restore the version it replaced. */
assistantRouter.post("/businesses/:businessId/assistant/proposals/:proposalId/undo", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId, role }) => {
    const p = await loadProposal(db, business.id, req.params.proposalId);
    if (p.status !== "applied") throw conflict("Only applied proposals can be undone.");
    const current = await getDashboard(db, business.id, p.dashboard_id, userId, role).catch(() => null);
    if (!current) throw conflict("That dashboard no longer exists.");
    if (current.version !== p.applied_version) throw conflict("The dashboard has been edited since; restore an earlier version from its history instead.");
    if (p.kind === "create") {
      await db.query(`DELETE FROM dashboards WHERE id = $1 AND business_id = $2`, [p.dashboard_id, business.id]);
    } else {
      const prev = await getVersionSpec(db, business.id, p.dashboard_id, p.base_version);
      await saveDashboard(db, { businessId: business.id, dashboardId: p.dashboard_id, userId, role, spec: prev, expectedVersion: p.applied_version, note: "Undid AI assistant change" });
    }
    await db.query(`UPDATE dashboard_proposals SET status = 'undone' WHERE id = $1`, [p.id]);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: p.kind === "create" ? "dashboard.deleted" : "dashboard.updated", targetType: "dashboard", targetId: p.dashboard_id, metadata: { via: "assistant_undo", proposalId: p.id } });
    return toSummary({ ...p, status: "undone" });
  });
  res.json(out);
});
