import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { overridable } from "../kit.js";
import { syncReport, type ReportRow } from "../report.js";
import type { ConnectorDefinition, Credentials, SyncContext } from "../types.js";

/**
 * Klaviyo, connected with a private API key (`Authorization: Klaviyo-API-Key pk_…`, JSON:API
 * with a dated `revision` header). The account is the single asset, in its own timezone.
 *
 * Data model: daily figures come pre-aggregated from the Metric Aggregates API (report-based
 * sync), for Klaviyo's built-in email metrics, covering campaigns and flows:
 *  - email_sends = "Received Email" events (count, by delivery day)
 *  - email_opens = "Opened Email", email_clicks = "Clicked Email", email_unsubscribes =
 *    "Unsubscribed from Email Marketing" (legacy accounts: "Unsubscribed") — unique profiles
 *    per day, so a profile opening on two days counts twice (approximation of unique opens).
 *  - the campaign dimension groups by "Campaign Name"; flow emails count in the totals only.
 * email_list_size isn't imported: Klaviyo exposes per-list profile counts only, which overlap
 * across lists, and no de-duplicated subscriber total.
 */
const K = overridable("KLAVIYO_BASE_URL_OVERRIDE");
const API = (path: string) => K(`https://a.klaviyo.com/api/${path}`);
export const KLAVIYO_REVISION = "2025-07-15";
const KEY_FORMAT = /^pk_[A-Za-z0-9]{20,}$/;
const SCOPES = ["accounts:read", "metrics:read"];
const OWNED = ["email_sends", "email_opens", "email_clicks", "email_unsubscribes"];

/** Klaviyo built-in metric names → our metric and the measurement used. */
const METRICS: { key: string; names: string[]; measure: "count" | "unique" }[] = [
  { key: "email_sends", names: ["Received Email"], measure: "count" },
  { key: "email_opens", names: ["Opened Email"], measure: "unique" },
  { key: "email_clicks", names: ["Clicked Email"], measure: "unique" },
  { key: "email_unsubscribes", names: ["Unsubscribed from Email Marketing", "Unsubscribed"], measure: "unique" },
];
const CAMPAIGN_BY = "Campaign Name";

const headers = (creds: Credentials) => ({ Authorization: `Klaviyo-API-Key ${creds.api_key}`, revision: KLAVIYO_REVISION, Accept: "application/vnd.api+json" });

async function request<T = any>(creds: Credentials, url: string, json?: unknown) {
  return (await providerFetch<T>(url, {
    provider: "Klaviyo",
    headers: { ...headers(creds), ...(json ? { "Content-Type": "application/vnd.api+json" } : {}) },
    ...(json ? { method: "POST", body: JSON.stringify(json), idempotent: true } : {}),
    retries: 4, // aggregates are rate limited (burst 3/s, 60/min); 429s carry Retry-After
  })).data;
}

async function account(creds: Credentials) {
  const r = await request(creds, API("accounts/"));
  const a = r?.data?.[0];
  if (!a) throw new ProviderError("permanent", "Klaviyo returned no account for this key.");
  const at = a.attributes ?? {};
  return { id: String(a.id), name: (at.contact_information?.organization_name as string) || "Klaviyo account", timezone: (at.timezone as string) || null, currency: (at.preferred_currency as string) || null };
}

/** Metric ids of Klaviyo's own email metrics (integration "Klaviyo"), by our metric key. */
async function metricIds(creds: Credentials): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  // Paginate with links.next (absolute provider URLs, routed through the override in tests).
  for (let url: string | null = `https://a.klaviyo.com/api/metrics/?${new URLSearchParams({ filter: 'equals(integration.name,"Klaviyo")' })}`; url; ) {
    const r: any = await request(creds, K(url));
    for (const m of r?.data ?? []) if (m.attributes?.name && !byName.has(m.attributes.name)) byName.set(m.attributes.name, String(m.id));
    url = r?.links?.next ?? null;
  }
  const out = new Map<string, string>();
  for (const m of METRICS) {
    const id = m.names.map((n) => byName.get(n)).find(Boolean);
    if (id) out.set(m.key, id);
  }
  return out;
}

/** Daily series for one metric, optionally grouped (`by`), with page_cursor pagination. */
async function aggregate(creds: Credentials, metricId: string, measure: string, from: string, to: string, tz: string, by?: string) {
  const series: { dims: string[]; values: number[] }[] = [];
  let dates: string[] = [];
  let cursor: string | null = null;
  do {
    const attributes: Record<string, unknown> = {
      metric_id: metricId,
      measurements: [measure],
      interval: "day",
      page_size: 500,
      timezone: tz,
      filter: [`greater-or-equal(datetime,${from}T00:00:00)`, `less-than(datetime,${addDays(to, 1)}T00:00:00)`],
      ...(by ? { by: [by] } : {}),
      ...(cursor ? { page_cursor: cursor } : {}),
    };
    const r = await request(creds, API("metric-aggregates/"), { data: { type: "metric-aggregate", attributes } });
    const at = r?.data?.attributes ?? {};
    dates = (at.dates ?? []).map((d: string) => d.slice(0, 10)); // local midnights in `tz`
    for (const row of at.data ?? []) series.push({ dims: row.dimensions ?? [], values: (row.measurements?.[measure] ?? []).map(Number) });
    const next: string | null = r?.links?.next ?? null;
    cursor = next ? new URL(next).searchParams.get("page_cursor") : null;
  } while (cursor);
  return { dates, series };
}

