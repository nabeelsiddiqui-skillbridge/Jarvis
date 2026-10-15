import { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PLANS, PLAN_IDS } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { isUuid } from "../auth/access.js";
import { config, configStatus } from "../config.js";
import { withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { FLAG_KEYS } from "../lib/flags.js";
import { EnvironmentManaged, MANAGED_SETTINGS, isManaged, setPlatformSecret, settingSource, settingUpdatedAt } from "../lib/platformSecrets.js";
import { notifyWorkspaceOwners } from "../lib/notify.js";
import { rateLimit } from "../lib/rateLimit.js";
import { guideFor } from "../connectors/guides.js";
import { IMPLEMENTED, connectorStatus } from "../connectors/registry.js";
import { effectivePlan, currentUsage } from "../billing/entitlements.js";
import { priceFor, stripeConfigured, webhookConfigured } from "../billing/stripe.js";

/**
 * Platform administration. Restricted to platform administrators (users.is_platform_admin,
 * set from PLATFORM_ADMIN_EMAILS). These views show operational metadata — counts, statuses,
 * errors, usage — not customer business data. Viewing a customer's data requires a
 * time-limited support grant with a stated reason, which is audited in the customer's own
 * audit log and announced to the workspace owners. Every write here is audited.
 */
export const adminRouter = Router();

function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isPlatformAdmin) return next(forbidden("Platform administrators only."));
  next();
}
adminRouter.use("/admin", requireUser, requirePlatformAdmin, rateLimit({ name: "admin", max: 240, windowMs: 60_000, key: (r: any) => r.user?.id ?? "" }));

const page = (v: unknown, d: number, max: number) => Math.min(max, Math.max(1, Number(v) || d));

// ------------------------------------------------------------------ overview

adminRouter.get("/admin/overview", async (_req, res) => {
  const out = await withSystem(async (db) => {
    const counts = (await db.query(
      `SELECT (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL)::int AS disabled_users,
              (SELECT count(*) FROM users WHERE last_login_at > now() - interval '30 days')::int AS active_users_30d,
              (SELECT count(*) FROM workspaces)::int AS workspaces,
              (SELECT count(*) FROM businesses WHERE archived_at IS NULL AND NOT is_demo)::int AS businesses,
              (SELECT count(*) FROM businesses WHERE archived_at IS NULL AND is_demo)::int AS demo_businesses,
              (SELECT count(*) FROM connections WHERE disconnected_at IS NULL AND NOT is_demo)::int AS connections,
              (SELECT count(*) FROM connections WHERE disconnected_at IS NULL AND NOT is_demo AND status IN ('error', 'reauth_required'))::int AS failing_connections,
              (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at <= now())::int AS jobs_due,
              (SELECT count(*) FROM jobs WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS jobs_failed_24h,
              (SELECT extract(epoch FROM now() - min(run_at)) FROM jobs WHERE status = 'queued' AND run_at <= now())::int AS oldest_due_seconds,
              (SELECT count(*) FROM support_access_grants WHERE revoked_at IS NULL AND expires_at > now())::int AS active_support_grants`,
    )).rows[0];
    const subs = (await db.query(`SELECT * FROM workspace_subscriptions`)).rows;
    const byPlan: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const s of subs) {
      const p = effectivePlan(s);
      byPlan[p] = (byPlan[p] ?? 0) + 1;
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    const mrr = subs.filter((s) => s.stripe_subscription_id && ["active", "past_due"].includes(s.status)).reduce((n, s) => n + (PLANS[effectivePlan(s)]?.priceMonthly ?? 0), 0);
    const usage = (await db.query(
      `SELECT kind, coalesce(sum(quantity), 0)::float AS quantity,
              coalesce(sum((meta->>'input_tokens')::bigint), 0)::float AS input_tokens,
              coalesce(sum((meta->>'output_tokens')::bigint), 0)::float AS output_tokens
         FROM usage_events WHERE created_at > now() - interval '30 days' GROUP BY kind`,
    )).rows;
    return { counts, subscriptions: { byPlan, byStatus, listMrr: mrr }, usage30d: usage };
  });
  res.json(out);
});

