import { createHash, createHmac } from "node:crypto";
import { addDays, todayIn } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { datesBetween, localDate, type FactInput } from "../normalize.js";
import { Tally, deleteRecords, finishRecordSync, overridable, recomputeDays, required, storeRecords, writeSnapshot, type StoredRecord } from "../kit.js";
import type { CallbackResult, ConnectorDefinition, Credentials, SyncContext, SyncResult } from "../types.js";

/**
 * Salesforce (Sales Cloud). Two ways to connect:
 *  - OAuth 2.0 web server flow with the platform's connected app (PKCE, scopes "api refresh_token"),
 *    against login.salesforce.com or the org's My Domain / test.salesforce.com for sandboxes;
 *  - OAuth 2.0 client credentials flow with the customer's own connected app (consumer key + secret
 *    and a run-as user) — the access token is simply re-requested when it expires.
 * Salesforce doesn't return token lifetimes (they follow the org's session timeout), so tokens are
 * treated as valid for SESSION_MINUTES and renewed before that.
 *
 * Data comes from REST SOQL queries (following nextRecordsUrl), incremental by SystemModstamp:
 *  - Lead → crm_new_contacts by CreatedDate (lifecycle_stage = Status, source_medium = LeadSource);
 *    crm_qualified_leads = leads converted, by ConvertedDate (conversion is Salesforce's qualification step).
 *  - Opportunity → deals created by CreatedDate; won/lost and won value by CloseDate;
 *    the pipeline dimension is the opportunity's record type (or "Opportunities" when the org has none);
 *    open pipeline/open deals are a snapshot for the sync day by StageName.
 * Deletions come from /sobjects/X/deleted (Salesforce keeps ~30 days of them). Multi-currency orgs:
 * amounts in a currency other than the org's default currency are left out of money figures (with a note).
 */
const SF = overridable("SALESFORCE_BASE_URL_OVERRIDE");
export const SALESFORCE_API_VERSION = "v62.0";
const LOGIN = "https://login.salesforce.com";
const SCOPES = ["api", "refresh_token"];
/** Assumed access-token lifetime (Salesforce's default session timeout is 2 hours). */
const SESSION_MINUTES = 60;
const FLOW = ["crm_new_contacts", "crm_qualified_leads", "crm_deals_created", "crm_deals_won", "crm_deals_lost", "crm_won_value"];
const SNAPSHOT = ["crm_open_deals", "crm_open_pipeline"];
const MONEY = new Set(["crm_won_value", "crm_open_pipeline"]);
const DATE_FIELDS = ["created", "qualified", "closed"];
const INITIAL_DAYS = 400;
const DEFAULT_PIPELINE = "Opportunities";

/** What we keep per record — no names, emails or other personal data. */
interface LeadRec { created: string; qualified: string | null; stage: string; source: string }
interface DealRec { created: string; closed: string | null; status: "open" | "won" | "lost"; pipeline: string; stage: string; amount: number | null; foreignCurrency: string | null }

// ------------------------------------------------------------------ hosts + auth

/** A Salesforce login host: login/test.salesforce.com or a My Domain (…my.salesforce.com, sandboxes included). */
function loginHost(raw: string | undefined, requireMyDomain = false): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) {
    if (requireMyDomain) throw new ProviderError("permanent", "Your My Domain URL is required (Setup → My Domain, e.g. https://acme.my.salesforce.com).");
    return LOGIN;
  }
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ProviderError("permanent", "Enter a Salesforce URL such as https://acme.my.salesforce.com.");
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(salesforce|force)\.com$/.test(host)) {
    throw new ProviderError("permanent", "Enter a Salesforce URL such as https://acme.my.salesforce.com (or https://test.salesforce.com for a sandbox).");
  }
  if (requireMyDomain && !/\.my\.salesforce\.com$/.test(host)) throw new ProviderError("permanent", "The client credentials flow needs your org's My Domain URL (it ends in .my.salesforce.com).");
  return `https://${host}`;
}

