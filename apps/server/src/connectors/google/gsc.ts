import { ProviderError, providerFetch } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import { G, bearer, googleAuthorizeUrl, googleCallback } from "./oauth.js";
import { OWN_CLIENT_FIELDS, SA_FIELD, connectGoogleVariant, googleNeedsRefresh, googleRefresh, googleRevokeIfOwned, googleTokenResult, ownClientSteps } from "./access.js";

/**
 * Google Search Console via the Search Analytics API. Dates are in Pacific Time,
 * and only finalized days are requested (typically 2–3 days behind). Days with no
 * data are omitted by the API, so missing days are left unavailable rather than
 * zero-filled. Average position is stored as position × impressions so it can be
 * re-aggregated correctly over any range.
 */
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const SA_STEPS = [
  "In Google Cloud (console.cloud.google.com) pick or create a project and enable the “Google Search Console API” (APIs & Services → Library).",
  "IAM & Admin → Service accounts → Create service account (no roles needed). Open it → Keys → Add key → Create new key → JSON. A .json file downloads.",
  "Copy the service account's email (…@….iam.gserviceaccount.com). In Search Console pick your property → Settings → Users and permissions → Add user, paste the email and choose Restricted.",
  "Open the .json file in a text editor, copy everything and paste it below.",
];
const PAGE = 5000;
/** Safety cap per breakdown request; beyond it the long tail is folded into "(other)". */
const MAX_ROWS = 50_000;
const API = (path: string) => G(`https://www.googleapis.com/webmasters/v3/${path}`);
const OWNED = ["organic_clicks", "organic_impressions", "organic_position_sum"];

const BREAKDOWNS: { dimKey: string; gsc: string; limit: number }[] = [
  { dimKey: "query", gsc: "query", limit: 50 },
  { dimKey: "page", gsc: "page", limit: 50 },
  { dimKey: "country", gsc: "country", limit: 30 },
  { dimKey: "device", gsc: "device", limit: 5 },
];

async function query(site: string, creds: Credentials, from: string, to: string, dims: string[]) {
  const rows: any[] = [];
  for (let startRow = 0; startRow < MAX_ROWS; startRow += PAGE) {
    const { data } = await providerFetch(API(`sites/${encodeURIComponent(site)}/searchAnalytics/query`), {
      provider: "Search Console",
      method: "POST",
      idempotent: true,
      headers: bearer(creds),
      json: { startDate: from, endDate: to, dimensions: dims, rowLimit: PAGE, startRow, dataState: "final" },
    });
    rows.push(...(data.rows ?? []));
    if ((data.rows?.length ?? 0) < PAGE) break;
  }
  return rows;
}

const values = (r: any) => ({
  organic_clicks: Number(r.clicks ?? 0),
  organic_impressions: Number(r.impressions ?? 0),
  organic_position_sum: Number(r.position ?? 0) * Number(r.impressions ?? 0),
});

const DEVICE: Record<string, string> = { MOBILE: "mobile", DESKTOP: "desktop", TABLET: "tablet" };

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  const site = ctx.asset.provider_asset_id;
  const out: ReportRow[] = [];
  const totals = new Map<string, ReturnType<typeof values>>();
  for (const r of await query(site, creds, from, to, ["date"])) {
    const v = values(r);
    totals.set(r.keys[0], v);
    out.push({ date: r.keys[0], dimKey: "", dimValue: "", values: v });
  }
  for (const b of BREAKDOWNS) {
    const rows = await query(site, creds, from, to, ["date", b.gsc]);
    const perDay = new Map<string, any[]>();
    for (const r of rows) perDay.set(r.keys[0], [...(perDay.get(r.keys[0]) ?? []), r]);
    for (const [d, list] of perDay) {
      list.sort((a, z) => z.clicks - a.clicks || z.impressions - a.impressions);
      const top = list.slice(0, b.limit);
      for (const r of top) {
        const label = b.gsc === "device" ? (DEVICE[r.keys[1]] ?? "other") : b.gsc === "country" ? String(r.keys[1]).toUpperCase() : r.keys[1];
        out.push({ date: d, dimKey: b.dimKey, dimValue: label, values: values(r) });
      }
      // Remainder vs. the day's property total: the long tail plus (for queries) anonymized
      // queries Google withholds. Page-level counts can exceed property totals, so only a
      // positive remainder is kept.
      const total = totals.get(d);
      if (!total) continue;
      const shown = top.reduce((s, r) => { const v = values(r); s.organic_clicks += v.organic_clicks; s.organic_impressions += v.organic_impressions; s.organic_position_sum += v.organic_position_sum; return s; },
        { organic_clicks: 0, organic_impressions: 0, organic_position_sum: 0 });
      const rest = { organic_clicks: total.organic_clicks - shown.organic_clicks, organic_impressions: total.organic_impressions - shown.organic_impressions, organic_position_sum: total.organic_position_sum - shown.organic_position_sum };
      if (rest.organic_impressions > 0 && rest.organic_clicks >= 0 && rest.organic_position_sum > 0) {
        out.push({ date: d, dimKey: b.dimKey, dimValue: b.gsc === "query" ? "(other / anonymized)" : "(other)", values: rest });
      }
    }
  }
  return out;
}

