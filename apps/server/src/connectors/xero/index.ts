import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { Tally, basic, businessTimezone, finishRecordSync, overridable, recomputeDays, recordWindow, storeRecords, type StoredRecord } from "../kit.js";
import { datesBetween } from "../normalize.js";
import type { AssetInfo, CallbackResult, ConnectorDefinition, Credentials, SyncContext } from "../types.js";

/**
 * Xero accounting. Two ways to connect:
 *  - OAuth 2.0 (platform app): 30-minute access tokens, rotating 60-day refresh tokens. Every
 *    organisation ("tenant") the user authorized (GET /connections) is an asset; API calls
 *    carry the `xero-tenant-id` header.
 *  - Custom Connection (token connect): the user's own custom connection client ID + secret,
 *    exchanged with the client-credentials grant for 30-minute tokens (re-requested when
 *    expired). A custom connection is bound to one organisation, so no tenant header is sent.
 *
 * Data: the Journals endpoint (100 per page, ordered by JournalNumber, `offset` = last number
 * seen). Journals are immutable — edits and deletions post new (reversing) journals — so the
 * cursor is simply the last JournalNumber. Each journal's lines are aggregated by AccountType:
 * REVENUE/SALES → revenue (credits are negative, so the sign is flipped), OTHERINCOME → net
 * profit only, DIRECTCOSTS → cost of sales, EXPENSE/OVERHEADS/DEPRECIATN → operating expenses;
 * net profit = −(sum of all P&L lines). Amounts are NetAmount in the organisation's base
 * currency (journals are always in base currency). Journal dates are calendar dates.
 * We chose Journals over the ProfitAndLoss report because the report has no per-day columns
 * (it would need one call per day under a 60 calls/minute limit), while journals give exact
 * daily accrual figures and cheap incremental syncs.
 */

const X = overridable("XERO_BASE_URL_OVERRIDE");
const PROVIDER = "Xero";
const AUTHORIZE = "https://login.xero.com/identity/connect/authorize";
const TOKEN = "https://identity.xero.com/connect/token";
const REVOKE = "https://identity.xero.com/connect/revocation";
const CONNECTIONS = "https://api.xero.com/connections";
const API = (path: string) => X(`https://api.xero.com/api.xro/2.0/${path}`);
/** Read-only scopes: organisation settings (name, currency, timezone) and journals. */
export const XERO_SCOPES = ["offline_access", "accounting.settings.read", "accounting.journals.read"];

const OWNED = ["acct_revenue", "acct_cost_of_sales", "acct_operating_expenses", "acct_net_profit"];
const REVENUE = new Set(["REVENUE", "SALES"]);
const OTHER_INCOME = new Set(["OTHERINCOME"]);
const COGS = new Set(["DIRECTCOSTS"]);
const OPEX = new Set(["EXPENSE", "OVERHEADS", "DEPRECIATN"]);
/** Every P&L account type (anything else — bank, receivables, liabilities, equity — is balance sheet). */
const PNL = new Set([...REVENUE, ...OTHER_INCOME, ...COGS, ...OPEX]);
const PAGE = 100;

