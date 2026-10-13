import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { AssetInfo, ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import { G, googleAuthorizeUrl, googleCallback, googleNeedsRefresh, googleRefresh, googleRevoke } from "./oauth.js";

/**
 * Google Ads via the Google Ads API (REST, GAQL searchStream). Every request needs
 * the platform's developer token; accounts reached through a manager (MCC) also
 * need login-customer-id. Days are in the account's timezone; cost is in micros
 * of the account currency. Conversions can be restated for weeks (attribution
 * windows), so recent days are re-imported on every sync and 30 days nightly.
 */
const SCOPE = "https://www.googleapis.com/auth/adwords";
const version = () => process.env.GOOGLE_ADS_API_VERSION ?? "v25";
const API = (path: string) => G(`https://googleads.googleapis.com/${version()}/${path}`);
const OWNED = ["ad_spend", "ad_impressions", "ad_clicks", "ad_conversions", "ad_conversion_value"];

function headers(creds: Credentials, loginCustomerId?: string | null) {
  return {
    Authorization: `Bearer ${creds.access_token}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
    ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
  };
}

/** Developer-token problems are platform setup issues, not user errors — say so plainly. */
function explain(e: unknown): never {
  if (e instanceof ProviderError && /DEVELOPER_TOKEN_(NOT_APPROVED|PROHIBITED|INVALID)|developer token/i.test(e.detail ?? "")) {
    throw new ProviderError("scope", "This platform's Google Ads developer token isn't approved for production accounts yet (it can only reach test accounts). The operator must request Basic access from Google.", e.status, undefined, e.detail);
  }
  if (e instanceof ProviderError && /CUSTOMER_NOT_ENABLED|NOT_ADS_USER/.test(e.detail ?? "")) {
    throw new ProviderError("permanent", "This Google Ads account isn't enabled or the signed-in user has no Google Ads access.", e.status, undefined, e.detail);
  }
  throw e;
}

async function search(customerId: string, creds: Credentials, loginCustomerId: string | null, query: string): Promise<any[]> {
  try {
    const { data } = await providerFetch(API(`customers/${customerId}/googleAds:searchStream`), {
      provider: "Google Ads",
      method: "POST",
      idempotent: true,
      timeoutMs: 120_000,
      headers: headers(creds, loginCustomerId),
      json: { query },
    });
    // searchStream returns an array of batches over REST.
    return (Array.isArray(data) ? data : [data]).flatMap((b: any) => b?.results ?? []);
  } catch (e) {
    explain(e);
  }
}

const CHANNEL: Record<string, string> = {
  SEARCH: "Search", PERFORMANCE_MAX: "Performance Max", SHOPPING: "Shopping", DISPLAY: "Display", VIDEO: "Video",
  DEMAND_GEN: "Demand Gen", DISCOVERY: "Demand Gen", MULTI_CHANNEL: "App", LOCAL: "Local", SMART: "Smart", HOTEL: "Hotel", LOCAL_SERVICES: "Local Services", TRAVEL: "Travel",
};
const DEVICE: Record<string, string> = { MOBILE: "mobile", DESKTOP: "desktop", TABLET: "tablet", CONNECTED_TV: "tv" };

type V = Record<(typeof OWNED)[number], number>;
const zero = (): V => ({ ad_spend: 0, ad_impressions: 0, ad_clicks: 0, ad_conversions: 0, ad_conversion_value: 0 });
const add = (a: V, b: V) => { for (const k of OWNED) a[k] += b[k]; return a; };
const round = (v: V): V => ({ ...v, ad_spend: Math.round(v.ad_spend * 100) / 100, ad_conversion_value: Math.round(v.ad_conversion_value * 100) / 100, ad_conversions: Math.round(v.ad_conversions * 100) / 100 });

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  const customerId = ctx.asset.provider_asset_id;
  const login = (ctx.asset.metadata?.loginCustomerId as string | undefined) ?? null;
  const results = await search(customerId, creds, login,
    `SELECT segments.date, segments.device, campaign.id, campaign.name, campaign.advertising_channel_type,
            metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
       FROM campaign
      WHERE segments.date BETWEEN '${from}' AND '${to}'`);

  const totals = new Map<string, V>();
  const dims = new Map<string, V>(); // `${date}|${dimKey}|${value}`
  const bump = (date: string, dimKey: string, value: string, v: V) => {
    const k = `${date}|${dimKey}|${value}`;
    dims.set(k, add(dims.get(k) ?? zero(), v));
  };
  for (const r of results) {
    const date: string = r.segments?.date;
    if (!date) continue;
    const m = r.metrics ?? {};
    const v: V = {
      ad_spend: Number(m.costMicros ?? 0) / 1e6,
      ad_impressions: Number(m.impressions ?? 0),
      ad_clicks: Number(m.clicks ?? 0),
      ad_conversions: Number(m.conversions ?? 0),
      ad_conversion_value: Number(m.conversionsValue ?? 0),
    };
    totals.set(date, add(totals.get(date) ?? zero(), v));
    bump(date, "campaign", r.campaign?.name ?? `Campaign ${r.campaign?.id}`, v);
    bump(date, "channel", CHANNEL[r.campaign?.advertisingChannelType] ?? "Other", v);
    bump(date, "device", DEVICE[r.segments?.device] ?? "other", v);
  }
  // The campaign report covers all spend, and the API serves same-day data, so a day
  // in the window without rows is a true zero for the account.
  const out: ReportRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, dimKey: "", dimValue: "", values: round(totals.get(d) ?? zero()) });
  for (const [k, v] of dims) {
    const [date, dimKey, dimValue] = k.split("|") as [string, string, string];
    out.push({ date, dimKey, dimValue, values: round(v) });
  }
  return out;
}

async function listAccounts(creds: Credentials): Promise<AssetInfo[]> {
  let names: string[];
  try {
    const { data } = await providerFetch(API("customers:listAccessibleCustomers"), { provider: "Google Ads", headers: headers(creds) });
    names = data.resourceNames ?? [];
  } catch (e) {
    explain(e);
  }
  const assets = new Map<string, AssetInfo>();
  for (const rn of names.slice(0, 50)) {
    const id = rn.split("/")[1]!;
    let rows: any[];
    try {
      rows = await search(id, creds, null, `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.level, customer_client.status FROM customer_client WHERE customer_client.level <= 1`);
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === "permanent" || e.kind === "scope") && !/developer token/i.test(e.message)) continue; // disabled / no access
      throw e;
    }
    for (const r of rows) {
      const c = r.customerClient;
      if (!c || c.manager || (c.status && c.status !== "ENABLED")) continue;
      const cid = String(c.id);
      if (assets.has(cid)) continue;
      assets.set(cid, {
        providerAssetId: cid,
        name: `${c.descriptiveName || "Untitled account"} (${cid.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")})`,
        kind: "ad_account",
        currency: c.currencyCode ?? null,
        timezone: c.timeZone ?? null,
        // Reached through a manager account → that manager must be sent as login-customer-id.
        metadata: { loginCustomerId: cid === id ? null : id },
      });
    }
  }
  return [...assets.values()];
}

