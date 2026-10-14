import { todayIn } from "@bca/shared";
import { writeSnapshot } from "../kit.js";
import { ProviderError } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { AssetInfo, ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import {
  GraphError, graphGet, insightsDay, insightsMidnight, listPages, META_INSIGHTS_TZ, META_OAUTH_KEYS, META_TOKEN_FIELD, metaAuthorizeUrl, metaCallback, metaResult, metaTokenCredentials, metaTokenInstructions, pageToken,
} from "./graph.js";

/**
 * Facebook Pages via the Graph API Page Insights.
 *
 * Auth: the same Meta token as Meta Ads (system-user or long-lived user token, or
 * "Sign in with Facebook") with pages_show_list, pages_read_engagement and read_insights.
 * Page insights need a Page access token: it's fetched at sync time with the connection's
 * token (GET /{page-id}?fields=access_token) and never stored.
 *
 * Data: daily Page insights (GET /{page-id}/insights?period=day&since&until, ≤ 90-day
 * windows), reported by Meta in Pacific time — so Page assets use America/Los_Angeles days.
 *  - social_reach: unique accounts reached (views-based metric, falling back to the legacy
 *    impressions metric while Meta migrates Page Insights)
 *  - social_engagements: post engagements
 *  - social_new_followers: new follows per day
 *  - social_followers: snapshot of followers_count for the sync day only (no history is invented).
 * Meta keeps deprecating Page Insights metrics; each figure has an ordered list of metric
 * names and the first one Meta accepts is used. Reach is per-day unique and summed across days
 * (an approximation: the same person reached on two days counts twice).
 */
const PROVIDER = "Facebook Pages";
const PERMISSIONS = ["pages_show_list", "pages_read_engagement", "read_insights"];
const OWNED = ["social_reach", "social_engagements", "social_new_followers"];
const SNAPSHOT = ["social_followers"];

/** Page Insights metric names per figure, newest first (unverified against every API version). */
export const PAGE_METRICS: Record<(typeof OWNED)[number], string[]> = {
  social_reach: ["page_total_media_view_unique", "page_impressions_unique"],
  social_engagements: ["page_post_engagements"],
  social_new_followers: ["page_daily_follows_unique", "page_fan_adds_unique", "page_fan_adds"],
};

const dayAfter = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** One daily insights series, trying each candidate metric name until Meta accepts one. */
async function series(creds: Credentials, pageId: string, token: string, candidates: string[], from: string, to: string, resolved: Map<string, string>, key: string) {
  const list = resolved.has(key) ? [resolved.get(key)!] : candidates;
  for (const metric of list) {
    try {
      const data = await graphGet<any>(creds, `${pageId}/insights`, { metric, period: "day", since: String(insightsMidnight(from)), until: String(insightsMidnight(dayAfter(to))) }, { token, provider: PROVIDER });
      resolved.set(key, metric);
      const out = new Map<string, number>();
      for (const s of data?.data ?? []) {
        if (s.period !== "day") continue;
        for (const v of s.values ?? []) {
          if (!v?.end_time || typeof v.value !== "number") continue;
          const d = insightsDay(v.end_time);
          if (d >= from && d <= to) out.set(d, (out.get(d) ?? 0) + v.value);
        }
      }
      return out;
    } catch (e) {
      // (#100) invalid/deprecated metric → try the next name.
      if (e instanceof GraphError && e.code === 100) continue;
      throw e;
    }
  }
  return null; // none of the names is available any more
}

async function syncPage(ctx: SyncContext) {
  const creds = await ctx.credentials();
  const pageId = ctx.asset.provider_asset_id;
  let token: string | null = null;
  const resolved = new Map<string, string>();
  const unavailable = new Set<string>();
  const result = await syncReport(ctx, {
    owned: OWNED,
    money: new Set(),
    initialDays: 365,
    lookbackDays: 3,
    reconcileDays: 28,
    lagDays: 0,
    windowDays: 90,
    zeroFillTotals: false, // missing days stay missing
    async fetch(_ctx, from, to) {
      token ??= await pageToken(creds, pageId, PROVIDER);
      const byDay = new Map<string, Record<string, number>>();
      for (const [key, names] of Object.entries(PAGE_METRICS)) {
        const s = await series(creds, pageId, token, names, from, to, resolved, key);
        if (!s) { unavailable.add(key); continue; }
        for (const [d, v] of s) byDay.set(d, { ...(byDay.get(d) ?? {}), [key]: v });
      }
      // One total row per day (no dimensions for social metrics).
      return [...byDay].map(([date, values]): ReportRow => ({ date, dimKey: "", dimValue: "", values }));
    },
  });
  // Followers: point-in-time, for the sync day only.
  const page = await graphGet<any>(creds, pageId, { fields: "followers_count,fan_count" }, { token: token ?? undefined, provider: PROVIDER });
  const followers = Number(page?.followers_count ?? page?.fan_count);
  if (Number.isFinite(followers)) await writeSnapshot(ctx, todayIn(META_INSIGHTS_TZ), [{ metric: "social_followers", value: followers }], SNAPSHOT);
  const notes = [...unavailable].map((k) => `Meta no longer reports ${k.replace("social_", "").replace(/_/g, " ")} for this Page through the API.`);
  return { ...result, notes: notes.length ? notes : undefined };
}

async function discover(creds: Credentials): Promise<AssetInfo[]> {
  const pages = await listPages(creds, "id,name,followers_count,fan_count", PROVIDER);
  return pages.map((p) => ({
    providerAssetId: String(p.id),
    name: p.name || `Page ${p.id}`,
    kind: "page",
    currency: null,
    timezone: META_INSIGHTS_TZ,
    metadata: {},
  }));
}

export const facebookPages: ConnectorDefinition = {
  id: "facebook_pages",
  name: "Facebook Pages",
  category: "Social",
  description: "Page reach, post engagements, new follows and follower count.",
  implemented: true,
  configKeys: META_OAUTH_KEYS,
  accessRequirements: [
    "For “Sign in with Facebook”: a Meta app with Advanced Access to pages_show_list, pages_read_engagement and read_insights (App Review), and redirect URI <API_URL>/api/oauth/facebook_pages/callback. Without it, users connect with a system-user token.",
  ],
  scopes: [
    { scope: "pages_show_list", reason: "List the Pages you manage" },
    { scope: "pages_read_engagement", reason: "Read follower counts and engagement" },
    { scope: "read_insights", reason: "Read daily Page Insights (reach, engagement, follows)" },
  ],
  metrics: [...OWNED, ...SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Daily figures are usually final by the next day (Pacific time)",
  staleAfterHours: 30,
  syncIntervalMinutes: 360,
  reconcileDays: 28,
  docsUrl: "https://developers.facebook.com/docs/graph-api/reference/page/insights",
  tokenConnect: {
    fields: [META_TOKEN_FIELD],
    instructions: metaTokenInstructions(PERMISSIONS, "Facebook Pages"),
    async connect(input) {
      const { creds, user } = await metaTokenCredentials(input, PERMISSIONS, PROVIDER);
      const pages = await discover(creds);
      if (!pages.length) throw new ProviderError("permanent", "This token can't see any Facebook Pages. Assign the Pages to the system user (with a task such as “Analyze”) and try again.");
      return metaResult({ creds, user, scopes: PERMISSIONS, expiresAt: null, token: true, displayName: pages.length === 1 ? pages[0]!.name : `Facebook Pages — ${user.name ?? user.id} (${pages.length} Pages)` });
    },
  },
  authorizeUrl: ({ state, redirectUri }) => metaAuthorizeUrl(PERMISSIONS, state, redirectUri),
  async handleCallback({ query, redirectUri }) {
    const { creds, user, scopes, expiresAt } = await metaCallback(query, redirectUri, PERMISSIONS, PROVIDER);
    const pages = await discover(creds);
    if (!pages.length) throw new ProviderError("permanent", "This Facebook user doesn't manage any Pages.");
    return metaResult({ creds, user, scopes, expiresAt, token: false, displayName: pages.length === 1 ? pages[0]!.name : `Facebook Pages — ${user.name ?? user.id} (${pages.length} Pages)` });
  },
  needsRefresh: () => false,
  discoverAssets: (creds) => discover(creds),
  sync: syncPage,
  async healthCheck(ctx) {
    await graphGet(await ctx.credentials(), ctx.asset.provider_asset_id, { fields: "id" }, { provider: PROVIDER });
  },
};
