import express, { Router } from "express";
import { z } from "zod";
import type pg from "pg";
import { PAID_PLANS, PLANS } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inWorkspace } from "../auth/access.js";
import { config } from "../config.js";
import { pool, withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { conflict, prerequisite } from "../lib/errors.js";
import { notifyWorkspaceOwners } from "../lib/notify.js";
import { rateLimit } from "../lib/rateLimit.js";
import { ProviderError } from "../connectors/http.js";
import { billingSummary, loadSubscription } from "../billing/entitlements.js";
import { planForPrice, priceFor, stripe, stripeConfigured, subscriptionPeriodEnd, verifyStripeWebhook, type StripeEvent } from "../billing/stripe.js";

/**
 * Billing: plan and usage for every workspace member; checkout and the Stripe
 * customer portal for workspace owners. Subscription state changes only through
 * signature-verified Stripe webhooks (or a platform administrator's audited grant).
 */
export const billingRouter = Router();

billingRouter.get("/workspaces/:workspaceId/billing", requireUser, async (req, res) => {
  const ws = await inWorkspace(req, req.params.workspaceId, null, async ({ workspaceId, role }) => ({ workspaceId, role }));
  res.json({ ...(await billingSummary(ws.workspaceId)), canManage: ws.role === "owner" });
});

const stripeError = (e: unknown): never => {
  if (e instanceof ProviderError) {
    console.warn("[billing] stripe error", e.kind, e.status, e.detail?.slice(0, 300));
    throw prerequisite("The payment provider couldn't start this right now. Try again in a moment.");
  }
  throw e;
};

async function ensureCustomer(workspaceId: string, user: { email: string; name: string }): Promise<string> {
  const s = await loadSubscription(pool, workspaceId);
  if (s?.stripe_customer_id) return s.stripe_customer_id;
  const ws = (await pool.query(`SELECT name FROM workspaces WHERE id = $1`, [workspaceId])).rows[0];
  // The idempotency key makes concurrent clicks create a single Stripe customer.
  const customer = await stripe<{ id: string }>("POST", "customers", { email: user.email, name: ws?.name ?? user.name, "metadata[workspace_id]": workspaceId }, `customer:${workspaceId}`).catch(stripeError);
  await pool.query(`UPDATE workspace_subscriptions SET stripe_customer_id = $2, updated_at = now() WHERE workspace_id = $1 AND stripe_customer_id IS NULL`, [workspaceId, customer.id]);
  return (await loadSubscription(pool, workspaceId))?.stripe_customer_id ?? customer.id;
}

const perUser = (r: any) => r.user?.id ?? r.ip ?? "";

billingRouter.post("/workspaces/:workspaceId/billing/checkout", requireUser, rateLimit({ name: "billing", max: 10, windowMs: 60_000, key: perUser }), async (req, res) => {
  const body = z.object({ plan: z.enum(PAID_PLANS) }).parse(req.body);
  const { workspaceId, userId } = await inWorkspace(req, req.params.workspaceId, "billing.manage", async (c) => c);
  if (!stripeConfigured()) throw prerequisite("Online payments aren't configured on this platform yet: an administrator must set STRIPE_SECRET_KEY.");
  const price = priceFor(body.plan);
  if (!price) throw prerequisite(`The ${PLANS[body.plan].name} plan has no Stripe price configured (STRIPE_PRICE_${body.plan.toUpperCase()}).`);
  const s = await loadSubscription(pool, workspaceId);
  if (s?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(s.status)) {
    throw conflict("This workspace already has a subscription. Use “Manage billing” to change plans or payment details.");
  }
  const customer = await ensureCustomer(workspaceId, req.user!);
  const session = await stripe<{ id: string; url: string }>("POST", "checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: workspaceId,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][workspace_id]": workspaceId,
    "metadata[workspace_id]": workspaceId,
    allow_promotion_codes: "true",
    success_url: `${config.appUrl}/app/w/${workspaceId}/billing?checkout=success`,
    cancel_url: `${config.appUrl}/app/w/${workspaceId}/billing?checkout=cancelled`,
  }).catch(stripeError);
  await withSystem((db) => audit(db, { workspaceId, actorUserId: userId, action: "billing.checkout_started", targetType: "plan", targetId: body.plan, ip: req.ip }));
  res.json({ url: session.url });
});

billingRouter.post("/workspaces/:workspaceId/billing/portal", requireUser, rateLimit({ name: "billing", max: 10, windowMs: 60_000, key: perUser }), async (req, res) => {
  const { workspaceId } = await inWorkspace(req, req.params.workspaceId, "billing.manage", async (c) => c);
  if (!stripeConfigured()) throw prerequisite("Online payments aren't configured on this platform yet: an administrator must set STRIPE_SECRET_KEY.");
  const s = await loadSubscription(pool, workspaceId);
  if (!s?.stripe_customer_id) throw prerequisite("There's no billing account yet. Choose a plan first.");
  const portal = await stripe<{ url: string }>("POST", "billing_portal/sessions", { customer: s.stripe_customer_id, return_url: `${config.appUrl}/app/w/${workspaceId}/billing` }).catch(stripeError);
  res.json({ url: portal.url });
});

// ------------------------------------------------------------------ webhook

export const billingWebhookRouter = Router();