const bearer = (c: Credentials) => ({ Authorization: `Bearer ${c.access_token}` });
const expiry = () => new Date(Date.now() + SESSION_MINUTES * 60_000);

/** PKCE verifier bound to the one-time state (the platform keeps no extra per-flow storage). */
function pkceVerifier(state: string) {
  return createHmac("sha256", `sf-pkce:${process.env.SALESFORCE_CLIENT_SECRET ?? ""}`).update(state).digest("base64url");
}
const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

interface TokenResponse { access_token: string; refresh_token?: string; instance_url: string; id?: string; scope?: string }

async function tokenRequest(host: string, form: Record<string, string>, friendly: string, kind: "auth" | "permanent" = "auth"): Promise<TokenResponse> {
  try {
    const { data } = await providerFetch(SF(`${host}/services/oauth2/token`), { provider: "Salesforce", method: "POST", form, retries: 0 });
    if (!data?.access_token || !data?.instance_url) throw new ProviderError("permanent", "Salesforce returned an unexpected token response.");
    return data as TokenResponse;
  } catch (e) {
    // invalid_grant / invalid_client come back as HTTP 400.
    if (e instanceof ProviderError && e.status === 400) throw new ProviderError(kind, friendly, 400, undefined, e.detail);
    throw e;
  }
}

function instance(creds: Credentials) {
  // instance_url comes from Salesforce's token response; still insist on a Salesforce host.
  return loginHost(creds.instance_url);
}

async function api<T = any>(creds: Credentials, pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith("/") ? `${instance(creds)}${pathOrUrl}` : `${instance(creds)}/services/data/${SALESFORCE_API_VERSION}/${pathOrUrl}`;
  const { data } = await providerFetch(SF(url), { provider: "Salesforce", headers: bearer(creds) });
  return data as T;
}

/** Run a SOQL query, following nextRecordsUrl until done. */
async function soql(creds: Credentials, q: string, onPage: (records: any[]) => Promise<void> | void) {
  let page = await api(creds, `query?q=${encodeURIComponent(q)}`);
  let n = 0;
  for (;;) {
    const recs: any[] = page.records ?? [];
    n += recs.length;
    if (recs.length) await onPage(recs);
    if (page.done || !page.nextRecordsUrl) break;
    page = await api(creds, page.nextRecordsUrl);
  }
  return n;
}

interface Org { Id: string; Name: string; TimeZoneSidKey: string | null; DefaultCurrencyIsoCode: string | null; IsSandbox?: boolean }

async function organization(creds: Credentials): Promise<Org> {
  let org: Org | undefined;
  await soql(creds, "SELECT Id, Name, TimeZoneSidKey, DefaultCurrencyIsoCode, IsSandbox FROM Organization LIMIT 1", (r) => { org = r[0]; });
  if (!org) throw new ProviderError("permanent", "Salesforce didn't return the organization.");
  return org;
}

/** Which optional Opportunity fields exist in this org (multi-currency, record types). */
async function opportunityShape(creds: Credentials) {
  const d = await api(creds, "sobjects/Opportunity/describe");
  const names = new Set<string>((d.fields ?? []).map((f: any) => f.name));
  return { multiCurrency: names.has("CurrencyIsoCode"), recordTypes: names.has("RecordTypeId") };
}

async function connected(creds: Credentials, mode: "oauth" | "client_credentials"): Promise<CallbackResult> {
  const org = await organization(creds);
  return {
    credentials: creds,
    scopes: SCOPES,
    externalAccountId: org.Id,
    displayName: `${org.Name}${org.IsSandbox ? " (sandbox)" : ""}`,
    tokenExpiresAt: expiry(),
    settings: mode === "client_credentials" ? { authMode: "token" } : { authMode: "oauth" },
  };
}

// ------------------------------------------------------------------ normalize

const iso = (s: string) => new Date(s).toISOString();