const perSync = new WeakMap<SyncContext, Promise<Map<string, string>>>();

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? "UTC";
  if (!perSync.has(ctx)) perSync.set(ctx, metricIds(creds));
  const ids = await perSync.get(ctx)!;

  const totals = new Map<string, Record<string, number>>();
  const camp = new Map<string, Record<string, number>>(); // `${date}\u0000${campaign}`
  for (let d = from; d <= to; d = addDays(d, 1)) totals.set(d, Object.fromEntries(OWNED.map((k) => [k, 0])));
  for (const m of METRICS) {
    const id = ids.get(m.key);
    if (!id) continue; // the account never recorded this event: true zeros
    // Sequential on purpose: aggregates have a low burst limit.
    const total = await aggregate(creds, id, m.measure, from, to, tz);
    for (const s of total.series) s.values.forEach((v, i) => {
      const t = totals.get(total.dates[i]!);
      if (t) t[m.key]! += v;
    });
    const grouped = await aggregate(creds, id, m.measure, from, to, tz, CAMPAIGN_BY);
    for (const s of grouped.series) {
      const name = s.dims[0];
      if (!name) continue; // flow messages have no campaign name
      s.values.forEach((v, i) => {
        const date = grouped.dates[i]!;
        if (!v || !totals.has(date)) return;
        const k = `${date}\u0000${name}`;
        const row = camp.get(k) ?? {};
        row[m.key] = (row[m.key] ?? 0) + v;
        camp.set(k, row);
      });
    }
  }
  const rows: ReportRow[] = [...totals].map(([date, values]) => ({ date, dimKey: "", dimValue: "", values }));
  for (const [k, values] of camp) {
    const [date, name] = k.split("\u0000") as [string, string];
    rows.push({ date, dimKey: "campaign", dimValue: name, values });
  }
  return rows;
}

export const klaviyo: ConnectorDefinition = {
  id: "klaviyo",
  name: "Klaviyo",
  category: "Email",
  description: "Email deliveries, opens, clicks and unsubscribes (campaigns and flows), by campaign.",
  implemented: true,
  configKeys: [],
  scopes: [
    { scope: "accounts:read", reason: "Read the account name, timezone and currency." },
    { scope: "metrics:read", reason: "Read daily email delivery, open, click and unsubscribe totals." },
  ],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Events appear within minutes; synced every 6 hours, re-checking the last 7 days",
  staleAfterHours: 26,
  syncIntervalMinutes: 360,
  reconcileDays: 30,
  docsUrl: "https://developers.klaviyo.com/en/docs/retrieve_api_credentials",
  tokenConnect: {
    fields: [{ key: "apiKey", label: "Private API key", placeholder: "pk_…", secret: true }],
    instructions: [
      "In Klaviyo click your organization name (bottom left) → Settings → Account → API keys (klaviyo.com/settings/account/api-keys).",
      "Click Create Private API Key, name it (e.g. \"Business Command AI\") and choose Read-Only Key — or Custom Key with Read access to Accounts and Metrics.",
      "Copy the key (it starts with pk_). Klaviyo shows it only once.",
    ],
    async connect(input) {
      const key = (input.apiKey ?? "").trim();
      if (!KEY_FORMAT.test(key)) throw new ProviderError("permanent", "That doesn't look like a Klaviyo private API key (it starts with pk_). Public site IDs won't work.");
      const creds = { api_key: key };
      let a: Awaited<ReturnType<typeof account>>;
      try {
        a = await account(creds);
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "scope") throw new ProviderError("permanent", "This Klaviyo key can't read account details. Give it Read access to Accounts and Metrics (or use a Read-Only key).");
        throw e;
      }
      return { credentials: creds, scopes: SCOPES, externalAccountId: a.id, displayName: a.name, tokenExpiresAt: null, settings: { authMode: "token" } };
    },
  },
  async discoverAssets(creds) {
    const a = await account(creds);
    return [{ providerAssetId: a.id, name: a.name, kind: "account", currency: a.currency, timezone: a.timezone }];
  },
  async sync(ctx) {
    const result = await syncReport(ctx, {
      owned: OWNED,
      money: new Set(),
      initialDays: 365,
      lookbackDays: 7,
      reconcileDays: 30,
      lagDays: 0,
      windowDays: 31,
      zeroFillTotals: true,
      fetch: fetchWindow,
    });
    return { ...result, notes: ["Klaviyo has no de-duplicated subscriber count, so email subscribers aren't imported from Klaviyo."] };
  },
  async healthCheck(ctx) {
    await account(await ctx.credentials());
  },
};
