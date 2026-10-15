import { ProviderError, providerFetch } from "../http.js";
import { basic, businessTimezone, overridable } from "../kit.js";
import { syncReport, type ReportRow } from "../report.js";
import type { ConnectorDefinition, Credentials, SyncContext } from "../types.js";

/**
 * QuickBooks Online (Intuit). OAuth 2.0: one-hour access tokens and refresh tokens that
 * ROTATE (every refresh may return a new refresh token, which must replace the old one —
 * the framework persists it under the per-connection refresh lock). The callback carries
 * the company id (`realmId`); one connection = one company = one asset.
 *
 * Data: the Profit and Loss report with one column per day (summarize_column_by=Days,
 * accrual basis), fetched in ≤ 31-day windows through the shared report sync. Section
 * summaries map to: Income → acct_revenue, COGS → acct_cost_of_sales, Expenses →
 * acct_operating_expenses, NetIncome → acct_net_profit (which includes other income and
 * other expenses). Amounts are in the company's home currency. Books are edited
 * retroactively, so 45 days are re-read on every sync and 120 on reconciliation.
 * QuickBooks doesn't report a company timezone; the business timezone is used.
 */

const Q = overridable("QUICKBOOKS_BASE_URL_OVERRIDE");
const SCOPE = "com.intuit.quickbooks.accounting";
const MINOR_VERSION = "75";
const PROVIDER = "QuickBooks";
const AUTHORIZE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
/** Connections made with the user's own Intuit app carry their environment; others follow the platform setting. */
const apiBase = (c: Credentials) => ((c.environment ?? process.env.QUICKBOOKS_ENVIRONMENT) === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com");
const API = (c: Credentials, realmId: string, path: string) => Q(`${apiBase(c)}/v3/company/${encodeURIComponent(realmId)}/${path}${path.includes("?") ? "&" : "?"}minorversion=${MINOR_VERSION}`);

const OWNED = ["acct_revenue", "acct_cost_of_sales", "acct_operating_expenses", "acct_net_profit"];
/** P&L section group → metric. */
const GROUPS: Record<string, string> = { Income: "acct_revenue", COGS: "acct_cost_of_sales", Expenses: "acct_operating_expenses", NetIncome: "acct_net_profit" };

/** The user's own Intuit app (token connections) or the platform's. */
const clientAuth = (c?: Credentials) => (c?.client_id ? basic(c.client_id, c.client_secret ?? "") : basic(process.env.QUICKBOOKS_CLIENT_ID ?? "", process.env.QUICKBOOKS_CLIENT_SECRET ?? ""));
const auth = (c: Credentials) => ({ Authorization: `Bearer ${c.access_token}` });

async function token(form: Record<string, string>, c?: Credentials) {
  const { data } = await providerFetch(Q(TOKEN), { provider: PROVIDER, method: "POST", form, headers: { Authorization: clientAuth(c) }, retries: 0 });
  return data as { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in?: number };
}

async function companyInfo(creds: Credentials, realmId: string) {
  const { data } = await providerFetch(API(creds, realmId, `companyinfo/${encodeURIComponent(realmId)}`), { provider: PROVIDER, headers: auth(creds) });
  return data?.CompanyInfo as { CompanyName?: string; LegalName?: string; Country?: string } | undefined;
}

async function homeCurrency(creds: Credentials, realmId: string): Promise<string | null> {
  const { data } = await providerFetch(API(creds, realmId, "preferences"), { provider: PROVIDER, headers: auth(creds) });
  const c = data?.Preferences?.CurrencyPrefs?.HomeCurrency?.value;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
}

// ------------------------------------------------------------------ P&L report parsing

const meta = (col: any, name: string) => (col?.MetaData ?? []).find((m: any) => m.Name === name)?.Value as string | undefined;
/** Report money cells: "" (no activity) is a real zero; "-12.50" is negative. */
const amount = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim() || "0");
  return Number.isFinite(n) ? n : 0;
};

/** Collect every section with a group (sections can be nested; we only need the top-level ones we map). */
function sections(rows: any[], out: Map<string, any> = new Map()) {
  for (const r of rows ?? []) {
    if (r?.group && !out.has(r.group)) out.set(r.group, r);
    if (r?.Rows?.Row) sections(r.Rows.Row, out);
  }
  return out;
}

/**
 * Parse a ProfitAndLoss report summarized by day into daily total rows. Every day column
 * gets all four metrics (missing sections are zero: no postings in that group).
 */