function normLead(o: any, tz: string): LeadRec | null {
  if (!o.CreatedDate) return null;
  return {
    created: localDate(o.CreatedDate, tz),
    // ConvertedDate is a date field (already the org's calendar day).
    qualified: o.IsConverted && o.ConvertedDate ? String(o.ConvertedDate).slice(0, 10) : null,
    stage: o.Status || "Unknown",
    source: o.LeadSource || "Unknown",
  };
}

function normDeal(o: any, tz: string, currency: string | null): DealRec | null {
  if (!o.CreatedDate) return null;
  const status = o.IsWon ? "won" : o.IsClosed ? "lost" : "open";
  const cur = o.CurrencyIsoCode ?? null;
  const foreign = cur && currency && cur !== currency ? cur : null;
  const amount = o.Amount == null || foreign ? null : Number(o.Amount);
  return {
    created: localDate(o.CreatedDate, tz),
    closed: status !== "open" && o.CloseDate ? String(o.CloseDate).slice(0, 10) : null,
    status,
    pipeline: o.RecordType?.Name || DEFAULT_PIPELINE,
    stage: o.StageName || "Unknown stage",
    amount: Number.isFinite(amount) ? amount : null,
    foreignCurrency: foreign,
  };
}

// ------------------------------------------------------------------ aggregate

function dayFacts(date: string, records: ((LeadRec | DealRec) & { _type: string })[], currency: string | null): FactInput[] {
  const t = new Tally(FLOW);
  for (const r of records) {
    if (r._type === "lead") {
      const l = r as LeadRec;
      if (l.created === date) t.addAll("crm_new_contacts", 1, { lifecycle_stage: l.stage, source_medium: l.source });
      if (l.qualified === date) t.addAll("crm_qualified_leads", 1, { source_medium: l.source });
    } else {
      const d = r as DealRec;
      if (d.created === date) t.addAll("crm_deals_created", 1, { pipeline: d.pipeline });
      if (d.closed === date && d.status === "won") {
        t.addAll("crm_deals_won", 1, { pipeline: d.pipeline });
        t.addAll("crm_won_value", d.amount ?? 0, { pipeline: d.pipeline });
      }
      if (d.closed === date && d.status === "lost") t.addAll("crm_deals_lost", 1, { pipeline: d.pipeline });
    }
  }
  return t.facts(MONEY, currency);
}

async function snapshot(ctx: SyncContext, currency: string | null) {
  const { rows } = await ctx.db.query(`SELECT payload FROM source_records WHERE asset_id = $1 AND record_type = 'deal' AND payload->>'status' = 'open'`, [ctx.asset.id]);
  const t = new Tally(SNAPSHOT);
  let missing = 0;
  for (const { payload: d } of rows as { payload: DealRec }[]) {
    if (d.amount == null && !d.foreignCurrency) missing++;
    const dims = { deal_stage: d.stage, pipeline: d.pipeline };
    t.addAll("crm_open_deals", 1, dims);
    t.addAll("crm_open_pipeline", d.amount ?? 0, dims);
  }
  return { facts: t.facts(MONEY, currency), missing };
}

// ------------------------------------------------------------------ sync

const soqlTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Ids deleted in [start, end] (Salesforce keeps about 30 days of deletions). */
async function deletedIds(creds: Credentials, object: "Lead" | "Opportunity", startMs: number, endMs: number) {
  const q = new URLSearchParams({ start: soqlTime(startMs), end: soqlTime(endMs) });
  const d = await api(creds, `sobjects/${object}/deleted/?${q}`);
  return ((d.deletedRecords ?? []) as { id: string }[]).map((r) => r.id);
}