/** Common Xero timezone names → IANA. */
const TIMEZONES: Record<string, string> = {
  NEWZEALANDSTANDARDTIME: "Pacific/Auckland",
  AUSEASTERNSTANDARDTIME: "Australia/Sydney",
  EAUSTRALIASTANDARDTIME: "Australia/Brisbane",
  AUSCENTRALSTANDARDTIME: "Australia/Darwin",
  CENAUSTRALIASTANDARDTIME: "Australia/Adelaide",
  WAUSTRALIASTANDARDTIME: "Australia/Perth",
  TASMANIASTANDARDTIME: "Australia/Hobart",
  GMTSTANDARDTIME: "Europe/London",
  GREENWICHSTANDARDTIME: "Atlantic/Reykjavik",
  UTC: "UTC",
  WEUROPESTANDARDTIME: "Europe/Berlin",
  ROMANCESTANDARDTIME: "Europe/Paris",
  CENTRALEUROPESTANDARDTIME: "Europe/Budapest",
  CENTRALEUROPEANSTANDARDTIME: "Europe/Warsaw",
  GTBSTANDARDTIME: "Europe/Bucharest",
  FLESTANDARDTIME: "Europe/Helsinki",
  SOUTHAFRICASTANDARDTIME: "Africa/Johannesburg",
  EASTERNSTANDARDTIME: "America/New_York",
  CENTRALSTANDARDTIME: "America/Chicago",
  MOUNTAINSTANDARDTIME: "America/Denver",
  USMOUNTAINSTANDARDTIME: "America/Phoenix",
  PACIFICSTANDARDTIME: "America/Los_Angeles",
  ALASKANSTANDARDTIME: "America/Anchorage",
  HAWAIIANSTANDARDTIME: "Pacific/Honolulu",
  ATLANTICSTANDARDTIME: "America/Halifax",
  CANADACENTRALSTANDARDTIME: "America/Regina",
  NEWFOUNDLANDSTANDARDTIME: "America/St_Johns",
  SINGAPORESTANDARDTIME: "Asia/Singapore",
  CHINASTANDARDTIME: "Asia/Shanghai",
  TOKYOSTANDARDTIME: "Asia/Tokyo",
  INDIASTANDARDTIME: "Asia/Kolkata",
  ARABIANSTANDARDTIME: "Asia/Dubai",
  SEASIASTANDARDTIME: "Asia/Bangkok",
  FIJISTANDARDTIME: "Pacific/Fiji",
};
export const xeroTimezone = (name: unknown) => (typeof name === "string" ? TIMEZONES[name.toUpperCase()] ?? null : null);

// ------------------------------------------------------------------ auth

const appAuth = () => basic(process.env.XERO_CLIENT_ID ?? "", process.env.XERO_CLIENT_SECRET ?? "");

async function token(form: Record<string, string>, authorization: string) {
  try {
    const { data } = await providerFetch(X(TOKEN), { provider: PROVIDER, method: "POST", form, headers: { Authorization: authorization }, retries: 0 });
    return data as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  } catch (e) {
    // invalid_client / invalid_grant come back as 400.
    if (e instanceof ProviderError && e.status === 400) throw new ProviderError("auth", "Xero rejected the credentials. Reconnect the organisation.", 400, undefined, e.detail);
    throw e;
  }
}

/** Client-credentials token for a custom connection. */
async function customToken(clientId: string, clientSecret: string) {
  const t = await token({ grant_type: "client_credentials" }, basic(clientId, clientSecret));
  return { access_token: t.access_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
}

const headers = (creds: Credentials, tenantId?: string | null) => ({
  Authorization: `Bearer ${creds.access_token}`,
  ...(creds.mode !== "custom" && tenantId ? { "xero-tenant-id": tenantId } : {}),
});

interface Organisation {
  OrganisationID: string;
  Name: string;
  BaseCurrency?: string;
  Timezone?: string;
  CountryCode?: string;
}

async function organisation(creds: Credentials, tenantId?: string | null): Promise<Organisation> {
  const { data } = await providerFetch(API("Organisation"), { provider: PROVIDER, headers: headers(creds, tenantId) });
  const org = data?.Organisations?.[0];
  if (!org) throw new ProviderError("permanent", "Xero returned no organisation for this connection.");
  return org;
}

const orgAsset = (org: Organisation, tenantId: string): AssetInfo => ({
  providerAssetId: tenantId,
  name: org.Name,
  kind: "organisation",
  currency: org.BaseCurrency && /^[A-Z]{3}$/.test(org.BaseCurrency) ? org.BaseCurrency : null,
  timezone: xeroTimezone(org.Timezone),
  metadata: { xeroTimezone: org.Timezone ?? null, country: org.CountryCode ?? null, organisationId: org.OrganisationID },
});

// ------------------------------------------------------------------ journals

interface JournalLine {
  AccountType?: string;
  NetAmount?: number;
}
interface Journal {
  JournalID: string;
  JournalNumber: number;
  JournalDate: string;
  CreatedDateUTC?: string;
  JournalLines?: JournalLine[];
}
interface JournalRec {
  date: string;
  revenue: number;
  otherIncome: number;
  cogs: number;
  opex: number;
  /** Net profit: −(sum of all P&L lines). */
  net: number;
  n: number;
}

/** "/Date(1609459200000+0000)/" or ISO → YYYY-MM-DD (journal dates are calendar dates at UTC midnight). */
export function xeroDate(v: string): string | null {
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v ?? "");
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v ?? "");
  return iso ? iso[1]! : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Aggregate one journal's P&L lines; null when it doesn't touch the P&L. */