export function parseProfitAndLoss(report: any, from: string, to: string): ReportRow[] {
  const cols: any[] = report?.Columns?.Column ?? [];
  const noData = (report?.Header?.Option ?? []).some((o: any) => o.Name === "NoReportData" && String(o.Value) === "true");
  const days: { idx: number; date: string }[] = [];
  cols.forEach((c, idx) => {
    const start = meta(c, "StartDate");
    const end = meta(c, "EndDate");
    if (c.ColType === "Money" && start && start === (end ?? start) && /^\d{4}-\d{2}-\d{2}$/.test(start)) days.push({ idx, date: start });
  });
  if (!days.length && noData) {
    // No postings in the window at all: every day is a real zero.
    const out: ReportRow[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000)) {
      out.push({ date: d.toISOString().slice(0, 10), dimKey: "", dimValue: "", values: Object.fromEntries(OWNED.map((m) => [m, 0])) });
    }
    return out;
  }
  const found = sections(report?.Rows?.Row ?? []);
  return days.map(({ idx, date }) => {
    const values: Record<string, number> = Object.fromEntries(OWNED.map((m) => [m, 0]));
    for (const [group, metric] of Object.entries(GROUPS)) {
      const s = found.get(group);
      const cell = s?.Summary?.ColData?.[idx]?.value;
      values[metric] = Math.round(amount(cell) * 100) / 100;
    }
    return { date, dimKey: "", dimValue: "", values };
  });
}

async function fetchWindow(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]> {
  const creds = await ctx.credentials();
  const realmId = creds.realmId ?? ctx.asset.provider_asset_id;
  const q = new URLSearchParams({ start_date: from, end_date: to, summarize_column_by: "Days", accounting_method: "Accrual" });
  const { data } = await providerFetch(API(creds, realmId, `reports/ProfitAndLoss?${q}`), { provider: PROVIDER, headers: auth(creds), timeoutMs: 60_000 });
  const cur = data?.Header?.Currency;
  if (cur && ctx.asset.currency && cur !== ctx.asset.currency) {
    throw new ProviderError("permanent", `QuickBooks reported the P&L in ${cur}, but the company's home currency is ${ctx.asset.currency}. Reconnect to refresh the company settings.`);
  }
  return parseProfitAndLoss(data, from, to);
}

async function syncCompany(ctx: SyncContext) {
  if (!ctx.asset.timezone) {
    ctx.asset.timezone = await businessTimezone(ctx);
    await ctx.db.query(`UPDATE connection_assets SET timezone = $2 WHERE id = $1`, [ctx.asset.id, ctx.asset.timezone]);
  }
  return syncReport(ctx, {
    owned: OWNED,
    money: new Set(OWNED),
    initialDays: 365,
    lookbackDays: 45,
    reconcileDays: 120,
    lagDays: 0,
    windowDays: 31,
    zeroFillTotals: true,
    fetch: fetchWindow,
  });
}

// ------------------------------------------------------------------ definition