async function syncOrg(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? "UTC";
  const currency = ctx.asset.currency ?? null;
  const today = todayIn(tz);
  const cursor = ctx.asset.sync_cursor ?? {};
  const initial = ctx.mode === "initial" || !cursor.coveredFrom;
  const coveredFrom: string = initial ? addDays(today, -INITIAL_DAYS + 1) : cursor.coveredFrom;
  const startedAt = Date.now();
  const overlap = 10 * 60_000;
  const affected = new Set<string>();
  const notes: string[] = [];

  // Refresh the optional field set each run (an admin may enable multi-currency or record types).
  const shape = await opportunityShape(creds);
  // Initial: leads touched since the window start and *all* opportunities (old open deals are pipeline).
  // Incremental: everything modified since the last run (with overlap). Reconcile: re-read 30 days.
  const reconcileFrom = startedAt - 30 * 86_400_000;
  const leadSince = initial ? Date.parse(`${coveredFrom}T00:00:00Z`) - 86_400_000 : ctx.mode === "reconcile" ? reconcileFrom : Number(cursor.leadsModifiedMs ?? startedAt) - overlap;
  const dealSince = initial ? 0 : ctx.mode === "reconcile" ? reconcileFrom : Number(cursor.dealsModifiedMs ?? startedAt) - overlap;

  let maxLead = Number(cursor.leadsModifiedMs ?? 0);
  let maxDeal = Number(cursor.dealsModifiedMs ?? 0);
  const leadQ = `SELECT Id, CreatedDate, LeadSource, Status, IsConverted, ConvertedDate, SystemModstamp FROM Lead WHERE SystemModstamp >= ${soqlTime(leadSince)} ORDER BY SystemModstamp ASC`;
  const dealFields = ["Id", "CreatedDate", "CloseDate", "IsClosed", "IsWon", "Amount", "StageName", "SystemModstamp", ...(shape.recordTypes ? ["RecordType.Name"] : []), ...(shape.multiCurrency ? ["CurrencyIsoCode"] : [])];
  const dealQ = `SELECT ${dealFields.join(", ")} FROM Opportunity${dealSince ? ` WHERE SystemModstamp >= ${soqlTime(dealSince)}` : ""} ORDER BY SystemModstamp ASC`;

  const leads = await soql(creds, leadQ, async (rs) => {
    const recs: StoredRecord<LeadRec>[] = [];
    for (const o of rs) {
      const n = normLead(o, tz);
      maxLead = Math.max(maxLead, Date.parse(o.SystemModstamp) || 0);
      if (n) recs.push({ type: "lead", id: o.Id, payload: n, date: n.created, occurredAt: iso(o.CreatedDate), updatedAt: o.SystemModstamp ?? null });
    }
    await storeRecords(ctx, recs, ["created", "qualified"], affected);
  });
  const deals = await soql(creds, dealQ, async (rs) => {
    const recs: StoredRecord<DealRec>[] = [];
    for (const o of rs) {
      const n = normDeal(o, tz, currency);
      maxDeal = Math.max(maxDeal, Date.parse(o.SystemModstamp) || 0);
      if (n) recs.push({ type: "deal", id: o.Id, payload: n, date: n.created, occurredAt: iso(o.CreatedDate), updatedAt: o.SystemModstamp ?? null });
    }
    await storeRecords(ctx, recs, ["created", "closed"], affected);
  });
  ctx.log(`fetched ${leads} leads, ${deals} opportunities`);

  // Deletions since the last check (Salesforce retains about 30 days of them).
  if (!initial) {
    const floor = startedAt - 29 * 86_400_000;
    const start = ctx.mode === "reconcile" ? floor : Math.max(Number(cursor.deletedCheckedMs ?? floor) - overlap, floor);
    const end = Math.ceil(startedAt / 1000) * 1000; // SOQL times have whole seconds
    await deleteRecords(ctx, "lead", await deletedIds(creds, "Lead", start, end), DATE_FIELDS, affected);
    await deleteRecords(ctx, "deal", await deletedIds(creds, "Opportunity", start, end), DATE_FIELDS, affected);
  }

  const prevTo: string | null = cursor.coveredTo ?? null;
  const fill = datesBetween(initial || !prevTo ? coveredFrom : addDays(prevTo, 1) <= today ? addDays(prevTo, 1) : today, today);
  const dates = [...new Set([...affected, ...fill])].filter((d) => d >= coveredFrom && d <= today);
  const recomputed = await recomputeDays<LeadRec | DealRec>(ctx, dates, {
    recordTypes: ["lead", "deal"], dateFields: DATE_FIELDS, owned: FLOW, compute: (d, recs) => dayFacts(d, recs, currency),
  });
  const snap = await snapshot(ctx, currency);
  await writeSnapshot(ctx, today, snap.facts, SNAPSHOT);

  const foreign = await ctx.db.query(`SELECT count(*)::int AS n FROM source_records WHERE asset_id = $1 AND record_type = 'deal' AND payload->>'foreignCurrency' IS NOT NULL`, [ctx.asset.id]);
  if (foreign.rows[0].n) notes.push(`${foreign.rows[0].n} opportunities are in a currency other than ${currency}; their amounts are left out of won value and pipeline (they still count as deals).`);
  if (snap.missing) notes.push(`${snap.missing} open opportunities have no amount and add nothing to pipeline value.`);
  if (initial) notes.push("Open pipeline is recorded from today onward; past pipeline snapshots aren't reconstructed.");

  return finishRecordSync(ctx, {
    coveredFrom, today, records: leads + deals, recomputed, notes,
    cursor: { leadsModifiedMs: Math.max(maxLead, initial ? startedAt - overlap : 0), dealsModifiedMs: Math.max(maxDeal, initial ? startedAt - overlap : 0), deletedCheckedMs: startedAt },
  });
}

