import { addDays } from "@bca/shared";
import { overridable } from "../kit.js";
import { ProviderError, providerFetch } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { AssetInfo, CallbackResult, ConnectorDefinition, Credentials, SyncContext } from "../types.js";

/**
 * LinkedIn Ads via the versioned Marketing API (https://api.linkedin.com/rest, headers
 * `LinkedIn-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0`).
 *
 * Auth: OAuth 2.0 (3-legged) through the platform's LinkedIn app with r_ads and
 * r_ads_reporting — 60-day access tokens and, for apps that LinkedIn enables for it,
 * a ~1-year refresh token — or an access token pasted from the developer portal's token
 * generator (60 days, no refresh; the user reconnects when it lapses).
 *
 * Assets: ad accounts (GET /rest/adAccounts?q=search, cursor-paged) with their currency.
 * LinkedIn doesn't report an account timezone and its analytics days are UTC days, so
 * assets keep timezone null and figures are dated by UTC day (the report helper falls back
 * to UTC). Campaign names come from /rest/adAccounts/{id}/adCampaigns and are cached in the
 * asset metadata so renamed or deleted campaigns keep a label.
 *
 * Data: GET /rest/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY, in the
 * account currency (costInLocalCurrency, conversionValueInLocalCurrency). Conversions are
 * externalWebsiteConversions (Insight Tag / Conversions API). Rest.li parameters (List(…),
 * (start:(…))) are written literally and only URNs are percent-encoded, as LinkedIn requires.
 * Conversions restate within the attribution window (up to 90 days for clicks, typically
 * 30), so 30 days are re-imported each sync.
 */
const PROVIDER = "LinkedIn Ads";
export const LINKEDIN_VERSION = () => process.env.LINKEDIN_API_VERSION ?? "202508";
const L = overridable("LINKEDIN_BASE_URL_OVERRIDE");
const REST = "https://api.linkedin.com/rest";
const OAUTH = "https://www.linkedin.com/oauth/v2";
const SCOPES = ["r_ads", "r_ads_reporting"];
const OWNED = ["ad_spend", "ad_impressions", "ad_clicks", "ad_conversions", "ad_conversion_value"];
export const ANALYTICS_FIELDS = ["dateRange", "pivotValues", "costInLocalCurrency", "impressions", "clicks", "externalWebsiteConversions", "conversionValueInLocalCurrency"];

const headers = (creds: Credentials) => ({
  Authorization: `Bearer ${creds.access_token}`,
  "LinkedIn-Version": LINKEDIN_VERSION(),
  "X-Restli-Protocol-Version": "2.0.0",
});

/** GET a REST path with a pre-built query string (Rest.li syntax must not be re-encoded). */
async function rest<T = any>(creds: Credentials, path: string, query: string): Promise<T> {
  try {
    const { data } = await providerFetch<T>(L(`${REST}/${path}${query ? `?${query}` : ""}`), { provider: PROVIDER, headers: headers(creds), timeoutMs: 60_000 });
    return data;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "scope") throw new ProviderError("scope", "LinkedIn denied access. The user needs a role on the ad account (Viewer or higher) and the app needs Advertising API access with r_ads_reporting.", e.status, undefined, e.detail);
    throw e;
  }
}