export const googleAds: ConnectorDefinition = {
  id: "google_ads",
  name: "Google Ads",
  category: "Advertising",
  description: "Spend, impressions, clicks, conversions and platform-attributed conversion value by campaign, channel and device.",
  implemented: true,
  configKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"],
  accessRequirements: [
    "A Google Ads developer token (from a manager account's API Center) with Basic or Standard access approved by Google — test-level tokens only reach test accounts.",
    "The Google Ads API enabled on the Google Cloud project, and redirect URI <API_URL>/api/oauth/google_ads/callback on the OAuth client.",
  ],
  scopes: [{ scope: SCOPE, reason: "Read Google Ads accounts and performance reports (this platform never edits campaigns without an approved action)" }],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Spend updates within ~3 hours; conversions can change for up to 30 days",
  staleAfterHours: 12,
  syncIntervalMinutes: 180,
  reconcileDays: 30,
  authorizeUrl: ({ state, redirectUri }) => googleAuthorizeUrl([SCOPE], state, redirectUri),
  async handleCallback({ query, redirectUri }) {
    const { creds, scopes, expiresAt } = await googleCallback(query, redirectUri, [SCOPE]);
    const accounts = await listAccounts(creds);
    if (!accounts.length) throw new ProviderError("permanent", "No enabled Google Ads accounts are accessible to this Google user.");
    return { credentials: creds, scopes, externalAccountId: `gads:${accounts.map((a) => a.providerAssetId).sort()[0]}`, displayName: accounts.length === 1 ? accounts[0]!.name : `Google Ads (${accounts.length} accounts)`, tokenExpiresAt: expiresAt };
  },
  needsRefresh: googleNeedsRefresh,
  refreshCredentials: googleRefresh,
  discoverAssets: (creds) => listAccounts(creds),
  sync: (ctx) => syncReport(ctx, {
    owned: OWNED,
    money: new Set(["ad_spend", "ad_conversion_value"]),
    initialDays: 400,
    lookbackDays: 7,
    reconcileDays: 30,
    lagDays: 0,
    windowDays: 31,
    zeroFillTotals: true,
    fetch: fetchWindow,
  }),
  async healthCheck(ctx) {
    const creds = await ctx.credentials();
    await search(ctx.asset.provider_asset_id, creds, (ctx.asset.metadata?.loginCustomerId as string | undefined) ?? null, "SELECT customer.id FROM customer LIMIT 1");
  },
  revoke: (creds) => googleRevoke(creds),
};
