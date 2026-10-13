/**
 * Plans and their limits, shared by the API (enforcement) and the web app (billing
 * page, marketing pricing). Prices are display values; the amount actually charged
 * comes from the Stripe Price configured for each plan.
 */

export const PLAN_IDS = ["free", "starter", "growth", "agency"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const PAID_PLANS = ["starter", "growth", "agency"] as const satisfies readonly PlanId[];
export type PaidPlanId = (typeof PAID_PLANS)[number];

export interface PlanLimits {
  /** Real (non-demo) businesses. */
  businesses: number;
  /** Connected accounts across the workspace (demo connections excluded). */
  connections: number;
  /** Workspace members plus pending invitations. */
  members: number;
  /** Assistant questions per calendar month (UTC). */
  aiMessages: number;
  /** Voice conversations started per calendar month (UTC). */
  voiceSessions: number;
}

export interface PlanInfo {
  id: PlanId;
  name: string;
  priceMonthly: number;
  tagline: string;
  limits: PlanLimits;
  highlights: string[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  free: {
    id: "free", name: "Free", priceMonthly: 0, tagline: "Try it on one business",
    limits: { businesses: 1, connections: 2, members: 2, aiMessages: 100, voiceSessions: 10 },
    highlights: ["1 business", "2 connected accounts", "100 assistant questions / month", "Editable dashboards and briefings"],
  },
  starter: {
    id: "starter", name: "Starter", priceMonthly: 49, tagline: "For a single business and its team",
    limits: { businesses: 3, connections: 10, members: 5, aiMessages: 1000, voiceSessions: 100 },
    highlights: ["3 businesses", "10 connected accounts", "5 team members", "1,000 assistant questions / month", "100 voice conversations / month"],
  },
  growth: {
    id: "growth", name: "Growth", priceMonthly: 149, tagline: "For growing teams and multi-brand operators",
    limits: { businesses: 10, connections: 40, members: 15, aiMessages: 5000, voiceSessions: 500 },
    highlights: ["10 businesses", "40 connected accounts", "15 team members", "5,000 assistant questions / month", "500 voice conversations / month"],
  },
  agency: {
    id: "agency", name: "Agency", priceMonthly: 399, tagline: "For agencies managing many clients",
    limits: { businesses: 50, connections: 200, members: 50, aiMessages: 20000, voiceSessions: 2000 },
    highlights: ["50 client businesses", "200 connected accounts", "50 team members", "20,000 assistant questions / month", "2,000 voice conversations / month"],
  },
};

export const LIMIT_LABELS: Record<keyof PlanLimits, string> = {
  businesses: "Businesses",
  connections: "Connected accounts",
  members: "Members and invitations",
  aiMessages: "Assistant questions this month",
  voiceSessions: "Voice conversations this month",
};

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "unpaid" | "incomplete" | "incomplete_expired" | "canceled" | "paused" | "none";

export interface BillingSummary {
  /** Plan whose limits currently apply. */
  effectivePlan: PlanId;
  /** Plan on the subscription record (may differ from effectivePlan, e.g. an ended trial). */
  plan: PlanId;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  managedByStripe: boolean;
  stripeConfigured: boolean;
  /** Plans that can be bought now (Stripe configured and a price set). */
  purchasable: PaidPlanId[];
  limits: PlanLimits;
  usage: PlanLimits;
  periodStart: string;
  periodEnd: string;
  notice: string | null;
}

export interface UsageTotals {
  aiMessages: number;
  aiBackground: number;
  inputTokens: number;
  outputTokens: number;
  voiceSessions: number;
  ttsCharacters: number;
}