/** Cursor-paged finder (pageSize/pageToken → metadata.nextPageToken). */
async function finder<T = any>(creds: Credentials, path: string, query: string, max = 100): Promise<T[]> {
  const out: T[] = [];
  let token: string | null = null;
  for (let page = 0; page < max; page++) {
    const data: any = await rest(creds, path, `${query}&pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    out.push(...(data?.elements ?? []));
    token = data?.metadata?.nextPageToken || null;
    if (!token) break;
  }
  return out;
}

async function listAccounts(creds: Credentials): Promise<AssetInfo[]> {
  const accounts = await finder<any>(creds, "adAccounts", "q=search");
  return accounts
    .filter((a) => a.status !== "CANCELED" && a.status !== "REMOVED")
    .map((a) => ({
      providerAssetId: String(a.id),
      name: `${a.name || "Ad account"} (${a.id})`,
      kind: "ad_account",
      currency: a.currency ?? null,
      timezone: null, // not provided; analytics days are UTC
      metadata: { status: a.status ?? null, type: a.type ?? null },
    }));
}

async function campaignNames(ctx: SyncContext, creds: Credentials): Promise<Record<string, string>> {
  const cached = (ctx.asset.metadata?.campaigns ?? {}) as Record<string, string>;
  const list = await finder<any>(creds, `adAccounts/${encodeURIComponent(ctx.asset.provider_asset_id)}/adCampaigns`, "q=search");
  const names = { ...cached };
  for (const c of list) if (c?.id != null && c.name) names[String(c.id)] = String(c.name);
  if (JSON.stringify(names) !== JSON.stringify(cached)) {
    await ctx.db.query(`UPDATE connection_assets SET metadata = metadata || jsonb_build_object('campaigns', $2::jsonb) WHERE id = $1`, [ctx.asset.id, JSON.stringify(names)]);
    ctx.asset.metadata = { ...ctx.asset.metadata, campaigns: names };
  }
  return names;
}

const ymd = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return `(year:${y},month:${m},day:${day})`;
};
const fromYmd = (o: { year: number; month: number; day: number } | undefined) =>
  o ? `${o.year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}` : null;

/** The adAnalytics query string, Rest.li-encoded (exported for tests). */
export function analyticsQuery(accountId: string, from: string, to: string) {
  return [
    "q=analytics",
    "pivot=CAMPAIGN",
    "timeGranularity=DAILY",
    `dateRange=(start:${ymd(from)},end:${ymd(to)})`,
    `accounts=List(${encodeURIComponent(`urn:li:sponsoredAccount:${accountId}`)})`,
    `fields=${ANALYTICS_FIELDS.join(",")}`,
  ].join("&");
}

/** Campaign names are loaded once per sync run. */
const namesPerSync = new WeakMap<SyncContext, Promise<Record<string, string>>>();

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  if (!namesPerSync.has(ctx)) namesPerSync.set(ctx, campaignNames(ctx, creds));
  const names = await namesPerSync.get(ctx)!;
  const data = await rest<any>(creds, "adAnalytics", analyticsQuery(ctx.asset.provider_asset_id, from, to));
  type V = Record<string, number>;
  const zero = (): V => Object.fromEntries(OWNED.map((k) => [k, 0]));
  const addTo = (a: V, b: V) => { for (const k of OWNED) a[k]! += b[k]!; return a; };
  const totals = new Map<string, V>();
  const camp = new Map<string, V>();
  for (const e of data?.elements ?? []) {
    const date = fromYmd(e.dateRange?.start);
    if (!date || date < from || date > to) continue;
    const v: V = {
      ad_spend: Number(e.costInLocalCurrency ?? 0) || 0,
      ad_impressions: Number(e.impressions ?? 0) || 0,
      ad_clicks: Number(e.clicks ?? 0) || 0,
      ad_conversions: Number(e.externalWebsiteConversions ?? 0) || 0,
      ad_conversion_value: Number(e.conversionValueInLocalCurrency ?? 0) || 0,
    };
    totals.set(date, addTo(totals.get(date) ?? zero(), v));
    const id = String(e.pivotValues?.[0] ?? "").split(":").pop() ?? "";
    const k = `${date}|${names[id] ?? `Campaign ${id}`}`;
    camp.set(k, addTo(camp.get(k) ?? zero(), v));
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const round = (v: V): V => ({ ...v, ad_spend: r2(v.ad_spend!), ad_conversion_value: r2(v.ad_conversion_value!), ad_conversions: r2(v.ad_conversions!) });
  // Analytics only returns campaign-days with activity; other days are zeros.
  const out: ReportRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, dimKey: "", dimValue: "", values: round(totals.get(d) ?? zero()) });
  for (const [k, v] of camp) {
    const i = k.indexOf("|");
    out.push({ date: k.slice(0, i), dimKey: "campaign", dimValue: k.slice(i + 1), values: round(v) });
  }
  return out;
}

// ------------------------------------------------------------------ OAuth

async function token(form: Record<string, string>) {
  const { data } = await providerFetch(L(`${OAUTH}/accessToken`), { provider: PROVIDER, method: "POST", form, retries: 0 });
  return data as { access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string };
}

async function result(creds: Credentials, scopes: string[], expiresAt: Date | null, mode: "token" | "oauth"): Promise<CallbackResult> {
  const accounts = await listAccounts(creds);
  if (!accounts.length) throw new ProviderError("permanent", "This LinkedIn member has no access to any ad accounts. Ask an account admin to add you (Viewer or higher) in Campaign Manager.");
  return {
    credentials: creds,
    scopes,
    externalAccountId: `linkedin:${accounts.map((a) => a.providerAssetId).sort()[0]}`,
    displayName: accounts.length === 1 ? accounts[0]!.name : `LinkedIn Ads (${accounts.length} ad accounts)`,
    tokenExpiresAt: expiresAt,
    settings: { authMode: mode },
  };
}

export const linkedinAds: ConnectorDefinition = {
  id: "linkedin_ads",
  name: "LinkedIn Ads",
  category: "Advertising",
  description: "LinkedIn ad spend, impressions, clicks, website conversions and conversion value by campaign.",
  implemented: true,
  configKeys: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  accessRequirements: [
    "For “Sign in with LinkedIn”: a LinkedIn app with the Advertising API product approved (r_ads, r_ads_reporting) and redirect URL <API_URL>/api/oauth/linkedin_ads/callback. Without it, users paste a token from the developer portal's token generator.",
  ],
  scopes: [
    { scope: "r_ads", reason: "List the ad accounts and campaigns you can access" },
    { scope: "r_ads_reporting", reason: "Read daily campaign performance" },
  ],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Usually complete within a day (UTC days); conversions restate for up to 30 days",
  staleAfterHours: 30,
  syncIntervalMinutes: 360,
  reconcileDays: 45,
  docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting",
  tokenConnect: {
    fields: [{ key: "accessToken", label: "Access token", placeholder: "AQV…", secret: true, help: "Generated in the LinkedIn developer portal; valid for 60 days." }],
    instructions: [
      "Open linkedin.com/developers/apps and select an app that has the Advertising API product (request it under Products if needed).",
      "Go to Docs and tools → OAuth Token Tools → Create token, select the app, and tick r_ads and r_ads_reporting.",
      "Sign in with a LinkedIn member who has a role (Viewer or higher) on the ad accounts in Campaign Manager, then copy the access token.",
      "Paste it here. Generated tokens last 60 days; reconnect with a new token when it expires.",
    ],
    async connect(input) {
      const t = (input.accessToken ?? "").trim();
      if (!/^[A-Za-z0-9_\-.~+/=]{40,1000}$/.test(t)) throw new ProviderError("permanent", "That doesn't look like a LinkedIn access token (a long string starting with AQ).");
      // Token-generator tokens last 60 days; the expiry isn't reported, so it's left unknown.
      return result({ access_token: t, refresh_token: null, mode: "token" }, SCOPES, null, "token");
    },
  },
  authorizeUrl({ state, redirectUri }) {
    const q = new URLSearchParams({ response_type: "code", client_id: process.env.LINKEDIN_CLIENT_ID!, redirect_uri: redirectUri, state, scope: SCOPES.join(" ") });
    return `${L(`${OAUTH}/authorization`)}?${q}`;
  },
  async handleCallback({ query, redirectUri }) {
    if (!query.code) throw new ProviderError("permanent", "LinkedIn didn't return an authorization code.");
    let t;
    try {
      t = await token({ grant_type: "authorization_code", code: query.code, client_id: process.env.LINKEDIN_CLIENT_ID!, client_secret: process.env.LINKEDIN_CLIENT_SECRET!, redirect_uri: redirectUri });
    } catch (e) {
      if (e instanceof ProviderError && e.status === 400) throw new ProviderError("permanent", "LinkedIn didn't accept the sign-in. Please try connecting again.", 400, undefined, e.detail);
      throw e;
    }
    const granted = (t.scope ?? "").split(/[\s,]+/).filter(Boolean);
    if (granted.length && SCOPES.some((s) => !granted.includes(s))) throw new ProviderError("scope", "Some requested permissions weren't granted. Please approve all requested access to continue.");
    const creds = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? null,
      refresh_expires_at: t.refresh_token_expires_in ? new Date(Date.now() + t.refresh_token_expires_in * 1000).toISOString() : null,
      mode: "oauth",
    };
    return result(creds, granted.length ? granted : SCOPES, new Date(Date.now() + t.expires_in * 1000), "oauth");
  },
  // Refresh a day before the 60-day access token lapses (only when a refresh token exists).
  needsRefresh: (c, expiresAt) => Boolean(c.refresh_token) && (!expiresAt || expiresAt.getTime() - Date.now() < 86_400_000),
  async refreshCredentials(creds) {
    try {
      const t = await token({ grant_type: "refresh_token", refresh_token: creds.refresh_token, client_id: process.env.LINKEDIN_CLIENT_ID!, client_secret: process.env.LINKEDIN_CLIENT_SECRET! });
      return {
        credentials: {
          ...creds,
          access_token: t.access_token,
          refresh_token: t.refresh_token ?? creds.refresh_token,
          refresh_expires_at: t.refresh_token_expires_in ? new Date(Date.now() + t.refresh_token_expires_in * 1000).toISOString() : creds.refresh_expires_at ?? null,
        },
        expiresAt: new Date(Date.now() + t.expires_in * 1000),
      };
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) throw new ProviderError("auth", "LinkedIn access expired or was revoked. Reconnect the account.", e.status, undefined, e.detail);
      throw e;
    }
  },
  discoverAssets: (creds) => listAccounts(creds),
  sync: (ctx) => syncReport(ctx, {
    owned: OWNED,
    money: new Set(["ad_spend", "ad_conversion_value"]),
    initialDays: 365,
    lookbackDays: 30,
    reconcileDays: 45,
    lagDays: 0,
    windowDays: 31,
    zeroFillTotals: true,
    fetch: fetchWindow,
  }),
  async healthCheck(ctx) {
    await rest(await ctx.credentials(), `adAccounts/${encodeURIComponent(ctx.asset.provider_asset_id)}`, "");
  },
  async revoke(creds) {
    if (creds.mode !== "oauth") return; // generated tokens belong to the user's own app
    await providerFetch(L(`${OAUTH}/revoke`), { provider: PROVIDER, method: "POST", retries: 0, form: { client_id: process.env.LINKEDIN_CLIENT_ID!, client_secret: process.env.LINKEDIN_CLIENT_SECRET!, token: creds.access_token } });
  },
};
