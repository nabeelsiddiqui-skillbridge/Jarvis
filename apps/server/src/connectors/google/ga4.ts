import { ProviderError, providerFetch } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import type { ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import { G, bearer, googleAuthorizeUrl, googleCallback } from "./oauth.js";
import { OWN_CLIENT_FIELDS, SA_FIELD, connectGoogleVariant, googleNeedsRefresh, googleRefresh, googleRevokeIfOwned, googleTokenResult, ownClientSteps } from "./access.js";

/**
 * Google Analytics 4 via the Analytics Data API (runReport) and Admin API
 * (property discovery). Days are in the property's timezone; GA4 data can change
 * for ~48h, so recent days are re-fetched on every sync.
 */
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** Our metric key → GA4 API metric name. */
const METRICS: Record<string, string> = {
  sessions: "sessions",
  users: "activeUsers",
  engaged_sessions: "engagedSessions",
  key_events: "keyEvents",
  add_to_carts: "addToCarts",
  checkouts: "checkouts",
  ga4_purchases: "ecommercePurchases",
  ga4_revenue: "purchaseRevenue",
};

/** Breakdown reports: our dimension → GA4 dimension + which metrics to break down. */
const BREAKDOWNS: { dimKey: string; ga4: string; metrics: string[]; limit?: number }[] = [
  { dimKey: "channel", ga4: "sessionDefaultChannelGroup", metrics: ["sessions", "engaged_sessions", "key_events", "add_to_carts", "checkouts", "ga4_purchases", "ga4_revenue"] },
  { dimKey: "source_medium", ga4: "sessionSourceMedium", metrics: ["sessions", "engaged_sessions", "key_events", "ga4_purchases", "ga4_revenue"], limit: 50 },
  { dimKey: "device", ga4: "deviceCategory", metrics: ["sessions", "users", "engaged_sessions"] },
  { dimKey: "country", ga4: "country", metrics: ["sessions", "users"], limit: 50 },
  { dimKey: "landing_page", ga4: "landingPage", metrics: ["sessions", "key_events"], limit: 50 },
];

const DATA = (path: string) => G(`https://analyticsdata.googleapis.com/v1beta/${path}`);
const SA_STEPS = [
  "In Google Cloud (console.cloud.google.com) pick or create a project, then enable the “Google Analytics Data API” and “Google Analytics Admin API” (APIs & Services → Library).",
  "IAM & Admin → Service accounts → Create service account (no roles needed). Open it → Keys → Add key → Create new key → JSON. A .json file downloads.",
  "Copy the service account's email (…@….iam.gserviceaccount.com). In Google Analytics open Admin → Property access management (or Account access management for all properties) → + → Add users, paste the email and give it the Viewer role.",
  "Open the .json file in a text editor, copy everything and paste it below.",
];
const ADMIN = (path: string) => G(`https://analyticsadmin.googleapis.com/v1beta/${path}`);

/**
 * GA4 field availability differs by property (ecommerce events, custom setups), so
 * the metrics actually requested are validated against the property's metadata.
 */
async function supportedMetrics(propertyId: string, creds: Credentials): Promise<Record<string, string>> {
  const { data } = await providerFetch(DATA(`${propertyId}/metadata`), { provider: "Google Analytics", headers: bearer(creds) });
  const names = new Set((data.metrics ?? []).map((m: any) => m.apiName));
  return Object.fromEntries(Object.entries(METRICS).filter(([, api]) => names.has(api)));
}

async function runReport(propertyId: string, creds: Credentials, body: unknown) {
  const rows: any[] = [];
  let offset = 0;
  for (;;) {
    const { data } = await providerFetch(DATA(`${propertyId}:runReport`), {
      provider: "Google Analytics",
      method: "POST",
      idempotent: true,
      headers: bearer(creds),
      json: { ...(body as object), offset, limit: 100000 },
    });
    rows.push(...(data.rows ?? []));
    offset += data.rows?.length ?? 0;
    if (!data.rowCount || offset >= data.rowCount || !data.rows?.length) break;
  }
  return rows;
}

const gaDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  const prop = ctx.asset.provider_asset_id;
  const available = (ctx.asset.metadata?.metrics as Record<string, string> | undefined) ?? (await supportedMetrics(prop, creds));
  const keys = Object.keys(available);
  if (!keys.length) throw new ProviderError("permanent", "This GA4 property exposes none of the supported metrics.");
  const out: ReportRow[] = [];

  // Totals with empty rows kept, so days with no traffic are explicit zeros.
  const totals = await runReport(prop, creds, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "date" }],
    metrics: keys.map((k) => ({ name: available[k] })),
    keepEmptyRows: true,
  });
  for (const r of totals) {
    out.push({ date: gaDate(r.dimensionValues[0].value), dimKey: "", dimValue: "", values: Object.fromEntries(keys.map((k, i) => [k, Number(r.metricValues[i].value)])) });
  }
  for (const b of BREAKDOWNS) {
    const ms = b.metrics.filter((m) => available[m]);
    if (!ms.length) continue;
    const rows = await runReport(prop, creds, {
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: "date" }, { name: b.ga4 }],
      metrics: ms.map((m) => ({ name: available[m] })),
      orderBys: [{ metric: { metricName: available[ms[0]!] }, desc: true }],
    });
    // Keep the top values per day; the rest are summed into "(other)" so breakdowns still reconcile.
    const perDay = new Map<string, any[]>();
    for (const r of rows) {
      const d = gaDate(r.dimensionValues[0].value);
      perDay.set(d, [...(perDay.get(d) ?? []), r]);
    }
    for (const [d, list] of perDay) {
      const top = list.slice(0, b.limit ?? 1000);
      const rest = list.slice(b.limit ?? 1000);
      for (const r of top) out.push({ date: d, dimKey: b.dimKey, dimValue: r.dimensionValues[1].value || "(not set)", values: Object.fromEntries(ms.map((m, i) => [m, Number(r.metricValues[i].value)])) });
      if (rest.length) out.push({ date: d, dimKey: b.dimKey, dimValue: "(other)", values: Object.fromEntries(ms.map((m, i) => [m, rest.reduce((s, r) => s + Number(r.metricValues[i].value), 0)])) });
    }
  }
  return out;
}