// ------------------------------------------------------------------ customers & workspaces

adminRouter.get("/admin/workspaces", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const limit = page(req.query.limit, 50, 200);
  const rows = await withSystem(async (db) => (await db.query(
    `SELECT w.id, w.name, w.created_at,
            (SELECT u.email FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = w.id AND wm.role = 'owner' ORDER BY wm.created_at LIMIT 1) AS owner_email,
            (SELECT count(*) FROM workspace_memberships wm WHERE wm.workspace_id = w.id)::int AS members,
            (SELECT count(*) FROM businesses b WHERE b.workspace_id = w.id AND b.archived_at IS NULL AND NOT b.is_demo)::int AS businesses,
            (SELECT count(*) FROM connections c WHERE c.workspace_id = w.id AND c.disconnected_at IS NULL AND NOT c.is_demo)::int AS connections,
            (SELECT count(*) FROM connections c WHERE c.workspace_id = w.id AND c.disconnected_at IS NULL AND NOT c.is_demo AND c.status IN ('error', 'reauth_required'))::int AS failing_connections,
            (SELECT coalesce(sum(quantity), 0) FROM usage_events e WHERE e.workspace_id = w.id AND e.kind = 'ai_message' AND e.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS ai_messages_month,
            s.plan, s.status, s.trial_ends_at, s.stripe_subscription_id, s.current_period_end, s.cancel_at_period_end
       FROM workspaces w LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
      WHERE $1 = '' OR w.name ILIKE '%' || $1 || '%' OR EXISTS (
              SELECT 1 FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = w.id AND (u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%'))
      ORDER BY w.created_at DESC LIMIT $2`,
    [q.replace(/[%_\\]/g, "\\$&"), limit],
  )).rows);
  res.json(rows.map((r) => ({ ...r, effectivePlan: effectivePlan(r.status ? { ...r, workspace_id: r.id } : undefined) })));
});

adminRouter.get("/admin/workspaces/:id", async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound("Workspace");
  const out = await withSystem(async (db) => {
    const w = (await db.query(`SELECT id, name, created_at, data_retention_days FROM workspaces WHERE id = $1`, [req.params.id])).rows[0];
    if (!w) throw notFound("Workspace");
    // One connection runs one query at a time: these run in sequence.
    const q = async (sql: string) => db.query(sql, [w.id]);
    const [members, businesses, connections, subscription, grants, audits, billingEvents] = [
      await q(`SELECT u.id, u.name, u.email, u.disabled_at, u.last_login_at, wm.role FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = $1 ORDER BY wm.created_at`),
      await q(`SELECT id, name, industry, is_demo, created_at, archived_at FROM businesses WHERE workspace_id = $1 ORDER BY created_at`),
      await q(`SELECT c.id, c.business_id, b.name AS business_name, c.provider, c.display_name, c.status, c.last_success_at, c.last_error, c.last_error_at, c.consecutive_failures, c.created_at
                  FROM connections c JOIN businesses b ON b.id = c.business_id WHERE c.workspace_id = $1 AND c.disconnected_at IS NULL AND NOT c.is_demo ORDER BY c.created_at`),
      await q(`SELECT * FROM workspace_subscriptions WHERE workspace_id = $1`),
      await q(`SELECT g.id, g.reason, g.created_at, g.expires_at, g.revoked_at, u.email AS admin_email FROM support_access_grants g JOIN users u ON u.id = g.admin_user_id WHERE g.workspace_id = $1 ORDER BY g.created_at DESC LIMIT 20`),
      await q(`SELECT a.id, a.action, a.actor_type, a.target_type, a.created_at, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT 30`),
      await q(`SELECT id, type, status, received_at FROM billing_events WHERE workspace_id = $1 ORDER BY received_at DESC LIMIT 10`),
    ];
    const sub = subscription.rows[0];
    return {
      workspace: w,
      members: members.rows,
      businesses: businesses.rows,
      connections: connections.rows,
      subscription: sub ? { ...sub, effectivePlan: effectivePlan(sub) } : null,
      usage: await currentUsage(db, w.id),
      limits: PLANS[effectivePlan(sub)].limits,
      supportGrants: grants.rows,
      recentAudit: audits.rows,
      billingEvents: billingEvents.rows,
    };
  });
  res.json(out);
});

