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
const apiBase = () => (process.env.QUICKBOOKS_ENVIRONMENT === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com");
const API = (realmId: string, path: string) => Q(`${apiBase()}/v3/company/${encodeURIComponent(realmId)}/${path}${path.includes("?") ? "&" : "?"}minorversion=${MINOR_VERSION}`);

const OWNED = ["acct_revenue", "acct_cost_of_sales", "acct_operating_expenses", "acct_net_profit"];
/** P&L section group → metric. */
const GROUPS: Record<string, string> = { Income: "acct_revenue", COGS: "acct_cost_of_sales", Expenses: "acct_operating_expenses", NetIncome: "acct_net_profit" };

const clientAuth = () => basic(process.env.QUICKBOOKS_CLIENT_ID ?? "", process.env.QUICKBOOKS_CLIENT_SECRET ?? "");
const auth = (c: Credentials) => ({ Authorization: `Bearer ${c.access_token}` });

async function token(form: Record<string, string>) {
  const { data } = await providerFetch(Q(TOKEN), { provider: PROVIDER, method: "POST", form, headers: { Authorization: clientAuth() }, retries: 0 });
  return data as { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in?: number };
}

async function companyInfo(creds: Credentials, realmId: string) {
  const { data } = await providerFetch(API(realmId, `companyinfo/${encodeURIComponent(realmId)}`), { provider: PROVIDER, headers: auth(creds) });
  return data?.CompanyInfo as { CompanyName?: string; LegalName?: string; Country?: string } | undefined;
}

async function homeCurrency(creds: Credentials, realmId: string): Promise<string | null> {
  const { data } = await providerFetch(API(realmId, "preferences"), { provider: PROVIDER, headers: auth(creds) });
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
  const { data } = await providerFetch(API(realmId, `reports/ProfitAndLoss?${q}`), { provider: PROVIDER, headers: auth(creds), timeoutMs: 60_000 });
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
      const t = await token({ grant_type: "refresh_token", refresh_token: creds.refresh_token });
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
    await providerFetch(Q(REVOKE), { provider: PROVIDER, method: "POST", json: { token: creds.refresh_token ?? creds.access_token }, headers: { Authorization: clientAuth() }, retries: 0 });
  },
};