// ------------------------------------------------------------------ definition

const clientId = () => process.env.SALESFORCE_CLIENT_ID ?? "";
const clientSecret = () => process.env.SALESFORCE_CLIENT_SECRET ?? "";

export const salesforce: ConnectorDefinition = {
  id: "salesforce",
  name: "Salesforce",
  category: "CRM",
  description: "New leads, converted leads, opportunities created, won and lost, won value and open pipeline by stage and record type.",
  implemented: true,
  configKeys: ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET"],
  accessRequirements: [
    "A Salesforce connected app (or external client app) with OAuth enabled, callback URL <API_URL>/api/oauth/salesforce/callback, scopes \"Manage user data via APIs (api)\" and \"Perform requests at any time (refresh_token, offline_access)\", and PKCE enabled.",
    "The connecting user needs API Enabled and read access to Leads, Opportunities and the Organization.",
  ],
  scopes: [
    { scope: "api", reason: "Read leads (status, source, conversion) and opportunities (stage, amount, close date) through the REST API; no names or emails are stored" },
    { scope: "refresh_token", reason: "Keep syncing without asking you to sign in again" },
  ],
  metrics: [...FLOW, ...SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Changes appear at the next sync (every hour)",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: 30,
  docsUrl: "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm",
  connectFields: [
    { key: "loginUrl", label: "My Domain / sandbox login URL (optional)", placeholder: "https://acme.my.salesforce.com", help: "Leave empty for login.salesforce.com. Use https://test.salesforce.com or your sandbox My Domain for sandboxes." },
  ],
  authorizeUrl({ state, redirectUri, input }) {
    const host = loginHost(input.loginUrl);
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId(), redirect_uri: redirectUri, scope: SCOPES.join(" "), state,
      code_challenge: pkceChallenge(pkceVerifier(state)), code_challenge_method: "S256", prompt: "login consent",
    });
    return `${SF(`${host}/services/oauth2/authorize`)}?${q}`;
  },
  async handleCallback({ query, redirectUri, input }) {
    if (!query.code) throw new ProviderError("permanent", "Salesforce didn't return an authorization code.");
    const host = loginHost(input.loginUrl);
    const t = await tokenRequest(host, {
      grant_type: "authorization_code", code: query.code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri, code_verifier: pkceVerifier(query.state ?? ""),
    }, "Salesforce didn't accept the authorization. Please try connecting again.");
    if (!t.refresh_token) throw new ProviderError("permanent", "Salesforce didn't grant offline access. Make sure the connected app allows the refresh_token scope.");
    return connected({ mode: "oauth", login_url: host, access_token: t.access_token, refresh_token: t.refresh_token, instance_url: t.instance_url }, "oauth");
  },
  tokenConnect: {
    fields: [
      { key: "domain", label: "My Domain URL", placeholder: "https://acme.my.salesforce.com", help: "Setup → My Domain → Current My Domain URL" },
      { key: "clientId", label: "Consumer key", placeholder: "3MVG…" },
      { key: "clientSecret", label: "Consumer secret", secret: true },
    ],
    instructions: [
      "In Salesforce Setup open App Manager and create a connected app (or an external client app) with OAuth enabled.",
      "Select the OAuth scope \"Manage user data via APIs (api)\" and tick \"Enable Client Credentials Flow\".",
      "Under Manage → Edit Policies set a Run As user (an API-enabled user who can read Leads, Opportunities and the Organization).",
      "Copy the consumer key and secret (Manage Consumer Details) and your My Domain URL (Setup → My Domain).",
    ],
    async connect(input) {
      const v = required(input, { domain: "My Domain URL", clientId: "Consumer key", clientSecret: "Consumer secret" });
      const host = loginHost(v.domain, true);
      if (!/^3MVG[A-Za-z0-9._]{20,}$/.test(v.clientId)) throw new ProviderError("permanent", "That doesn't look like a Salesforce consumer key (it starts with 3MVG).");
      if (!/^[A-Za-z0-9]{8,}$/.test(v.clientSecret)) throw new ProviderError("permanent", "That doesn't look like a Salesforce consumer secret.");
      const t = await tokenRequest(host, { grant_type: "client_credentials", client_id: v.clientId, client_secret: v.clientSecret },
        "Salesforce rejected the consumer key or secret, or the app has no Client Credentials run-as user.", "permanent");
      return connected({ mode: "client_credentials", login_url: host, client_id: v.clientId, client_secret: v.clientSecret, access_token: t.access_token, instance_url: t.instance_url }, "client_credentials");
    },
  },
  needsRefresh: (_c, expiresAt) => !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60_000,
  async refreshCredentials(creds) {
    const host = loginHost(creds.login_url);
    if (creds.mode === "client_credentials") {
      const t = await tokenRequest(host, { grant_type: "client_credentials", client_id: creds.client_id, client_secret: creds.client_secret },
        "Salesforce no longer accepts the connected app's consumer key or secret. Reconnect with current values.");
      return { credentials: { ...creds, access_token: t.access_token, instance_url: t.instance_url }, expiresAt: expiry() };
    }
    const t = await tokenRequest(host, { grant_type: "refresh_token", client_id: clientId(), client_secret: clientSecret(), refresh_token: creds.refresh_token },
      "Salesforce access was revoked or expired. Reconnect the account.");
    return { credentials: { ...creds, access_token: t.access_token, instance_url: t.instance_url ?? creds.instance_url }, expiresAt: expiry() };
  },
  async discoverAssets(creds) {
    const org = await organization(creds);
    const shape = await opportunityShape(creds);
    return [{
      providerAssetId: org.Id, name: org.Name, kind: "org", currency: org.DefaultCurrencyIsoCode ?? null, timezone: org.TimeZoneSidKey ?? null,
      metadata: { multiCurrency: shape.multiCurrency, recordTypes: shape.recordTypes, sandbox: Boolean(org.IsSandbox) },
    }];
  },
  sync: syncOrg,
  async healthCheck(ctx) {
    await api(await ctx.credentials(), "limits");
  },
  async revoke(creds) {
    if (creds.mode !== "oauth" || !creds.refresh_token) return; // client-credentials apps are managed by the customer
    await providerFetch(SF(`${loginHost(creds.login_url)}/services/oauth2/revoke`), { provider: "Salesforce", method: "POST", form: { token: creds.refresh_token }, retries: 0 });
  },
};