const subscriptionBody = z.object({ plan: z.enum(PLAN_IDS), status: z.enum(["active", "trialing"]), trialDays: z.number().int().min(1).max(90).optional(), reason: z.string().trim().min(5).max(300) });

/** Grant a plan without Stripe (comp, pilot, trial extension). Stripe-managed subscriptions are changed in Stripe. */
adminRouter.post("/admin/workspaces/:id/subscription", async (req, res) => {
  const body = subscriptionBody.parse(req.body);
  if (!isUuid(req.params.id)) throw notFound("Workspace");
  await withSystem(async (db) => {
    const s = (await db.query(`SELECT * FROM workspace_subscriptions WHERE workspace_id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!s) throw notFound("Workspace");
    if (s.stripe_subscription_id && ["active", "trialing", "past_due"].includes(s.status)) throw conflict("This workspace has a live Stripe subscription; change it in Stripe so billing stays consistent.");
    const trialEnds = body.status === "trialing" ? new Date(Date.now() + (body.trialDays ?? 14) * 86_400_000) : null;
    await db.query(`UPDATE workspace_subscriptions SET plan = $2, status = $3, trial_ends_at = $4, updated_at = now() WHERE workspace_id = $1`, [s.workspace_id, body.plan, body.status, trialEnds]);
    await audit(db, { workspaceId: s.workspace_id, actorUserId: req.user!.id, actorType: "support", action: "admin.subscription_changed", targetType: "subscription", targetId: s.workspace_id, metadata: { from: { plan: s.plan, status: s.status }, to: { plan: body.plan, status: body.status, trialEndsAt: trialEnds }, reason: body.reason }, ip: req.ip });
  });
  res.json({ ok: true });
});

adminRouter.post("/admin/users/:id/disabled", async (req, res) => {
  const body = z.object({ disabled: z.boolean(), reason: z.string().trim().min(5).max(300) }).parse(req.body);
  if (!isUuid(req.params.id)) throw notFound("User");
  if (req.params.id === req.user!.id) throw badRequest("You can't disable your own account.");
  await withSystem(async (db) => {
    const u = (await db.query(`SELECT id, is_platform_admin FROM users WHERE id = $1`, [req.params.id])).rows[0];
    if (!u) throw notFound("User");
    await db.query(`UPDATE users SET disabled_at = ${body.disabled ? "coalesce(disabled_at, now())" : "NULL"} WHERE id = $1`, [u.id]);
    if (body.disabled) await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
    await audit(db, { actorUserId: req.user!.id, actorType: "support", action: body.disabled ? "admin.user_disabled" : "admin.user_enabled", targetType: "user", targetId: u.id, metadata: { reason: body.reason }, ip: req.ip });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ connector health & sync failures

adminRouter.get("/admin/connectors", async (_req, res) => {
  const out = await withSystem(async (db) => {
    const byStatus = (await db.query(
      `SELECT provider, status, count(*)::int AS n FROM connections WHERE disconnected_at IS NULL AND NOT is_demo GROUP BY 1, 2`,
    )).rows;
    const syncs = (await db.query(
      `SELECT c.provider, j.status, count(*)::int AS n FROM jobs j JOIN connections c ON c.id = j.connection_id
        WHERE j.type = 'connection.sync' AND j.created_at > now() - interval '24 hours' GROUP BY 1, 2`,
    )).rows;
    const webhooks = (await db.query(
      `SELECT provider, status, count(*)::int AS n, max(received_at) AS last_at FROM webhook_receipts WHERE received_at > now() - interval '24 hours' GROUP BY 1, 2`,
    )).rows;
    const failures = (await db.query(
      `SELECT c.id, c.provider, c.display_name, c.status, c.last_error, c.last_error_at, c.consecutive_failures, c.last_success_at,
              b.name AS business_name, w.id AS workspace_id, w.name AS workspace_name
         FROM connections c JOIN businesses b ON b.id = c.business_id JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.disconnected_at IS NULL AND NOT c.is_demo AND (c.status IN ('error', 'reauth_required') OR c.consecutive_failures > 0)
        ORDER BY c.last_error_at DESC NULLS LAST LIMIT 100`,
    )).rows;
    const providers = IMPLEMENTED.map((d) => {
      const s = connectorStatus(d);
      const count = (status?: string) => byStatus.filter((r) => r.provider === d.id && (!status || r.status === status)).reduce((n, r) => n + r.n, 0);
      const sync = (status: string) => syncs.find((r) => r.provider === d.id && r.status === status)?.n ?? 0;
      return {
        id: d.id, name: d.name, config: s.status, missingConfig: s.missingConfig,
        connections: count(), active: count("active"), failing: count("error") + count("reauth_required"), reauth: count("reauth_required"),
        syncs24h: { succeeded: sync("succeeded"), failed: sync("failed"), running: sync("running"), queued: sync("queued") },
        webhooks24h: webhooks.filter((r) => r.provider === d.id).reduce((acc, r) => ({ ...acc, [r.status]: r.n, lastAt: !acc.lastAt || r.last_at > acc.lastAt ? r.last_at : acc.lastAt }), {} as Record<string, any>),
      };
    });
    return { providers, failures };
  });
  res.json(out);
});

// ------------------------------------------------------------------ jobs

adminRouter.get("/admin/jobs", async (req, res) => {
  const status = typeof req.query.status === "string" && ["queued", "running", "succeeded", "failed", "cancelled"].includes(req.query.status) ? req.query.status : null;
  const type = typeof req.query.type === "string" ? req.query.type.slice(0, 60) : null;
  const out = await withSystem(async (db) => {
    const summary = (await db.query(
      `SELECT type, status, count(*)::int AS n FROM jobs WHERE created_at > now() - interval '24 hours' OR status IN ('queued', 'running') GROUP BY 1, 2 ORDER BY 1, 2`,
    )).rows;
    const jobs = (await db.query(
      `SELECT j.id, j.type, j.status, j.attempts, j.max_attempts, j.run_at, j.started_at, j.finished_at, j.last_error, j.created_at, j.locked_by,
              w.name AS workspace_name, b.name AS business_name
         FROM jobs j LEFT JOIN workspaces w ON w.id = j.workspace_id LEFT JOIN businesses b ON b.id = j.business_id
        WHERE ($1::text IS NULL OR j.status = $1) AND ($2::text IS NULL OR j.type = $2)
        ORDER BY j.created_at DESC LIMIT 100`,
      [status, type],
    )).rows;
    return { summary, jobs };
  });
  res.json(out);
});

adminRouter.post("/admin/jobs/:id/retry", async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound("Job");
  await withSystem(async (db) => {
    const j = (await db.query(`SELECT id, type, status, workspace_id, dedupe_key FROM jobs WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!j) throw notFound("Job");
    if (j.status !== "failed") throw conflict("Only failed jobs can be retried.");
    if (j.dedupe_key) {
      const dup = await db.query(`SELECT 1 FROM jobs WHERE dedupe_key = $1 AND status IN ('queued', 'running') AND id <> $2`, [j.dedupe_key, j.id]);
      if (dup.rowCount) throw conflict("The same work is already queued or running.");
    }
    await db.query(`UPDATE jobs SET status = 'queued', run_at = now(), attempts = 0, last_error = NULL, finished_at = NULL, locked_by = NULL, locked_at = NULL WHERE id = $1`, [j.id]);
    await audit(db, { workspaceId: j.workspace_id, actorUserId: req.user!.id, actorType: "support", action: "admin.job_retried", targetType: "job", targetId: j.id, metadata: { type: j.type }, ip: req.ip });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ AI & voice usage

adminRouter.get("/admin/usage", async (req, res) => {
  const days = page(req.query.days, 30, 365);
  const out = await withSystem(async (db) => {
    const daily = (await db.query(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, kind, sum(quantity)::float AS quantity,
              coalesce(sum((meta->>'input_tokens')::bigint), 0)::float AS input_tokens, coalesce(sum((meta->>'output_tokens')::bigint), 0)::float AS output_tokens
         FROM usage_events WHERE created_at > now() - make_interval(days => $1) GROUP BY 1, 2 ORDER BY 1`,
      [days],
    )).rows;
    const byWorkspace = (await db.query(
      `SELECT w.id, w.name,
              coalesce(sum(e.quantity) FILTER (WHERE e.kind = 'ai_message'), 0)::int AS ai_messages,
              coalesce(sum(e.quantity) FILTER (WHERE e.kind = 'ai_background'), 0)::int AS ai_background,
              coalesce(sum((e.meta->>'input_tokens')::bigint), 0)::float AS input_tokens,
              coalesce(sum((e.meta->>'output_tokens')::bigint), 0)::float AS output_tokens,
              coalesce(sum(e.quantity) FILTER (WHERE e.kind = 'voice_session'), 0)::int AS voice_sessions,
              coalesce(sum(e.quantity) FILTER (WHERE e.kind = 'tts_characters'), 0)::int AS tts_characters
         FROM usage_events e JOIN workspaces w ON w.id = e.workspace_id
        WHERE e.created_at > now() - make_interval(days => $1) GROUP BY w.id, w.name ORDER BY ai_messages DESC, input_tokens DESC LIMIT 50`,
      [days],
    )).rows;
    const byFeature = (await db.query(
      `SELECT coalesce(meta->>'feature', kind) AS feature, count(*)::int AS calls,
              coalesce(sum((meta->>'input_tokens')::bigint), 0)::float AS input_tokens, coalesce(sum((meta->>'output_tokens')::bigint), 0)::float AS output_tokens
         FROM usage_events WHERE kind IN ('ai_message', 'ai_background') AND created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY calls DESC`,
      [days],
    )).rows;
    return { days, daily, byWorkspace, byFeature };
  });
  res.json(out);
});

// ------------------------------------------------------------------ feature flags

adminRouter.get("/admin/flags", async (_req, res) => {
  const rows = await withSystem(async (db) => (await db.query(`SELECT key, description, enabled, overrides, updated_at FROM feature_flags ORDER BY key`)).rows);
  res.json(rows);
});

const flagBody = z.object({ enabled: z.boolean(), overrides: z.record(z.uuid(), z.boolean()).default({}) });

adminRouter.put("/admin/flags/:key", async (req, res) => {
  const key = String(req.params.key);
  if (!(FLAG_KEYS as readonly string[]).includes(key)) throw notFound("Flag");
  const body = flagBody.parse(req.body);
  await withSystem(async (db) => {
    const before = (await db.query(`SELECT enabled, overrides FROM feature_flags WHERE key = $1 FOR UPDATE`, [key])).rows[0];
    if (!before) throw notFound("Flag");
    const ids = Object.keys(body.overrides);
    if (ids.length) {
      const n = (await db.query(`SELECT count(*)::int AS n FROM workspaces WHERE id = ANY($1::uuid[])`, [ids])).rows[0].n;
      if (n !== ids.length) throw badRequest("An override refers to a workspace that doesn't exist.");
    }
    await db.query(`UPDATE feature_flags SET enabled = $2, overrides = $3, updated_at = now() WHERE key = $1`, [key, body.enabled, JSON.stringify(body.overrides)]);
    await audit(db, { actorUserId: req.user!.id, actorType: "support", action: "admin.flag_changed", targetType: "feature_flag", targetId: key, metadata: { before, after: body }, ip: req.ip });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ provider configuration status

adminRouter.get("/admin/config", (_req, res) => {
  res.json({
    environment: config.env,
    appUrl: config.appUrl,
    apiUrl: config.apiUrl,
    secrets: configStatus(),
    connectors: IMPLEMENTED.map((d) => ({ id: d.id, name: d.name, ...connectorStatus(d), redirectUri: `${config.apiUrl}/api/oauth/${d.id}/callback`, webhookUrl: d.verifyWebhook ? `${config.apiUrl}/api/webhooks/${d.id}` : null, adminSetup: guideFor(d.id, `${config.apiUrl}/api/oauth/${d.id}/callback`)?.adminSetup ?? [] })),
    billing: {
      stripeConfigured: stripeConfigured(),
      webhookConfigured: webhookConfigured(),
      webhookUrl: `${config.apiUrl}/api/webhooks/stripe`,
      prices: (["starter", "growth", "agency"] as const).map((p) => ({ plan: p, configured: Boolean(priceFor(p)) })),
    },
    platformAdmins: config.platformAdmins.length,
  });
});

// ------------------------------------------------------------------ provider credentials (set from the console)

adminRouter.get("/admin/settings", (_req, res) => {
  res.json(MANAGED_SETTINGS.map((m) => {
    const value = process.env[m.key]?.trim();
    return {
      key: m.key, label: m.label, group: m.group, secret: m.secret, help: m.help ?? null,
      configured: Boolean(value),
      source: settingSource(m.key),
      updatedAt: settingUpdatedAt(m.key),
      // Identifiers (client IDs, price IDs) are shown so they can be checked; secrets never are.
      value: !m.secret && value ? value : null,
    };
  }));
});

const settingBody = z.object({ value: z.string().trim().min(1, "Enter a value").max(4096) });

adminRouter.put("/admin/settings/:key", async (req, res) => {
  const key = String(req.params.key);
  if (!isManaged(key)) throw notFound("Setting");
  const { value } = settingBody.parse(req.body);
  if (/[\r\n]/.test(value)) throw badRequest("The value can't contain line breaks.");
  try {
    await setPlatformSecret(key, value, req.user!.id);
  } catch (e) {
    if (e instanceof EnvironmentManaged) throw conflict("This setting is defined in the hosting environment; change it there.");
    throw e;
  }
  await withSystem((db) => audit(db, { actorUserId: req.user!.id, actorType: "support", action: "admin.setting_changed", targetType: "setting", targetId: key, metadata: { change: "set" }, ip: req.ip }));
  res.json({ ok: true });
});

adminRouter.delete("/admin/settings/:key", async (req, res) => {
  const key = String(req.params.key);
  if (!isManaged(key)) throw notFound("Setting");
  try {
    await setPlatformSecret(key, null, req.user!.id);
  } catch (e) {
    if (e instanceof EnvironmentManaged) throw conflict("This setting is defined in the hosting environment; change it there.");
    throw e;
  }
  await withSystem((db) => audit(db, { actorUserId: req.user!.id, actorType: "support", action: "admin.setting_changed", targetType: "setting", targetId: key, metadata: { change: "cleared" }, ip: req.ip }));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ audit history

adminRouter.get("/admin/audit", async (req, res) => {
  const workspaceId = isUuid(req.query.workspaceId) ? req.query.workspaceId : null;
  const action = typeof req.query.action === "string" && req.query.action ? req.query.action.slice(0, 80) : null;
  const actorType = typeof req.query.actorType === "string" && ["user", "system", "support"].includes(req.query.actorType) ? req.query.actorType : null;
  const before = Number(req.query.before) || null;
  const rows = await withSystem(async (db) => (await db.query(
    `SELECT a.id, a.workspace_id, w.name AS workspace_name, a.business_id, b.name AS business_name, a.actor_type, u.email AS actor_email,
            a.action, a.target_type, a.target_id, a.metadata, a.ip::text AS ip, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN workspaces w ON w.id = a.workspace_id LEFT JOIN businesses b ON b.id = a.business_id
      WHERE ($1::uuid IS NULL OR a.workspace_id = $1) AND ($2::text IS NULL OR a.action LIKE $2 || '%') AND ($3::text IS NULL OR a.actor_type = $3) AND ($4::bigint IS NULL OR a.id < $4)
      ORDER BY a.id DESC LIMIT 100`,
    [workspaceId, action, actorType, before],
  )).rows);
  res.json(rows);
});

// ------------------------------------------------------------------ support access

adminRouter.get("/admin/support-access", async (req, res) => {
  const rows = await withSystem(async (db) => (await db.query(
    `SELECT g.id, g.workspace_id, w.name AS workspace_name, g.reason, g.created_at, g.expires_at, g.revoked_at, u.email AS admin_email, g.admin_user_id = $1 AS mine,
            (SELECT json_agg(json_build_object('id', b.id, 'name', b.name) ORDER BY b.created_at) FROM businesses b WHERE b.workspace_id = g.workspace_id AND b.archived_at IS NULL) AS businesses
       FROM support_access_grants g JOIN users u ON u.id = g.admin_user_id JOIN workspaces w ON w.id = g.workspace_id
      ORDER BY (g.revoked_at IS NULL AND g.expires_at > now()) DESC, g.created_at DESC LIMIT 50`,
    [req.user!.id],
  )).rows);
  res.json(rows);
});

const grantBody = z.object({ workspaceId: z.uuid(), reason: z.string().trim().min(10).max(500), minutes: z.number().int().min(15).max(240) });

adminRouter.post("/admin/support-access", async (req, res) => {
  const body = grantBody.parse(req.body);
  const id = randomUUID();
  await withSystem(async (db) => {
    const w = (await db.query(`SELECT id, name FROM workspaces WHERE id = $1`, [body.workspaceId])).rows[0];
    if (!w) throw notFound("Workspace");
    const member = await db.query(`SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`, [w.id, req.user!.id]);
    if (member.rowCount) throw conflict("You're a member of this workspace; support access isn't needed.");
    await db.query(`UPDATE support_access_grants SET revoked_at = now() WHERE workspace_id = $1 AND admin_user_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [w.id, req.user!.id]);
    const expires = new Date(Date.now() + body.minutes * 60_000);
    await db.query(`INSERT INTO support_access_grants (id, admin_user_id, workspace_id, reason, expires_at) VALUES ($1, $2, $3, $4, $5)`, [id, req.user!.id, w.id, body.reason, expires]);
    await audit(db, { workspaceId: w.id, actorUserId: req.user!.id, actorType: "support", action: "support.access_granted", targetType: "support_grant", targetId: id, metadata: { reason: body.reason, expiresAt: expires.toISOString(), minutes: body.minutes }, ip: req.ip });
    await notifyWorkspaceOwners(db, {
      workspaceId: w.id, kind: "support_access",
      title: "Support access opened",
      body: `A platform administrator (${req.user!.email}) has read-only access until ${expires.toISOString().slice(11, 16)} UTC. Reason: ${body.reason}`,
      link: `/app/w/${w.id}/settings`,
      dedupeKey: `support:${id}`,
    });
  });
  res.status(201).json({ id });
});

adminRouter.post("/admin/support-access/:id/revoke", async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound("Grant");
  await withSystem(async (db) => {
    const g = (await db.query(`UPDATE support_access_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING workspace_id`, [req.params.id])).rows[0];
    if (!g) throw notFound("Active grant");
    await audit(db, { workspaceId: g.workspace_id, actorUserId: req.user!.id, actorType: "support", action: "support.access_revoked", targetType: "support_grant", targetId: String(req.params.id), ip: req.ip });
  });
  res.json({ ok: true });
});
