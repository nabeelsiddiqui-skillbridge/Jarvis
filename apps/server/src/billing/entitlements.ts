import { LIMIT_LABELS, PLANS, PLAN_IDS, type BillingSummary, type PlanId, type PlanLimits, type SubscriptionStatus } from "@bca/shared";
import { pool, type Db } from "../db/pool.js";
import { AppError } from "../lib/errors.js";
import { purchasablePlans, stripeConfigured } from "./stripe.js";

/**
 * Plan entitlements. Limits are checked on the server before creating businesses,
 * connections and invitations, and before assistant questions and voice sessions.
 * Counts are read with the system pool so a member's restricted view (RLS) can't
 * make the workspace look emptier than it is.
 */

export interface SubscriptionRow {
  workspace_id: string;
  plan: string;
  status: SubscriptionStatus;
  trial_ends_at: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
}

const asPlan = (p: string): PlanId => ((PLAN_IDS as readonly string[]).includes(p) ? (p as PlanId) : "free");

export function effectivePlan(s: SubscriptionRow | undefined, now = new Date()): PlanId {
  if (!s) return "free";
  const plan = asPlan(s.plan);
  if (s.stripe_subscription_id) return ["active", "trialing", "past_due"].includes(s.status) ? plan : "free";
  if (s.status === "trialing") return s.trial_ends_at && s.trial_ends_at > now ? plan : "free";
  // A plan granted by a platform administrator without Stripe.
  if (s.status === "active") return plan;
  return "free";
}

export async function loadSubscription(db: Db, workspaceId: string): Promise<SubscriptionRow | undefined> {
  return (await db.query(`SELECT * FROM workspace_subscriptions WHERE workspace_id = $1`, [workspaceId])).rows[0];
}

export function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function currentUsage(db: Db, workspaceId: string): Promise<PlanLimits> {
  const { start } = monthBounds();
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM businesses WHERE workspace_id = $1 AND archived_at IS NULL AND NOT is_demo)::int AS businesses,
       (SELECT count(*) FROM connections WHERE workspace_id = $1 AND disconnected_at IS NULL AND NOT is_demo)::int AS connections,
       ((SELECT count(*) FROM workspace_memberships WHERE workspace_id = $1)
        + (SELECT count(*) FROM workspace_invitations WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()))::int AS members,
       (SELECT coalesce(sum(quantity), 0) FROM usage_events WHERE workspace_id = $1 AND kind = 'ai_message' AND created_at >= $2)::int AS ai_messages,
       (SELECT coalesce(sum(quantity), 0) FROM usage_events WHERE workspace_id = $1 AND kind = 'voice_session' AND created_at >= $2)::int AS voice_sessions`,
    [workspaceId, start],
  );
  const r = rows[0];
  return { businesses: r.businesses, connections: r.connections, members: r.members, aiMessages: r.ai_messages, voiceSessions: r.voice_sessions };
}

export async function billingSummary(workspaceId: string): Promise<BillingSummary> {
  const s = await loadSubscription(pool, workspaceId);
  const eff = effectivePlan(s);
  const usage = await currentUsage(pool, workspaceId);
  const { start, end } = monthBounds();
  const plan = asPlan(s?.plan ?? "free");
  let notice: string | null = null;
  if (s?.status === "trialing" && !s.stripe_subscription_id && eff === "free") notice = `Your ${PLANS[plan].name} trial has ended. The Free plan's limits now apply; existing data is kept.`;
  else if (s?.status === "past_due") notice = "The last payment failed. Update your payment method to keep your plan.";
  else if (s?.stripe_subscription_id && eff === "free") notice = "Your subscription has ended. The Free plan's limits now apply; existing data is kept.";
  else if (s?.cancel_at_period_end && s.current_period_end) notice = `Your subscription is set to end on ${s.current_period_end.toISOString().slice(0, 10)}.`;
  return {
    effectivePlan: eff,
    plan,
    status: s?.status ?? "none",
    trialEndsAt: s?.trial_ends_at?.toISOString() ?? null,
    currentPeriodEnd: s?.current_period_end?.toISOString() ?? null,
    cancelAtPeriodEnd: s?.cancel_at_period_end ?? false,
    managedByStripe: Boolean(s?.stripe_subscription_id),
    stripeConfigured: stripeConfigured(),
    purchasable: purchasablePlans(),
    limits: PLANS[eff].limits,
    usage,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    notice,
  };
}

const LIMIT_MESSAGES: Record<keyof PlanLimits, (n: number, plan: string) => string> = {
  businesses: (n, p) => `The ${p} plan includes ${n} business${n === 1 ? "" : "es"}. Upgrade in Billing to add more, or archive one you no longer need.`,
  connections: (n, p) => `The ${p} plan includes ${n} connected account${n === 1 ? "" : "s"}. Upgrade in Billing to connect more, or disconnect one.`,
  members: (n, p) => `The ${p} plan includes ${n} members (including pending invitations). Upgrade in Billing to invite more people.`,
  aiMessages: (n, p) => `This workspace has used its ${n.toLocaleString("en-US")} assistant questions for this month on the ${p} plan. It resets on the 1st, or a workspace owner can upgrade in Billing.`,
  voiceSessions: (n, p) => `This workspace has used its ${n.toLocaleString("en-US")} voice conversations for this month on the ${p} plan. Text questions still work; it resets on the 1st.`,
};

/** Throws a user-safe 402 when adding `adding` more of `key` would exceed the workspace's plan. */
export async function assertWithinLimit(workspaceId: string, key: keyof PlanLimits, adding = 1) {
  const s = await loadSubscription(pool, workspaceId);
  const plan = effectivePlan(s);
  const limit = PLANS[plan].limits[key];
  const used = (await currentUsage(pool, workspaceId))[key];
  if (used + adding > limit) {
    throw new AppError(402, "plan_limit", LIMIT_MESSAGES[key](limit, PLANS[plan].name), { limit: key, label: LIMIT_LABELS[key], used, allowed: limit, plan });
  }
}
