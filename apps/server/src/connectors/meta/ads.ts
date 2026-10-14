import { addDays } from "@bca/shared";
import { ProviderError } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { AssetInfo, ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import {
  graphAll, graphGet, META_OAUTH_KEYS, META_TOKEN_FIELD, metaAuthorizeUrl, metaCallback, metaResult, metaTokenCredentials, metaTokenInstructions,
} from "./graph.js";

/**
 * Meta Ads (Facebook & Instagram ads) via the Marketing API on the Graph API.
 *
 * Auth: a pasted system-user / long-lived user token with ads_read, or "Sign in with
 * Facebook" through the platform's Meta app (long-lived user token, ~60 days, no refresh).
 * Assets are ad accounts (GET /me/adaccounts) with their own currency and timezone.
 *
 * Data: daily campaign-level insights (GET /act_{id}/insights, level=campaign,
 * time_increment=1) in the ad account's timezone and currency. Conversions and
 * conversion value are purchases from `actions` / `action_values`, taking ONE purchase
 * action type per row (omni_purchase, else purchase, else the pixel purchase) — these
 * overlap, so they're never added together. The account's unified attribution setting
 * is used (as Ads Manager does). Conversions restate within the attribution window
 * (up to 28 days after the click), so 28 days are re-imported on every sync and 37
 * on reconciliation. Days in a fetched window without rows are true zeros.
 */
const PROVIDER = "Meta Ads";
const PERMISSIONS = ["ads_read"];
const OWNED = ["ad_spend", "ad_impressions", "ad_clicks", "ad_conversions", "ad_conversion_value"];
/** Purchase action types in order of preference; they overlap, so only one is used per row. */
export const PURCHASE_ACTION_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const INSIGHT_FIELDS = "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,date_start,date_stop,account_currency";
/** account_status values (1 active, 2 disabled, 3 unsettled, 7 pending review, 9 in grace period, 101 closed…). */
const STATUS_LABEL: Record<number, string> = { 2: "disabled", 3: "unsettled", 7: "pending risk review", 8: "pending settlement", 9: "in grace period", 100: "pending closure", 101: "closed" };

type V = Record<(typeof OWNED)[number], number>;
const zero = (): V => ({ ad_spend: 0, ad_impressions: 0, ad_clicks: 0, ad_conversions: 0, ad_conversion_value: 0 });
const add = (a: V, b: V) => { for (const k of OWNED) a[k] += b[k]; return a; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const round = (v: V): V => ({ ...v, ad_spend: r2(v.ad_spend), ad_conversion_value: r2(v.ad_conversion_value), ad_conversions: r2(v.ad_conversions) });

type ActionStat = { action_type: string; value: string | number };

/** The preferred purchase action type present in a row's actions (or values). */
function pick(list: ActionStat[] | undefined, type: string | null): number {
  if (!list?.length) return 0;
  const t = type ?? PURCHASE_ACTION_TYPES.find((x) => list.some((a) => a.action_type === x));
  const hit = t ? list.find((a) => a.action_type === t) : undefined;
  return hit ? Number(hit.value) || 0 : 0;
}

export function purchases(row: { actions?: ActionStat[]; action_values?: ActionStat[] }) {
  const type = PURCHASE_ACTION_TYPES.find((x) => row.actions?.some((a) => a.action_type === x)) ?? null;
  return {
    conversions: pick(row.actions, type),
    // Value of the same action type when present; otherwise the preferred one in action_values.
    value: type && row.action_values?.some((a) => a.action_type === type) ? pick(row.action_values, type) : pick(row.action_values, null),
  };
}

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  const rows = await graphAll<any>(creds, `act_${ctx.asset.provider_asset_id}/insights`, {
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since: from, until: to }),
    fields: INSIGHT_FIELDS,
    use_unified_attribution_setting: "true",
    limit: "500",
  }, { provider: PROVIDER });

  const currency = ctx.asset.currency;
  const totals = new Map<string, V>();
  const camp = new Map<string, V>(); // `${date}|${name}`
  let skipped = 0;
  for (const r of rows) {
    const date: string = r.date_start;
    if (!date || date < from || date > to) continue;
    // Insights are always in the account currency; guard anyway (never mix currencies).
    if (currency && r.account_currency && r.account_currency !== currency) { skipped++; continue; }
    const p = purchases(r);
    const v: V = {
      ad_spend: Number(r.spend ?? 0) || 0,
      ad_impressions: Number(r.impressions ?? 0) || 0,
      ad_clicks: Number(r.clicks ?? 0) || 0,
      ad_conversions: p.conversions,
      ad_conversion_value: p.value,
    };
    totals.set(date, add(totals.get(date) ?? zero(), v));
    const name = r.campaign_name || `Campaign ${r.campaign_id}`;
    const k = `${date}|${name}`;
    camp.set(k, add(camp.get(k) ?? zero(), v));
  }
  if (skipped) ctx.log(`skipped ${skipped} insight rows in a currency other than ${currency}`);
  // Campaign rows cover all delivery in the account, so a day without rows is a true zero.
  const out: ReportRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, dimKey: "", dimValue: "", values: round(totals.get(d) ?? zero()) });
  for (const [k, v] of camp) {
    const i = k.indexOf("|");
    out.push({ date: k.slice(0, i), dimKey: "campaign", dimValue: k.slice(i + 1), values: round(v) });
  }
  return out;
}

