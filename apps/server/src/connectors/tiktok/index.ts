import { addDays } from "@bca/shared";
import { overridable } from "../kit.js";
import { ProviderError, providerFetch } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { AssetInfo, CallbackResult, ConnectorDefinition, Credentials, SyncContext } from "../types.js";

/**
 * TikTok Ads via the TikTok API for Business (Marketing API) v1.3.
 *
 * Auth: a long-term access token (header `Access-Token`) — pasted from the developer
 * portal, or obtained with "Sign in with TikTok" through the platform's app
 * (auth_code → /oauth2/access_token/). Tokens don't expire until revoked; there is no refresh.
 * Every response is HTTP 200 `{code, message, data}`: code 0 is success and other codes
 * are mapped to error kinds below.
 *
 * Assets: advertiser accounts (/advertiser/info/) with their currency and timezone.
 * Data: the synchronous integrated report (BASIC, AUCTION_CAMPAIGN, dimensions
 * campaign_id × stat_time_day) in the advertiser's timezone and currency, ≤ 30-day
 * windows, paged. Conversions are TikTok's optimization-event conversions; conversion
 * value isn't imported because the report's value metrics depend on the event setup
 * (ad_conversion_value is omitted rather than guessed). Conversions restate within the
 * attribution window, so 28 days are re-imported on every sync.
 */
const PROVIDER = "TikTok Ads";
const T = overridable("TIKTOK_BASE_URL_OVERRIDE");
const API = (path: string) => T(`https://business-api.tiktok.com/open_api/v1.3/${path}`);
const OWNED = ["ad_spend", "ad_impressions", "ad_clicks", "ad_conversions"];
export const TIKTOK_REPORT_METRICS = ["campaign_name", "spend", "impressions", "clicks", "conversion"];
const PAGE_SIZE = 1000;

/** TikTok response codes (https://business-api.tiktok.com/portal/docs?id=1737172488964097). */
const AUTH_CODES = new Set([40102, 40104, 40105, 40106, 40107]); // token expired/invalid/empty/revoked
const SCOPE_CODES = new Set([40001, 40003, 40008]); // no permission for the app/advertiser/scope
const RATE_CODES = new Set([40100, 40133, 50002]); // QPS / daily limits
const TRANSIENT_CODES = new Set([50000, 51000, 51004, 51305]);

export function tiktokError(code: number): ProviderError {
  if (AUTH_CODES.has(code)) return new ProviderError("auth", "TikTok rejected the access token (it was revoked or is invalid). Reconnect the account.", 401, undefined, `code ${code}`);
  if (SCOPE_CODES.has(code)) return new ProviderError("scope", "TikTok denied access: the token doesn't have permission for this advertiser account or report. Check the app's scopes (Ad account management, Reporting) and the advertiser authorization.", 403, undefined, `code ${code}`);
  if (RATE_CODES.has(code)) return new ProviderError("rate_limit", "TikTok rate limit reached; the sync will retry.", 429, 60_000, `code ${code}`);
  if (TRANSIENT_CODES.has(code)) return new ProviderError("transient", "TikTok is having problems; the sync will retry.", 500, undefined, `code ${code}`);
  return new ProviderError("permanent", `TikTok request failed (code ${code}).`, 400, undefined, `code ${code}`);
}

type Query = Record<string, string | number | string[]>;
const qs = (q: Query) => new URLSearchParams(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? JSON.stringify(v) : String(v)])).toString();

async function call<T = any>(path: string, opts: { token?: string; query?: Query; json?: unknown; retries?: number }): Promise<T> {
  const url = `${API(path)}${opts.query ? `?${qs(opts.query)}` : ""}`;
  const { data } = await providerFetch(url, {
    provider: PROVIDER,
    method: opts.json ? "POST" : "GET",
    headers: opts.token ? { "Access-Token": opts.token } : {},
    json: opts.json,
    retries: opts.retries,
    timeoutMs: 60_000,
  });
  if (!data || typeof data !== "object") throw new ProviderError("transient", "TikTok returned an unexpected response.");
  if (Number(data.code) !== 0) throw tiktokError(Number(data.code));
  return data.data as T;
}

const appCreds = () => (process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET ? { app_id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET } : null);

/** Advertisers authorized for the platform app (needs the app id and secret). */
async function authorizedAdvertisers(token: string): Promise<string[]> {
  const app = appCreds();
  if (!app) return [];
  const data = await call<{ list?: { advertiser_id: string | number }[] }>("oauth2/advertiser/get/", { token, query: { app_id: app.app_id, secret: app.secret } });
  return (data.list ?? []).map((a) => String(a.advertiser_id));
}

