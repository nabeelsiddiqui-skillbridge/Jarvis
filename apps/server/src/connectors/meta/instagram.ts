import { addDays, todayIn } from "@bca/shared";
import { writeSnapshot } from "../kit.js";
import { ProviderError } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { AssetInfo, ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import {
  GraphError, graphGet, insightsDay, insightsMidnight, listPages, META_INSIGHTS_TZ, META_OAUTH_KEYS, META_TOKEN_FIELD, metaAuthorizeUrl, metaCallback, metaResult, metaTokenCredentials, metaTokenInstructions,
} from "./graph.js";

/**
 * Instagram professional (business/creator) accounts through the Instagram Graph API
 * ("Instagram API with Facebook Login"): accounts are found through the Facebook Pages
 * they're linked to (GET /me/accounts?fields=instagram_business_account{…}).
 *
 * Auth: the same Meta token as Meta Ads/Pages with instagram_basic,
 * instagram_manage_insights, pages_show_list and pages_read_engagement.
 *
 * Data (GET /{ig-user-id}/insights), in Pacific-time days like other Meta insights:
 *  - social_reach: daily `reach` time series (≤ 30-day request windows)
 *  - social_engagements: `total_interactions` — only available as a total over a range
 *    (metric_type=total_value), so it's fetched one day at a time for the last 30 days
 *  - social_new_followers: daily `follower_count` (new follows), which Meta only serves for
 *    the last 30 days, excluding today
 *  - social_followers: followers_count snapshot for the sync day only.
 * Older days keep reach only; engagements and follows aren't invented for them.
 * Reach is per-day unique and summed across days (an approximation).
 */
const PROVIDER = "Instagram";
const PERMISSIONS = ["instagram_basic", "instagram_manage_insights", "pages_show_list", "pages_read_engagement"];
const OWNED = ["social_reach", "social_engagements", "social_new_followers"];
const SNAPSHOT = ["social_followers"];
/** Insights metric names (unverified against every API version). */
export const IG_METRICS = { reach: "reach", engagements: "total_interactions", follows: "follower_count" };
/** Days Meta serves follower_count for; engagements are fetched for the same span. */
const RECENT_DAYS = 30;

const unix = (d: string) => String(insightsMidnight(d));

/** Daily values of a time-series metric, or null when Meta doesn't serve it for this account. */
async function timeSeries(creds: Credentials, igId: string, metric: string, from: string, to: string) {
  try {
    const data = await graphGet<any>(creds, `${igId}/insights`, { metric, period: "day", since: unix(from), until: unix(addDays(to, 1)) }, { provider: PROVIDER });
    const out = new Map<string, number>();
    for (const s of data?.data ?? []) for (const v of s.values ?? []) {
      if (!v?.end_time || typeof v.value !== "number") continue;
      const d = insightsDay(v.end_time);
      if (d >= from && d <= to) out.set(d, (out.get(d) ?? 0) + v.value);
    }
    return out;
  } catch (e) {
    // (#100) metric not available (e.g. follower_count for accounts under 100 followers).
    if (e instanceof GraphError && e.code === 100) return null;
    throw e;
  }
}

/** A total_value metric for one day, or null when not available. */
async function dayTotal(creds: Credentials, igId: string, metric: string, day: string) {
  try {
    const data = await graphGet<any>(creds, `${igId}/insights`, { metric, period: "day", metric_type: "total_value", since: unix(day), until: unix(addDays(day, 1)) }, { provider: PROVIDER });
    const v = data?.data?.[0]?.total_value?.value;
    return typeof v === "number" ? v : null;
  } catch (e) {
    if (e instanceof GraphError && e.code === 100) return null;
    throw e;
  }
}

async function syncAccount(ctx: SyncContext) {
  const creds = await ctx.credentials();
  const igId = ctx.asset.provider_asset_id;
  const today = todayIn(META_INSIGHTS_TZ);
  const recentFrom = addDays(today, -RECENT_DAYS);
  const result = await syncReport(ctx, {
    owned: OWNED,
    money: new Set(),
    initialDays: 365,
    lookbackDays: 3,
    // Engagements/follows exist only for the last 30 days, so reconciliation stays inside them.
    reconcileDays: 28,
    lagDays: 0,
    windowDays: 30,
    zeroFillTotals: false,
    async fetch(_ctx, from, to) {
      const byDay = new Map<string, Record<string, number>>();
      const put = (d: string, k: string, v: number) => byDay.set(d, { ...(byDay.get(d) ?? {}), [k]: v });
      const reach = await timeSeries(creds, igId, IG_METRICS.reach, from, to);
      for (const [d, v] of reach ?? []) put(d, "social_reach", v);
      // Recent-only metrics: follows exclude today.
      const rFrom = from > recentFrom ? from : recentFrom;
      const rTo = to < addDays(today, -1) ? to : addDays(today, -1);
      if (rFrom <= rTo) {
        const follows = await timeSeries(creds, igId, IG_METRICS.follows, rFrom, rTo);
        for (const [d, v] of follows ?? []) put(d, "social_new_followers", v);
      }
      for (let d = rFrom; d <= to; d = addDays(d, 1)) {
        const v = await dayTotal(creds, igId, IG_METRICS.engagements, d);
        if (v == null) break; // not available for this account
        put(d, "social_engagements", v);
      }
      return [...byDay].map(([date, values]): ReportRow => ({ date, dimKey: "", dimValue: "", values }));
    },
  });
  const acct = await graphGet<any>(creds, igId, { fields: "followers_count" }, { provider: PROVIDER });
  const followers = Number(acct?.followers_count);
  if (Number.isFinite(followers)) await writeSnapshot(ctx, today, [{ metric: "social_followers", value: followers }], SNAPSHOT);
  return result;
}

async function discover(creds: Credentials): Promise<AssetInfo[]> {
  const pages = await listPages(creds, "id,name,instagram_business_account{id,username,followers_count}", PROVIDER);
  const seen = new Map<string, AssetInfo>();
  for (const p of pages) {
    const ig = p.instagram_business_account;
    if (!ig?.id || seen.has(ig.id)) continue;
    seen.set(ig.id, {
      providerAssetId: String(ig.id),
      name: ig.username ? `@${ig.username}` : `Instagram account linked to ${p.name}`,
      kind: "instagram_account",
      currency: null,
      timezone: META_INSIGHTS_TZ,
      metadata: { pageId: p.id, pageName: p.name },
    });
  }
  return [...seen.values()];
}

const NONE = "No Instagram professional accounts were found. The Instagram account must be a business or creator account linked to a Facebook Page this token can access.";

export const instagram: ConnectorDefinition = {
  id: "instagram",
  name: "Instagram",
  category: "Social",
  description: "Reach, interactions, new follows and follower count for Instagram professional accounts.",
  implemented: true,
  configKeys: META_OAUTH_KEYS,
  accessRequirements: [
    "For “Sign in with Facebook”: a Meta app with Advanced Access to instagram_basic, instagram_manage_insights, pages_show_list and pages_read_engagement (App Review), and redirect URI <API_URL>/api/oauth/instagram/callback. Without it, users connect with a system-user token.",
  ],
  scopes: [
    { scope: "instagram_basic", reason: "Identify your Instagram professional accounts and follower count" },
    { scope: "instagram_manage_insights", reason: "Read daily reach, interactions and follows" },
    { scope: "pages_show_list", reason: "Find the Instagram accounts linked to your Facebook Pages" },
    { scope: "pages_read_engagement", reason: "Required by Meta to read Page-linked Instagram accounts" },
  ],
  metrics: [...OWNED, ...SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Daily figures are usually final within 48 hours; interactions and follows cover the last 30 days",
  staleAfterHours: 30,
  syncIntervalMinutes: 360,
  reconcileDays: 28,
  docsUrl: "https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights",
  tokenConnect: {
    fields: [META_TOKEN_FIELD],
    instructions: metaTokenInstructions(PERMISSIONS, "Facebook Pages linked to your Instagram accounts (and the Instagram accounts)"),
    async connect(input) {
      const { creds, user } = await metaTokenCredentials(input, PERMISSIONS, PROVIDER);
      const accounts = await discover(creds);
      if (!accounts.length) throw new ProviderError("permanent", NONE);
      return metaResult({ creds, user, scopes: PERMISSIONS, expiresAt: null, token: true, displayName: accounts.length === 1 ? `Instagram ${accounts[0]!.name}` : `Instagram — ${user.name ?? user.id} (${accounts.length} accounts)` });
    },
  },
  authorizeUrl: ({ state, redirectUri }) => metaAuthorizeUrl(PERMISSIONS, state, redirectUri),
  async handleCallback({ query, redirectUri }) {
    const { creds, user, scopes, expiresAt } = await metaCallback(query, redirectUri, PERMISSIONS, PROVIDER);
    const accounts = await discover(creds);
    if (!accounts.length) throw new ProviderError("permanent", NONE);
    return metaResult({ creds, user, scopes, expiresAt, token: false, displayName: accounts.length === 1 ? `Instagram ${accounts[0]!.name}` : `Instagram — ${user.name ?? user.id} (${accounts.length} accounts)` });
  },
  needsRefresh: () => false,
  discoverAssets: (creds) => discover(creds),
  sync: syncAccount,
  async healthCheck(ctx) {
    await graphGet(await ctx.credentials(), ctx.asset.provider_asset_id, { fields: "id" }, { provider: PROVIDER });
  },
};