export const quickbooks: ConnectorDefinition = {
  id: "quickbooks",
  name: "QuickBooks Online",
  category: "Accounting",
  description: "Revenue, cost of sales, operating expenses and net profit per day from your QuickBooks Online books (accrual basis).",
  implemented: true,
  configKeys: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
  accessRequirements: [
    "An Intuit Developer app (QuickBooks Online Accounting API) with redirect URI <API_URL>/api/oauth/quickbooks/callback. Production keys require Intuit's app assessment questionnaire.",
  ],
  scopes: [{ scope: SCOPE, reason: "Read the Profit and Loss report, company name and home currency (read-only use)" }],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Updates as soon as entries are posted; past periods can change when books are edited",
  staleAfterHours: 30,
  syncIntervalMinutes: 360,
  reconcileDays: 120,
  docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/report-entities/profitandloss",
  tokenConnect: {
    fields: [
      { key: "clientId", label: "Client ID", placeholder: "AB…", help: "Your Intuit app → Keys and credentials." },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "refreshToken", label: "Refresh token", placeholder: "AB11…", secret: true, help: "From the Intuit OAuth 2.0 Playground (step 5)." },
      { key: "realmId", label: "Company ID (Realm ID)", placeholder: "9130 3456 7890 1234", help: "Shown in the Playground next to the tokens, or in QuickBooks under Settings → Account and settings → Billing & subscription." },
      { key: "environment", label: "Environment", placeholder: "production", optional: true, help: "Type “sandbox” for a sandbox company; leave empty for real books." },
    ],
    instructions: [
      "Sign in at developer.intuit.com with your QuickBooks user and create an app (Dashboard → Create an app → QuickBooks Online and Payments), with the com.intuit.quickbooks.accounting scope.",
      "Open the app → Keys and credentials. Use the Production keys for real books (Intuit asks a short compliance questionnaire first) or the Development keys for a sandbox company. Copy the client ID and secret.",
      "Under the keys' Redirect URIs make sure https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl is listed.",
      "Open the OAuth 2.0 Playground (developer.intuit.com/app/developer/playground), choose your app and the matching environment, tick com.intuit.quickbooks.accounting and click Get authorization code.",
      "Sign in, choose the company to connect and approve. Back in the Playground click Get tokens, then copy the Refresh token and the Realm ID.",
      "Paste the client ID, secret, refresh token and Realm ID here. We exchange the refresh token right away and keep it current (Intuit rotates it), so don't reuse it elsewhere.",
    ],
    async connect(input) {
      const realmId = (input.realmId ?? "").replace(/\s+/g, "");
      const client_id = (input.clientId ?? "").trim();
      const client_secret = (input.clientSecret ?? "").trim();
      const refresh = (input.refreshToken ?? "").trim();
      const environment = (input.environment ?? "").trim().toLowerCase() === "sandbox" ? "sandbox" : "production";
      if (!/^\d{6,25}$/.test(realmId)) throw new ProviderError("permanent", "The Company ID (Realm ID) is a long number, e.g. 9130345678901234.");
      if (client_id.length < 10 || !client_secret || refresh.length < 10) throw new ProviderError("permanent", "Enter the client ID, client secret and refresh token from your Intuit app and the OAuth Playground.");
      const base = { client_id, client_secret, realmId, environment };
      let t: Awaited<ReturnType<typeof token>>;
      try {
        t = await token({ grant_type: "refresh_token", refresh_token: refresh }, base);
      } catch (e) {
        if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) throw new ProviderError("permanent", "Intuit rejected the client ID, secret or refresh token. Check they come from the same app and environment, and get a fresh refresh token from the Playground.", e.status, undefined, e.detail);
        throw e;
      }
      const creds = { ...base, access_token: t.access_token, refresh_token: t.refresh_token ?? refresh };
      let info: Awaited<ReturnType<typeof companyInfo>>;
      try {
        info = await companyInfo(creds, realmId);
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === "scope" || e.kind === "not_found" || e.kind === "auth")) throw new ProviderError("permanent", `The token can't open company ${realmId}. Check the Realm ID and that the environment (${environment}) matches the keys you used.`, e.status, undefined, e.detail);
        throw e;
      }
      return {
        credentials: creds,
        scopes: [SCOPE],
        externalAccountId: realmId,
        displayName: info?.CompanyName || info?.LegalName || `QuickBooks company ${realmId}`,
        tokenExpiresAt: new Date(Date.now() + t.expires_in * 1000),
        settings: { authMode: "token" },
      };
    },
  },
  authorizeUrl({ state, redirectUri }) {
    const q = new URLSearchParams({ client_id: process.env.QUICKBOOKS_CLIENT_ID!, response_type: "code", scope: SCOPE, redirect_uri: redirectUri, state });
    return `${Q(AUTHORIZE)}?${q}`;
  },
  async handleCallback({ query, redirectUri }) {
    if (!query.code) throw new ProviderError("permanent", "QuickBooks didn't return an authorization code.");
    const realmId = String(query.realmId ?? "");
    if (!/^\d+$/.test(realmId)) throw new ProviderError("permanent", "QuickBooks didn't say which company was authorized. Please try again and pick a company.");
    const t = await token({ grant_type: "authorization_code", code: query.code, redirect_uri: redirectUri });
    const creds = { access_token: t.access_token, refresh_token: t.refresh_token, realmId };
    const info = await companyInfo(creds, realmId);
    return {
      credentials: creds,
      scopes: [SCOPE],
      externalAccountId: realmId,
      displayName: info?.CompanyName || info?.LegalName || `QuickBooks company ${realmId}`,
      tokenExpiresAt: new Date(Date.now() + t.expires_in * 1000),
    };
  },
  needsRefresh: (_c, expiresAt) => !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60_000,
  async refreshCredentials(creds) {
    try {
      const t = await token({ grant_type: "refresh_token", refresh_token: creds.refresh_token }, creds);
      // Rotation: always keep the refresh token Intuit returns now.
      return { credentials: { ...creds, access_token: t.access_token, refresh_token: t.refresh_token ?? creds.refresh_token }, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 400) throw new ProviderError("auth", "QuickBooks access expired or was revoked. Reconnect the company.", 400, undefined, e.detail);
      throw e;
    }
  },
  async discoverAssets(creds) {
    const realmId = String(creds.realmId);
    const [info, currency] = await Promise.all([companyInfo(creds, realmId), homeCurrency(creds, realmId)]);
    return [{ providerAssetId: realmId, name: info?.CompanyName || info?.LegalName || `QuickBooks company ${realmId}`, kind: "company", currency, timezone: null, metadata: { country: info?.Country ?? null } }];
  },
  sync: syncCompany,
  async healthCheck(ctx) {
    const creds = await ctx.credentials();
    await companyInfo(creds, creds.realmId ?? ctx.asset.provider_asset_id);
  },
  async revoke(creds) {
    if (creds.client_id) return; // the user's own app: they manage its tokens
    await providerFetch(Q(REVOKE), { provider: PROVIDER, method: "POST", json: { token: creds.refresh_token ?? creds.access_token }, headers: { Authorization: clientAuth() }, retries: 0 });
  },
};