export function journalFigures(j: Journal): JournalRec | null {
  const date = xeroDate(j.JournalDate);
  if (!date) return null;
  const rec: JournalRec = { date, revenue: 0, otherIncome: 0, cogs: 0, opex: 0, net: 0, n: j.JournalNumber };
  let touches = false;
  for (const l of j.JournalLines ?? []) {
    const type = String(l.AccountType ?? "").toUpperCase();
    const amt = Number(l.NetAmount ?? 0);
    if (!PNL.has(type) || !Number.isFinite(amt)) continue;
    touches = true;
    if (REVENUE.has(type)) rec.revenue -= amt; // credits are negative
    else if (OTHER_INCOME.has(type)) rec.otherIncome -= amt;
    else if (COGS.has(type)) rec.cogs += amt;
    else rec.opex += amt;
    rec.net -= amt;
  }
  if (!touches) return null;
  for (const k of ["revenue", "otherIncome", "cogs", "opex", "net"] as const) rec[k] = r2(rec[k]);
  return rec;
}

async function journalsPage(creds: Credentials, tenantId: string, offset: number, since?: string): Promise<Journal[]> {
  const { data } = await providerFetch(API(`Journals?offset=${offset}`), {
    provider: PROVIDER,
    headers: { ...headers(creds, tenantId), ...(since ? { "If-Modified-Since": since } : {}) },
    timeoutMs: 60_000,
    retries: 4, // 60 calls/minute: 429s are retried after Retry-After
  });
  return (data?.Journals ?? []) as Journal[];
}

async function syncOrganisation(ctx: SyncContext) {
  const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
  const { today, initial, coveredFrom, cursor, allDays } = recordWindow(ctx, tz, 365);
  const creds = await ctx.credentials();
  const tenantId = ctx.asset.provider_asset_id;
  const affected = new Set<string>();
  // Initial: only journals created since shortly before the window (older journals can't be dated inside it
  // unless they were future-dated). Reconcile: re-read the last 1,000 journals. Otherwise: after the cursor.
  const last = Number(cursor.lastJournalNumber ?? 0);
  let offset = initial ? 0 : ctx.mode === "reconcile" ? Math.max(0, last - 1000) : last;
  const since = initial ? new Date(`${addDays(coveredFrom, -31)}T00:00:00Z`).toUTCString() : undefined;
  let maxNumber = initial ? 0 : last;
  let fetched = 0;
  for (;;) {
    const page = await journalsPage(creds, tenantId, offset, since);
    if (!page.length) break;
    fetched += page.length;
    const recs: StoredRecord<JournalRec>[] = [];
    for (const j of page) {
      maxNumber = Math.max(maxNumber, j.JournalNumber);
      // Future-dated journals are stored too; their day is computed once it arrives (see `fill`).
      const f = journalFigures(j);
      if (f && f.date >= coveredFrom) recs.push({ type: "journal", id: j.JournalID, payload: f, date: f.date, occurredAt: `${f.date}T00:00:00Z` });
    }
    await storeRecords(ctx, recs, ["date"], affected);
    offset = Math.max(...page.map((j) => j.JournalNumber));
    if (page.length < PAGE) break;
  }
  ctx.log(`fetched ${fetched} journals (up to #${maxNumber})`);

  // Days with no journals are real zeros; new days since the last run are filled too.
  const prevTo: string | null = cursor.coveredTo ?? null;
  const fill = initial || !prevTo ? allDays() : datesBetween(addDays(prevTo, 1) <= today ? addDays(prevTo, 1) : today, today);
  const recon = ctx.mode === "reconcile" ? datesBetween(addDays(today, -120) > coveredFrom ? addDays(today, -120) : coveredFrom, today) : [];
  const dates = [...new Set([...affected, ...fill, ...recon])].filter((d) => d >= coveredFrom && d <= today);
  const currency = ctx.asset.currency;
  const recomputed = await recomputeDays<JournalRec>(ctx, dates, {
    recordTypes: ["journal"],
    dateFields: ["date"],
    owned: OWNED,
    compute: (_d, recs) => {
      const t = new Tally(OWNED);
      for (const r of recs) {
        t.add("acct_revenue", r.revenue).add("acct_cost_of_sales", r.cogs).add("acct_operating_expenses", r.opex).add("acct_net_profit", r.net);
      }
      return t.facts(new Set(OWNED), currency);
    },
  });
  return finishRecordSync(ctx, { coveredFrom, today, records: fetched, recomputed, cursor: { lastJournalNumber: maxNumber } });
}