async function listAdAccounts(creds: Credentials): Promise<AssetInfo[]> {
  const accounts = await graphAll<any>(creds, "me/adaccounts", { fields: "account_id,name,currency,timezone_name,account_status", limit: "200" }, { provider: PROVIDER });
  return accounts
    .filter((a) => a.account_status !== 101) // closed
    .map((a) => {
      const id = String(a.account_id ?? String(a.id ?? "").replace(/^act_/, ""));
      const status = STATUS_LABEL[Number(a.account_status)];
      return {
        providerAssetId: id,
        name: `${a.name || "Ad account"} (${id})${status ? ` — ${status}` : ""}`,
        kind: "ad_account",
        currency: a.currency ?? null,
        timezone: a.timezone_name ?? null,
        metadata: { accountStatus: a.account_status ?? null },
      };
    });
}

const SCOPES = [{ scope: "ads_read", reason: "Read ad accounts and campaign performance (spend, impressions, clicks, purchases)" }];

export const metaAds: ConnectorDefinition = {
  id: "meta_ads",
  name: "Meta Ads",
  category: "Advertising",
  description: "Facebook & Instagram ad spend, impressions, clicks, purchases and purchase value by campaign.",
  implemented: true,
  configKeys: META_OAUTH_KEYS,
  accessRequirements: [
    "For “Sign in with Facebook”: a Meta app with the Marketing API product, Advanced Access to ads_read (App Review), and redirect URI <API_URL>/api/oauth/meta_ads/callback. Without it, users connect with a system-user token.",
  ],
  scopes: SCOPES,
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Usually complete within a few hours; conversions restate for up to 28 days",
  staleAfterHours: 12,
  syncIntervalMinutes: 240,
  reconcileDays: 37,
  docsUrl: "https://developers.facebook.com/docs/marketing-api/insights",
  tokenConnect: {
    fields: [META_TOKEN_FIELD],
    instructions: metaTokenInstructions(PERMISSIONS, "ad accounts"),
    async connect(input) {
      const { creds, user } = await metaTokenCredentials(input, PERMISSIONS, PROVIDER);
      const accounts = await listAdAccounts(creds);
      if (!accounts.length) throw new ProviderError("permanent", "This token can't see any ad accounts. Assign the ad accounts to the system user (Business Settings → System users → Assign assets) and try again.");
      return metaResult({ creds, user, scopes: PERMISSIONS, expiresAt: null, token: true, displayName: accounts.length === 1 ? accounts[0]!.name : `Meta Ads — ${user.name ?? user.id} (${accounts.length} ad accounts)` });
    },
  },
  authorizeUrl: ({ state, redirectUri }) => metaAuthorizeUrl(PERMISSIONS, state, redirectUri),
  async handleCallback({ query, redirectUri }) {
    const { creds, user, scopes, expiresAt } = await metaCallback(query, redirectUri, PERMISSIONS, PROVIDER);
    const accounts = await listAdAccounts(creds);
    if (!accounts.length) throw new ProviderError("permanent", "No ad accounts are accessible to this Facebook user.");
    return metaResult({ creds, user, scopes, expiresAt, token: false, displayName: accounts.length === 1 ? accounts[0]!.name : `Meta Ads — ${user.name ?? user.id} (${accounts.length} ad accounts)` });
  },
  // Long-lived user tokens can't be refreshed server-side; on expiry the user reconnects.
  needsRefresh: () => false,
  discoverAssets: (creds) => listAdAccounts(creds),
  sync: (ctx) => syncReport(ctx, {
    owned: OWNED,
    money: new Set(["ad_spend", "ad_conversion_value"]),
    initialDays: 365,
    lookbackDays: 28,
    reconcileDays: 37,
    lagDays: 0,
    windowDays: 31,
    zeroFillTotals: true,
    fetch: fetchWindow,
  }),
  async healthCheck(ctx) {
    await graphGet(await ctx.credentials(), `act_${ctx.asset.provider_asset_id}`, { fields: "account_id,account_status" }, { provider: PROVIDER });
  },
  // No revoke: a Meta grant is per app and user and shared by every Meta connection made
  // with it (Ads, Pages, Instagram, other businesses); disconnecting deletes the stored token.
};