export const ga4: ConnectorDefinition = {
  id: "ga4",
  name: "Google Analytics 4",
  category: "Analytics",
  description: "Sessions, users, engagement, key events and the ecommerce funnel by channel, source, device, country and landing page.",
  implemented: true,
  configKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  accessRequirements: [
    "A Google Cloud OAuth client (Web application) with redirect URI <API_URL>/api/oauth/ga4/callback, and the Analytics Data API + Analytics Admin API enabled.",
    "analytics.readonly is a sensitive scope: Google OAuth app verification is required before external users can connect (test users work meanwhile).",
  ],
  scopes: [{ scope: SCOPE, reason: "Read GA4 properties and reports" }],
  metrics: Object.keys(METRICS),
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Data is typically complete after 24–48 hours",
  staleAfterHours: 30,
  syncIntervalMinutes: 180,
  reconcileDays: 30,
  tokenConnect: {
    fields: [SA_FIELD],
    instructions: SA_STEPS,
    variants: [
      { id: "service_account", label: "Service-account key", fields: [SA_FIELD], instructions: SA_STEPS },
      { id: "own_client", label: "Your own OAuth client", fields: OWN_CLIENT_FIELDS, instructions: ownClientSteps(SCOPE, "Google Analytics Data API and Google Analytics Admin API") },
    ],
    async connect(input) {
      const v = await connectGoogleVariant(input, [SCOPE]);
      const { data } = await providerFetch(ADMIN("accountSummaries?pageSize=200"), { provider: "Google Analytics", headers: bearer(v.creds) });
      const first = (data.accountSummaries ?? []).find((a: any) => a.propertySummaries?.length);
      if (!first) {
        throw new ProviderError("permanent", v.creds.mode === "service_account"
          ? `The service account ${v.identity} can't see any GA4 property yet. In Google Analytics open Admin → Property access management, add that email as a Viewer, then try again (it can take a minute to apply).`
          : "This Google account has no Google Analytics properties.");
      }
      return googleTokenResult(v, { externalAccountId: `ga:${first.account}:${v.identity}`, displayName: first.displayName ?? "Google Analytics" });
    },
  },
  authorizeUrl: ({ state, redirectUri }) => googleAuthorizeUrl([SCOPE], state, redirectUri),
  async handleCallback({ query, redirectUri }) {
    const { creds, scopes, expiresAt } = await googleCallback(query, redirectUri, [SCOPE]);
    const { data } = await providerFetch(ADMIN("accountSummaries?pageSize=200"), { provider: "Google Analytics", headers: bearer(creds) });
    const first = data.accountSummaries?.[0];
    if (!first) throw new ProviderError("permanent", "This Google account has no Google Analytics access.");
    return { credentials: creds, scopes, externalAccountId: `ga:${first.account}`, displayName: first.displayName ?? "Google Analytics", tokenExpiresAt: expiresAt };
  },
  needsRefresh: googleNeedsRefresh,
  refreshCredentials: googleRefresh,
  async discoverAssets(creds) {
    const { data } = await providerFetch(ADMIN("accountSummaries?pageSize=200"), { provider: "Google Analytics", headers: bearer(creds) });
    const props = (data.accountSummaries ?? []).flatMap((a: any) => (a.propertySummaries ?? []).map((p: any) => ({ ...p, accountName: a.displayName })));
    const assets = [];
    for (const p of props.slice(0, 100)) {
      const { data: d } = await providerFetch(ADMIN(p.property), { provider: "Google Analytics", headers: bearer(creds) });
      const metrics = await supportedMetrics(p.property, creds).catch(() => METRICS);
      assets.push({ providerAssetId: p.property, name: `${p.displayName} (${p.accountName})`, kind: "property", currency: d.currencyCode ?? null, timezone: d.timeZone ?? null, metadata: { metrics } });
    }
    return assets;
  },
  sync: (ctx) => syncReport(ctx, {
    owned: Object.keys(METRICS),
    money: new Set(["ga4_revenue"]),
    initialDays: 400,
    lookbackDays: 3,
    reconcileDays: 30,
    lagDays: 0,
    windowDays: 90,
    zeroFillTotals: true,
    fetch: fetchWindow,
  }),
  async healthCheck(ctx) {
    const creds = await ctx.credentials();
    await providerFetch(ADMIN(ctx.asset.provider_asset_id), { provider: "Google Analytics", headers: bearer(creds) });
  },
  revoke: (creds) => googleRevokeIfOwned(creds),
};