// ------------------------------------------------------------------ definition

export const xero: ConnectorDefinition = {
  id: "xero",
  name: "Xero",
  category: "Accounting",
  description: "Revenue, cost of sales, operating expenses and net profit per day from your Xero journals (accrual basis).",
  implemented: true,
  configKeys: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
  accessRequirements: [
    "A Xero app (Web app) with redirect URI <API_URL>/api/oauth/xero/callback and the scopes accounting.settings.read and accounting.journals.read.",
    "Without a platform app, organisations can connect with their own Xero Custom Connection (a paid Xero add-on in some regions).",
  ],
  scopes: [
    { scope: "accounting.journals.read", reason: "Read posted journals to total revenue, costs and expenses per day" },
    { scope: "accounting.settings.read", reason: "Read the organisation's name, base currency and timezone" },
    { scope: "offline_access", reason: "Keep syncing without asking you to sign in again" },
  ],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Updates as soon as transactions are approved; past periods change when books are edited",
  staleAfterHours: 30,
  syncIntervalMinutes: 360,
  reconcileDays: 120,
  docsUrl: "https://developer.xero.com/documentation/api/accounting/journals",
  authorizeUrl({ state, redirectUri }) {
    const q = new URLSearchParams({ response_type: "code", client_id: process.env.XERO_CLIENT_ID!, redirect_uri: redirectUri, scope: XERO_SCOPES.join(" "), state });
    return `${X(AUTHORIZE)}?${q}`;
  },
  async handleCallback({ query, redirectUri }) {
    if (!query.code) throw new ProviderError("permanent", "Xero didn't return an authorization code.");
    const t = await token({ grant_type: "authorization_code", code: query.code, redirect_uri: redirectUri }, appAuth());
    if (!t.refresh_token) throw new ProviderError("permanent", "Xero didn't grant offline access. Please try again and allow access.");
    const creds = { mode: "oauth", access_token: t.access_token, refresh_token: t.refresh_token };
    const tenants = await listTenants(creds);
    if (!tenants.length) throw new ProviderError("permanent", "No Xero organisation was authorized. Please try again and choose an organisation.");
    const scopes = (t.scope ?? XERO_SCOPES.join(" ")).split(" ").filter(Boolean);
    return {
      credentials: creds,
      scopes,
      // One connection per authorization; each organisation becomes a selectable asset.
      externalAccountId: tenants.map((x) => x.tenantId).sort().join(","),
      displayName: tenants.length === 1 ? tenants[0]!.tenantName : `${tenants[0]!.tenantName} + ${tenants.length - 1} more`,
      tokenExpiresAt: new Date(Date.now() + t.expires_in * 1000),
    };
  },
  tokenConnect: {
    fields: [
      { key: "clientId", label: "Custom connection client ID", placeholder: "32 characters", help: "From developer.xero.com → My Apps → your custom connection → Configuration." },
      { key: "clientSecret", label: "Client secret", secret: true, help: "Generate a secret on the same page and copy it before leaving." },
    ],
    instructions: [
      "Sign in at developer.xero.com, open My Apps and choose New app → Custom connection.",
      "Select the scopes accounting.settings.read and accounting.journals.read (read-only), and enter the email of the person who will authorize it.",
      "That person receives an email from Xero: open it, choose the organisation and approve the connection.",
      "Back in My Apps → your custom connection → Configuration, copy the Client ID, generate a client secret, and paste both here.",
    ],
    async connect(input): Promise<CallbackResult> {
      const clientId = (input.clientId ?? "").trim();
      const clientSecret = (input.clientSecret ?? "").trim();
      if (!/^[A-Fa-f0-9]{32}$/.test(clientId)) throw new ProviderError("permanent", "That doesn't look like a Xero client ID (32 letters and digits).");
      if (clientSecret.length < 20 || /\s/.test(clientSecret)) throw new ProviderError("permanent", "That doesn't look like a Xero client secret. Generate one on the custom connection's Configuration page.");
      const t = await customToken(clientId, clientSecret);
      const creds = { mode: "custom", client_id: clientId, client_secret: clientSecret, access_token: t.access_token };
      const org = await organisation(creds);
      return {
        credentials: creds,
        scopes: XERO_SCOPES.filter((s) => s !== "offline_access"),
        externalAccountId: org.OrganisationID,
        displayName: org.Name,
        tokenExpiresAt: t.expiresAt,
        settings: { authMode: "token" },
      };
    },
  },
  needsRefresh: (_c, expiresAt) => !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60_000,
  async refreshCredentials(creds) {
    if (creds.mode === "custom") {
      const t = await customToken(creds.client_id, creds.client_secret);
      return { credentials: { ...creds, access_token: t.access_token }, expiresAt: t.expiresAt };
    }
    const t = await token({ grant_type: "refresh_token", refresh_token: creds.refresh_token }, appAuth());
    // Refresh tokens rotate: the new one replaces the old (the old one stops working after a grace period).
    return { credentials: { ...creds, access_token: t.access_token, refresh_token: t.refresh_token ?? creds.refresh_token }, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  },
  async discoverAssets(creds) {
    if (creds.mode === "custom") {
      const org = await organisation(creds);
      return [orgAsset(org, org.OrganisationID)];
    }
    const out: AssetInfo[] = [];
    for (const t of await listTenants(creds)) out.push(orgAsset(await organisation(creds, t.tenantId), t.tenantId));
    return out;
  },
  sync: syncOrganisation,
  async healthCheck(ctx) {
    await organisation(await ctx.credentials(), ctx.asset.provider_asset_id);
  },
  async revoke(creds) {
    if (creds.mode === "custom") return; // the organisation disconnects its custom connection in Xero
    await providerFetch(X(REVOKE), { provider: PROVIDER, method: "POST", form: { token: creds.refresh_token }, headers: { Authorization: appAuth() }, retries: 0 });
  },
};

async function listTenants(creds: Credentials) {
  const { data } = await providerFetch(X(CONNECTIONS), { provider: PROVIDER, headers: { Authorization: `Bearer ${creds.access_token}` } });
  return ((data ?? []) as any[]).filter((t) => (t.tenantType ?? "ORGANISATION") === "ORGANISATION").map((t) => ({ tenantId: String(t.tenantId), tenantName: String(t.tenantName ?? "Xero organisation") }));
}