export const gsc: ConnectorDefinition = {
  id: "gsc",
  name: "Google Search Console",
  category: "Search",
  description: "Organic clicks, impressions, CTR and average position by query, page, country and device.",
  implemented: true,
  configKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  accessRequirements: [
    "A Google Cloud OAuth client with redirect URI <API_URL>/api/oauth/gsc/callback and the Google Search Console API enabled.",
    "webmasters.readonly is a sensitive scope: Google OAuth app verification is required before external users can connect.",
  ],
  scopes: [{ scope: SCOPE, reason: "Read Search Console properties and search performance" }],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Finalized data is 2–3 days behind (dates in Pacific Time)",
  staleAfterHours: 96,
  syncIntervalMinutes: 360,
  reconcileDays: 10,
  tokenConnect: {
    fields: [SA_FIELD],
    instructions: SA_STEPS,
    variants: [
      { id: "service_account", label: "Service-account key", fields: [SA_FIELD], instructions: SA_STEPS },
      { id: "own_client", label: "Your own OAuth client", fields: OWN_CLIENT_FIELDS, instructions: ownClientSteps(SCOPE, "Google Search Console API") },
    ],
    async connect(input) {
      const v = await connectGoogleVariant(input, [SCOPE]);
      const { data } = await providerFetch(API("sites"), { provider: "Search Console", headers: bearer(v.creds) });
      const sites = (data.siteEntry ?? []).filter((s: any) => s.permissionLevel !== "siteUnverifiedUser");
      if (!sites.length) {
        throw new ProviderError("permanent", v.creds.mode === "service_account"
          ? `The service account ${v.identity} has no access to a Search Console property yet. In Search Console open Settings → Users and permissions → Add user, paste that email with Restricted (or Full) permission, then try again.`
          : "This Google account has no verified Search Console properties.");
      }
      return googleTokenResult(v, { externalAccountId: `gsc:${sites[0].siteUrl}:${v.identity}`, displayName: sites.length === 1 ? sites[0].siteUrl : `Search Console (${sites.length} properties)` });
    },
  },
  authorizeUrl: ({ state, redirectUri }) => googleAuthorizeUrl([SCOPE], state, redirectUri),
  async handleCallback({ query: q, redirectUri }) {
    const { creds, scopes, expiresAt } = await googleCallback(q, redirectUri, [SCOPE]);
    const { data } = await providerFetch(API("sites"), { provider: "Search Console", headers: bearer(creds) });
    const sites = (data.siteEntry ?? []).filter((s: any) => s.permissionLevel !== "siteUnverifiedUser");
    if (!sites.length) throw new ProviderError("permanent", "This Google account has no verified Search Console properties.");
    // Google gives no stable account id for Search Console; the token's sites identify it.
    return { credentials: creds, scopes, externalAccountId: `gsc:${sites[0].siteUrl}`, displayName: sites.length === 1 ? sites[0].siteUrl : `Search Console (${sites.length} properties)`, tokenExpiresAt: expiresAt };
  },
  needsRefresh: googleNeedsRefresh,
  refreshCredentials: googleRefresh,
  async discoverAssets(creds) {
    const { data } = await providerFetch(API("sites"), { provider: "Search Console", headers: bearer(creds) });
    return (data.siteEntry ?? [])
      .filter((s: any) => s.permissionLevel !== "siteUnverifiedUser")
      .map((s: any) => ({
        providerAssetId: s.siteUrl,
        name: String(s.siteUrl).replace(/^sc-domain:/, "Domain: "),
        kind: String(s.siteUrl).startsWith("sc-domain:") ? "domain_property" : "url_prefix_property",
        currency: null,
        timezone: "America/Los_Angeles",
        metadata: { permissionLevel: s.permissionLevel },
      }));
  },
  sync: (ctx) => syncReport(ctx, {
    owned: OWNED,
    money: new Set(),
    initialDays: 480, // Search Console keeps 16 months
    lookbackDays: 4,
    reconcileDays: 10,
    lagDays: 1,
    windowDays: 30,
    zeroFillTotals: false,
    fetch: fetchWindow,
  }),
  async healthCheck(ctx) {
    const creds = await ctx.credentials();
    await providerFetch(API(`sites/${encodeURIComponent(ctx.asset.provider_asset_id)}`), { provider: "Search Console", headers: bearer(creds) });
  },
  revoke: (creds) => googleRevokeIfOwned(creds),
};