interface Advertiser { advertiser_id: string | number; name?: string; currency?: string; timezone?: string; display_timezone?: string; status?: string }

const validTz = (tz: string | undefined) => {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};

async function advertiserInfo(token: string, ids: string[]): Promise<AssetInfo[]> {
  const out: AssetInfo[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await call<{ list?: Advertiser[] }>("advertiser/info/", {
      token,
      query: { advertiser_ids: ids.slice(i, i + 100), fields: ["advertiser_id", "name", "currency", "timezone", "display_timezone", "status"] },
    });
    for (const a of data.list ?? []) {
      const id = String(a.advertiser_id);
      out.push({
        providerAssetId: id,
        name: `${a.name || "Advertiser"} (${id})`,
        kind: "ad_account",
        currency: a.currency ?? null,
        // display_timezone is IANA (e.g. America/Los_Angeles); timezone may be an Etc/GMT offset.
        timezone: validTz(a.display_timezone) ?? validTz(a.timezone),
        metadata: { status: a.status ?? null },
      });
    }
  }
  return out;
}

const parseIds = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  type V = Record<string, number>;
  const zero = (): V => Object.fromEntries(OWNED.map((k) => [k, 0]));
  const addTo = (a: V, b: V) => { for (const k of OWNED) a[k]! += b[k]!; return a; };
  const totals = new Map<string, V>();
  const camp = new Map<string, V>();
  for (let page = 1, pages = 1; page <= pages; page++) {
    const data = await call<any>("report/integrated/get/", {
      token: creds.access_token,
      query: {
        advertiser_id: ctx.asset.provider_asset_id,
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: ["campaign_id", "stat_time_day"],
        metrics: TIKTOK_REPORT_METRICS,
        start_date: from,
        end_date: to,
        page,
        page_size: PAGE_SIZE,
      },
    });
    pages = Math.min(Number(data?.page_info?.total_page ?? 1) || 1, 1000);
    for (const r of data?.list ?? []) {
      const date = String(r.dimensions?.stat_time_day ?? "").slice(0, 10);
      if (!date || date < from || date > to) continue;
      const m = r.metrics ?? {};
      const v: V = {
        ad_spend: Number(m.spend ?? 0) || 0,
        ad_impressions: Number(m.impressions ?? 0) || 0,
        ad_clicks: Number(m.clicks ?? 0) || 0,
        ad_conversions: Number(m.conversion ?? 0) || 0,
      };
      totals.set(date, addTo(totals.get(date) ?? zero(), v));
      const k = `${date}|${m.campaign_name || `Campaign ${r.dimensions?.campaign_id}`}`;
      camp.set(k, addTo(camp.get(k) ?? zero(), v));
    }
  }
  const round = (v: V): V => ({ ...v, ad_spend: Math.round(v.ad_spend! * 100) / 100, ad_conversions: Math.round(v.ad_conversions! * 100) / 100 });
  // The report omits days without delivery: those are true zeros for the advertiser.
  const out: ReportRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, dimKey: "", dimValue: "", values: round(totals.get(d) ?? zero()) });
  for (const [k, v] of camp) {
    const i = k.indexOf("|");
    out.push({ date: k.slice(0, i), dimKey: "campaign", dimValue: k.slice(i + 1), values: round(v) });
  }
  return out;
}

function result(token: string, ids: string[], accounts: AssetInfo[], mode: "token" | "oauth", scopes: string[]): CallbackResult {
  return {
    credentials: { access_token: token, advertiser_ids: ids, mode },
    scopes,
    externalAccountId: `tiktok:${[...ids].sort()[0]}`,
    displayName: accounts.length === 1 ? accounts[0]!.name : `TikTok Ads (${accounts.length} advertisers)`,
    tokenExpiresAt: null,
    settings: { authMode: mode },
  };
}

const SCOPES = ["Ad Account Management", "Reporting"];

