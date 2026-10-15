import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { syncReport, type ReportRow } from "../report.js";
import { formatMetricValue, type ActionTarget } from "@bca/shared";
import type { ActionContext, ActionDefinition, ActionPayload, AssetInfo, ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import { G, googleAuthorizeUrl, googleCallback } from "./oauth.js";
import { OWN_CLIENT_FIELDS, connectGoogleVariant, googleNeedsRefresh, googleRefresh, googleRevokeIfOwned, googleTokenResult, ownClientSteps } from "./access.js";

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
const OWN_ADS_FIELDS = [
  { key: "developerToken", label: "Developer token", placeholder: "22 characters", secret: true, help: "Google Ads manager account → Tools → API Center." },
  ...OWN_CLIENT_FIELDS,
];
const OWN_ADS_STEPS = [
  "You need a Google Ads manager (MCC) account that manages your ad account — create one free at ads.google.com/home/tools/manager-accounts and link your account to it.",
  "In the manager account open Tools → API Center, accept the terms and copy the developer token. A new token has Test access only; apply for Explorer or Basic access there to reach real accounts.",
  ...ownClientSteps(SCOPE, "Google Ads API"),
];
const OWNED = ["ad_spend", "ad_impressions", "ad_clicks", "ad_conversions", "ad_conversion_value"];

function headers(creds: Credentials, loginCustomerId?: string | null) {
  return {
    Authorization: `Bearer ${creds.access_token}`,
    // Connections made with the user's own Google Cloud client carry their own developer token.
    "developer-token": creds.developer_token ?? process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
    ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
  };
}

/** Developer-token problems are platform setup issues, not user errors — say so plainly. */
function explain(e: unknown): never {
  if (e instanceof ProviderError && /DEVELOPER_TOKEN_(NOT_APPROVED|PROHIBITED|INVALID)|developer token/i.test(e.detail ?? "")) {
    throw new ProviderError("scope", "The Google Ads developer token isn't approved for this account (test-level tokens only reach test accounts). Apply for Explorer or Basic access in the manager account's API Center.", e.status, undefined, e.detail);
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

// ------------------------------------------------------------------ actions

async function mutate(customerId: string, creds: Credentials, login: string | null, resource: "campaigns" | "campaignBudgets", operation: unknown, validateOnly: boolean) {
  try {
    const { data } = await providerFetch(API(`customers/${customerId}/${resource}:mutate`), {
      provider: "Google Ads", method: "POST", retries: 0, timeoutMs: 30_000,
      headers: headers(creds, login), json: { operations: [operation], partialFailure: false, validateOnly },
    });
    return data;
  } catch (e) {
    explain(e);
  }
}

interface Campaign { customerId: string; id: string; name: string; status: string; budgetResource: string; budgetMicros: number; sharedBudget: boolean; currency: string | null; assetId: string; assetName: string; login: string | null }

async function campaigns(ctx: ActionContext, onlyCustomer?: string, onlyCampaign?: string): Promise<Campaign[]> {
  const creds = await ctx.credentials();
  const out: Campaign[] = [];
  for (const a of ctx.assets.filter((x) => !onlyCustomer || x.provider_asset_id === onlyCustomer)) {
    const login = (a.metadata?.loginCustomerId as string | undefined) ?? null;
    const rows = await search(a.provider_asset_id, creds, login,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared
         FROM campaign WHERE campaign.status != 'REMOVED'${onlyCampaign ? ` AND campaign.id = ${Number(onlyCampaign)}` : ""} ORDER BY campaign.name LIMIT 200`);
    for (const r of rows) {
      out.push({ customerId: a.provider_asset_id, id: String(r.campaign?.id), name: r.campaign?.name ?? `Campaign ${r.campaign?.id}`, status: r.campaign?.status, budgetResource: r.campaign?.campaignBudget, budgetMicros: Number(r.campaignBudget?.amountMicros ?? 0), sharedBudget: Boolean(r.campaignBudget?.explicitlySharedBudget ?? r.campaignBudget?.explicitlyShared), currency: a.currency, assetId: a.id, assetName: a.name, login });
    }
  }
  return out;
}

async function oneCampaign(ctx: ActionContext, targetId: string) {
  const [customerId, campaignId] = targetId.split(":");
  if (!customerId || !campaignId || !/^\d+$/.test(customerId) || !/^\d+$/.test(campaignId)) throw new ProviderError("permanent", "Unknown campaign.");
  const c = (await campaigns(ctx, customerId, campaignId))[0];
  if (!c) throw new ProviderError("not_found", "That campaign wasn't found in the connected Google Ads accounts.");
  return c;
}

async function recentSpend(ctx: ActionContext, assetId: string, campaignName: string) {
  const r = await ctx.db.query(
    `SELECT sum(value)::float8 AS v FROM metric_facts WHERE asset_id = $1 AND metric_key = 'ad_spend' AND dim_key = 'campaign' AND dim_value = $2 AND date >= current_date - 7`,
    [assetId, campaignName],
  );
  return r.rows[0]?.v as number | null;
}

const money = (v: number, cur: string | null) => formatMetricValue(v, "currency", cur ?? "USD");
const STATUS_LABEL: Record<string, string> = { ENABLED: "Enabled", PAUSED: "Paused" };

const toTarget = (c: Campaign, fields: ActionTarget["fields"]): ActionTarget => ({
  id: `${c.customerId}:${c.id}`, name: c.name, kind: "campaign", assetId: c.assetId, assetName: c.assetName,
  state: { status: c.status, dailyBudget: c.budgetMicros / 1e6, sharedBudget: c.sharedBudget },
  summary: `${STATUS_LABEL[c.status] ?? c.status} · ${money(c.budgetMicros / 1e6, c.currency)}/day${c.sharedBudget ? " (shared budget)" : ""}`,
  fields,
});

const setStatus: ActionDefinition = {
  type: "google_ads.campaign.set_status",
  label: "Pause or enable a campaign",
  description: "Pause a Google Ads campaign so its ads stop serving, or enable a paused one.",
  targetKind: "campaign",
  requiredScopes: [SCOPE],
  async listTargets(ctx) {
    return (await campaigns(ctx)).map((c) => toTarget(c, [{ key: "status", label: "New status", kind: "select", options: [{ value: "PAUSED", label: "Paused" }, { value: "ENABLED", label: "Enabled" }] }]));
  },
  async prepare(ctx, targetId, params) {
    const status = params.status === "PAUSED" || params.status === "ENABLED" ? params.status : null;
    if (!status) throw new ProviderError("permanent", "Choose Paused or Enabled.");
    const c = await oneCampaign(ctx, targetId);
    if (c.status === status) throw new ProviderError("permanent", `The campaign is already ${STATUS_LABEL[status]!.toLowerCase()}.`);
    const creds = await ctx.credentials();
    // Ask Google Ads to validate the exact change without applying it.
    await mutate(c.customerId, creds, c.login, "campaigns", { update: { resourceName: `customers/${c.customerId}/campaigns/${c.id}`, status }, updateMask: "status" }, true);
    const spend = await recentSpend(ctx, c.assetId, c.name);
    return {
      target: { kind: "campaign", id: `${c.customerId}:${c.id}`, name: c.name },
      assetId: c.assetId,
      params: { status },
      current: { status: c.status },
      proposed: { status },
      changes: [{ label: "Status", current: STATUS_LABEL[c.status] ?? c.status, proposed: STATUS_LABEL[status]! }],
      expectedEffect: status === "PAUSED"
        ? `Ads in "${c.name}" stop serving until the campaign is enabled again.${spend != null ? ` It spent ${money(spend, c.currency)} over the last 7 days of synced data; that spend — and the clicks and conversions it brought — would stop.` : ""}`
        : `Ads in "${c.name}" can start serving again within its ${money(c.budgetMicros / 1e6, c.currency)} daily budget.`,
      risk: "medium",
    };
  },
  async readState(ctx, payload) {
    const c = await oneCampaign(ctx, payload.target.id);
    return { status: c.status };
  },
  async execute(ctx, payload) {
    const c = await oneCampaign(ctx, payload.target.id);
    const creds = await ctx.credentials();
    const response = await mutate(c.customerId, creds, c.login, "campaigns", { update: { resourceName: `customers/${c.customerId}/campaigns/${c.id}`, status: payload.params.status }, updateMask: "status" }, false);
    return { response };
  },
};

const setBudget: ActionDefinition = {
  type: "google_ads.campaign.set_budget",
  label: "Change a campaign's daily budget",
  description: "Set the average daily budget of a Google Ads campaign (campaigns with a shared budget aren't supported).",
  targetKind: "campaign",
  requiredScopes: [SCOPE],
  async listTargets(ctx) {
    return (await campaigns(ctx)).filter((c) => !c.sharedBudget).map((c) => toTarget(c, [{ key: "dailyBudget", label: `New daily budget (${c.currency ?? ""})`, kind: "money", help: "Average daily spend; Google Ads may spend up to twice this on some days." }]));
  },
  async prepare(ctx, targetId, params) {
    const amount = Math.round(Number(params.dailyBudget) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 1) throw new ProviderError("permanent", "Enter a daily budget of at least 1.");
    const c = await oneCampaign(ctx, targetId);
    if (c.sharedBudget) throw new ProviderError("permanent", "This campaign uses a shared budget that affects other campaigns; change it in Google Ads.");
    const current = c.budgetMicros / 1e6;
    if (Math.abs(current - amount) < 0.005) throw new ProviderError("permanent", "That's already the campaign's daily budget.");
    if (amount > current * 10 && current > 0) throw new ProviderError("permanent", "That's more than ten times the current budget. Make large increases in steps.");
    const creds = await ctx.credentials();
    await mutate(c.customerId, creds, c.login, "campaignBudgets", { update: { resourceName: c.budgetResource, amountMicros: String(Math.round(amount * 1e6)) }, updateMask: "amount_micros" }, true);
    const pct = current ? ((amount - current) / current) * 100 : 100;
    return {
      target: { kind: "campaign", id: `${c.customerId}:${c.id}`, name: c.name },
      assetId: c.assetId,
      params: { dailyBudget: amount },
      current: { dailyBudgetMicros: c.budgetMicros },
      proposed: { dailyBudgetMicros: Math.round(amount * 1e6) },
      changes: [{ label: "Daily budget", current: money(current, c.currency), proposed: money(amount, c.currency) }],
      expectedEffect: `Average daily spend for "${c.name}" can ${amount > current ? "rise" : "fall"} by up to ${money(Math.abs(amount - current), c.currency)} (${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%), about ${money(Math.abs(amount - current) * 30.4, c.currency)} a month. Results depend on demand and bidding; Google Ads may spend up to twice the daily amount on individual days.`,
      risk: pct > 50 ? "high" : pct > 0 ? "medium" : "low",
    };
  },
  async readState(ctx, payload) {
    const c = await oneCampaign(ctx, payload.target.id);
    return { dailyBudgetMicros: c.budgetMicros };
  },
  async execute(ctx, payload) {
    const c = await oneCampaign(ctx, payload.target.id);
    if (c.sharedBudget) throw new ProviderError("permanent", "The campaign now uses a shared budget; the change wasn't made.");
    const creds = await ctx.credentials();
    const response = await mutate(c.customerId, creds, c.login, "campaignBudgets", { update: { resourceName: c.budgetResource, amountMicros: String(Math.round(Number(payload.params.dailyBudget) * 1e6)) }, updateMask: "amount_micros" }, false);
    return { response };
  },
};

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
  scopes: [{ scope: SCOPE, reason: "Read accounts and performance; campaign changes happen only through actions an administrator approves" }],
  metrics: OWNED,
  actions: ["Pause or enable a campaign", "Change a campaign's daily budget"],
  actionDefs: [setStatus, setBudget],
  supportsWebhooks: false,
  reportingDelay: "Spend updates within ~3 hours; conversions can change for up to 30 days",
  staleAfterHours: 12,
  syncIntervalMinutes: 180,
  reconcileDays: 30,
  tokenConnect: {
    fields: OWN_ADS_FIELDS,
    instructions: OWN_ADS_STEPS,
    async connect(input) {
      const developer_token = (input.developerToken ?? "").trim();
      if (!/^[A-Za-z0-9_-]{16,40}$/.test(developer_token)) throw new ProviderError("permanent", "Enter the 22-character developer token from your Google Ads manager account (Tools → API Center).");
      const v = await connectGoogleVariant({ ...input, _method: "own_client" }, [SCOPE]);
      const creds = { ...v.creds, developer_token };
      const accounts = await listAccounts(creds);
      if (!accounts.length) throw new ProviderError("permanent", "No enabled Google Ads accounts are accessible to the Google user that created the refresh token.");
      return googleTokenResult({ ...v, creds }, { externalAccountId: `gads:${accounts.map((a) => a.providerAssetId).sort()[0]}`, displayName: accounts.length === 1 ? accounts[0]!.name : `Google Ads (${accounts.length} accounts)` });
    },
  },
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
  revoke: (creds) => googleRevokeIfOwned(creds),
};