billingWebhookRouter.post("/webhooks/stripe", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const ev = verifyStripeWebhook(req.body, req.get("stripe-signature") ?? undefined);
  if (!ev) return res.status(400).json({ error: { code: "invalid_signature", message: "Invalid webhook signature." } });
  try {
    const out = await withSystem(async (db) => {
      // Recorded and applied in one transaction: a failure rolls back so Stripe's retry is processed, a success makes replays no-ops.
      const ins = await db.query(`INSERT INTO billing_events (id, type, created_at) VALUES ($1, $2, to_timestamp($3)) ON CONFLICT (id) DO NOTHING RETURNING id`, [ev.id, ev.type, ev.created]);
      if (!ins.rowCount) return { duplicate: true };
      const result = await handleEvent(db, ev);
      await db.query(`UPDATE billing_events SET workspace_id = $2, status = $3 WHERE id = $1`, [ev.id, result.workspaceId, result.applied ? "processed" : "ignored"]);
      return { duplicate: false, ...result };
    });
    res.json({ received: true, ...out });
  } catch (e) {
    console.error("[billing] webhook failed", ev.type, ev.id, (e as Error).message);
    res.status(500).json({ error: { code: "processing_failed", message: "Webhook processing failed; it will be retried." } });
  }
});

async function workspaceFor(db: pg.PoolClient, obj: any): Promise<string | null> {
  const fromMeta = obj?.metadata?.workspace_id ?? obj?.client_reference_id ?? obj?.subscription_details?.metadata?.workspace_id;
  if (fromMeta) {
    const ok = await db.query(`SELECT 1 FROM workspaces WHERE id = $1`, [fromMeta]).catch(() => ({ rowCount: 0 }));
    if (ok.rowCount) return fromMeta;
  }
  const customer = typeof obj?.customer === "string" ? obj.customer : obj?.customer?.id;
  if (!customer) return null;
  return (await db.query(`SELECT workspace_id FROM workspace_subscriptions WHERE stripe_customer_id = $1`, [customer])).rows[0]?.workspace_id ?? null;
}

async function applySubscription(db: pg.PoolClient, workspaceId: string, sub: any, eventCreated: number, deleted = false) {
  const price = sub?.items?.data?.[0]?.price?.id ?? null;
  const plan = planForPrice(price);
  if (!plan) console.warn("[billing] subscription price isn't mapped to a plan", price);
  const status = deleted ? "canceled" : String(sub.status);
  const r = await db.query(
    `UPDATE workspace_subscriptions SET
        plan = coalesce($2, plan), status = $3, stripe_subscription_id = $4, stripe_customer_id = coalesce($5, stripe_customer_id),
        stripe_price_id = $6, current_period_end = $7, cancel_at_period_end = $8, trial_ends_at = NULL,
        stripe_event_created = to_timestamp($9), updated_at = now()
      WHERE workspace_id = $1 AND (stripe_event_created IS NULL OR stripe_event_created <= to_timestamp($9))
        -- A different subscription may only replace one that has ended (stale events for an old one are ignored).
        AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $4 OR status IN ('canceled', 'incomplete_expired'))
      RETURNING plan, status`,
    [workspaceId, plan, status, sub.id, typeof sub.customer === "string" ? sub.customer : null, price, subscriptionPeriodEnd(sub), Boolean(sub.cancel_at_period_end), eventCreated],
  );
  if (r.rowCount) {
    await audit(db, { workspaceId, actorType: "system", action: "billing.subscription_updated", targetType: "subscription", targetId: sub.id, metadata: { plan: r.rows[0].plan, status: r.rows[0].status, cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) } });
  }
  return Boolean(r.rowCount);
}

async function handleEvent(db: pg.PoolClient, ev: StripeEvent): Promise<{ workspaceId: string | null; applied: boolean }> {
  const obj = ev.data?.object ?? {};
  switch (ev.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription" || !obj.subscription) return { workspaceId: null, applied: false };
      const workspaceId = await workspaceFor(db, obj);
      if (!workspaceId) return { workspaceId: null, applied: false };
      const subId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription.id;
      // Read the subscription itself: the session doesn't carry its price or period.
      const sub = await stripe("GET", `subscriptions/${encodeURIComponent(subId)}`);
      const applied = await applySubscription(db, workspaceId, sub, ev.created);
      if (applied) await notifyWorkspaceOwners(db, { workspaceId, kind: "billing", title: "Subscription started", body: "Thanks — your new plan is active.", link: `/app/w/${workspaceId}/billing`, dedupeKey: `billing:${ev.id}` });
      return { workspaceId, applied };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const workspaceId = await workspaceFor(db, obj);
      if (!workspaceId) return { workspaceId: null, applied: false };
      return { workspaceId, applied: await applySubscription(db, workspaceId, obj, ev.created, ev.type === "customer.subscription.deleted") };
    }
    case "invoice.payment_failed": {
      const workspaceId = await workspaceFor(db, obj);
      if (!workspaceId) return { workspaceId: null, applied: false };
      await audit(db, { workspaceId, actorType: "system", action: "billing.payment_failed", targetType: "invoice", targetId: String(obj.id ?? "") });
      await notifyWorkspaceOwners(db, { workspaceId, kind: "billing", title: "Payment failed", body: "Update your payment method in Billing to keep your plan.", link: `/app/w/${workspaceId}/billing`, dedupeKey: `billing:${ev.id}` });
      return { workspaceId, applied: true };
    }
    default:
      return { workspaceId: null, applied: false };
  }
}