export const tiktokAds: ConnectorDefinition = {
  id: "tiktok_ads",
  name: "TikTok Ads",
  category: "Advertising",
  description: "TikTok ad spend, impressions, clicks and conversions by campaign.",
  implemented: true,
  configKeys: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"],
  accessRequirements: [
    "For “Sign in with TikTok”: an approved TikTok for Business developer app with the Ad Account Management and Reporting scopes, and redirect URI <API_URL>/api/oauth/tiktok_ads/callback. Without it, users connect with a long-term access token.",
  ],
  scopes: [
    { scope: "Ad Account Management", reason: "Read advertiser names, currency and timezone" },
    { scope: "Reporting", reason: "Read daily campaign performance" },
  ],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Usually complete within a few hours; conversions restate for up to 28 days",
  staleAfterHours: 12,
  syncIntervalMinutes: 240,
  reconcileDays: 35,
  docsUrl: "https://business-api.tiktok.com/portal/docs?id=1740302848100353",
  tokenConnect: {
    fields: [
      { key: "accessToken", label: "Long-term access token", secret: true, help: "From your TikTok for Business developer app after authorizing your advertiser account." },
      { key: "advertiserIds", label: "Advertiser IDs", placeholder: "7012345678901234567, …", optional: true, help: "Comma-separated. Find them in TikTok Ads Manager under the account name. Can be left empty if this platform has a TikTok app configured." },
    ],
    instructions: [
      "Go to business-api.tiktok.com → My Apps and create (or open) a developer app; request the Ad Account Management and Reporting scopes.",
      "Open the app's advertiser authorization URL, sign in with a TikTok Ads Manager user and authorize the advertiser accounts to report on.",
      "Exchange the returned auth_code for a long-term access token (the developer portal's API tools or POST /open_api/v1.3/oauth2/access_token/).",
      "Paste the access token here, and the advertiser IDs (shown in TikTok Ads Manager next to the account name).",
    ],
    async connect(input) {
      const token = (input.accessToken ?? "").trim();
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw new ProviderError("permanent", "That doesn't look like a TikTok for Business access token (a long string of letters and digits).");
      let ids = parseIds(input.advertiserIds ?? "");
      if (ids.some((id) => !/^\d{6,25}$/.test(id))) throw new ProviderError("permanent", "Advertiser IDs are numbers, separated by commas.");
      if (!ids.length) {
        if (!appCreds()) throw new ProviderError("permanent", "Enter the advertiser IDs to connect (comma-separated).");
        ids = await authorizedAdvertisers(token);
        if (!ids.length) throw new ProviderError("permanent", "No advertiser accounts are authorized for this token.");
      }
      const accounts = await advertiserInfo(token, ids);
      if (!accounts.length) throw new ProviderError("permanent", "TikTok didn't return any of these advertiser accounts. Check the IDs and that the token is authorized for them.");
      return result(token, accounts.map((a) => a.providerAssetId), accounts, "token", SCOPES);
    },
  },
  authorizeUrl({ state, redirectUri }) {
    const q = new URLSearchParams({ app_id: process.env.TIKTOK_APP_ID!, state, redirect_uri: redirectUri });
    return `${T("https://business-api.tiktok.com/portal/auth")}?${q}`;
  },
  async handleCallback({ query }) {
    const code = query.auth_code ?? query.code;
    if (!code) throw new ProviderError("permanent", "TikTok didn't return an authorization code.");
    const app = appCreds()!;
    const data = await call<{ access_token: string; advertiser_ids?: (string | number)[]; scope?: number[] }>("oauth2/access_token/", { json: { app_id: app.app_id, secret: app.secret, auth_code: code }, retries: 0 });
    const ids = (data.advertiser_ids ?? []).map(String);
    if (!ids.length) throw new ProviderError("permanent", "No advertiser accounts were authorized. Select at least one advertiser account when signing in.");
    const accounts = await advertiserInfo(data.access_token, ids);
    return result(data.access_token, ids, accounts, "oauth", SCOPES);
  },
  // Long-term tokens don't expire.
  needsRefresh: () => false,
  async discoverAssets(creds: Credentials) {
    let ids: string[] = creds.advertiser_ids ?? [];
    if (creds.mode === "oauth") ids = [...new Set([...ids, ...(await authorizedAdvertisers(creds.access_token).catch(() => []))])];
    return advertiserInfo(creds.access_token, ids);
  },
  sync: (ctx) => syncReport(ctx, {
    owned: OWNED,
    money: new Set(["ad_spend"]),
    initialDays: 365,
    lookbackDays: 28,
    reconcileDays: 35,
    lagDays: 0,
    windowDays: 30,
    zeroFillTotals: true,
    fetch: fetchWindow,
  }),
  async healthCheck(ctx) {
    await advertiserInfo((await ctx.credentials()).access_token, [ctx.asset.provider_asset_id]);
  },
  async revoke(creds) {
    const app = appCreds();
    if (creds.mode !== "oauth" || !app) return; // pasted tokens belong to the user's own app
    await call("oauth2/revoke_token/", { json: { app_id: app.app_id, secret: app.secret, access_token: creds.access_token }, retries: 0 });
  },
};
