import { addDays, todayIn } from "@bca/shared";
import { startMock } from "./kit.js";

/**
 * Local stand-ins for QuickBooks Online (OAuth + P&L report by day), Xero (OAuth, custom
 * connections, organisations, journals) and Google Sheets (published CSV links, OAuth +
 * values API). Data is generated deterministically relative to "today".
 */

export const BOOKS_TZ = "America/New_York";
const basicOf = (h: string | undefined) => {
  const m = /^Basic (.+)$/.exec(h ?? "");
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : null;
};
/** Deterministic pseudo-random in [0, 1). */
const rnd = (seed: number) => {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
};
const money = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ QuickBooks

export const QB = { clientId: "qb-test-client", clientSecret: "qb-test-secret", realmId: "9130350000000001" };

export interface QbDay {
  sales: number;
  services: number;
  cogs: number;
  rent: number;
  wages: number;
  otherIncome: number;
  otherExpense: number;
}
export const qbTotals = (d: QbDay) => {
  const income = money(d.sales + d.services);
  const expenses = money(d.rent + d.wages);
  return { income, cogs: d.cogs, expenses, net: money(income - d.cogs - expenses + d.otherIncome - d.otherExpense) };
};

function qbGenerate(today: string) {
  const days = new Map<string, QbDay>();
  for (let i = 0; i < 400; i++) {
    const date = addDays(today, -i);
    if (i % 7 === 3) continue; // no postings: blank cells → zero
    const r = (k: number) => rnd(i * 13 + k);
    const d: QbDay = {
      sales: money(200 + r(1) * 900),
      services: i % 3 === 0 ? money(r(2) * 300) : 0,
      cogs: money(60 + r(3) * 250),
      rent: i % 30 === 1 ? 1500 : 0,
      wages: i % 14 === 5 ? money(2000 + r(4) * 500) : 0,
      otherIncome: i % 10 === 2 ? money(r(5) * 40) : 0,
      otherExpense: i % 9 === 4 ? money(r(6) * 25) : 0,
    };
    if (i % 11 === 6) d.sales = money(-150 - r(7) * 100); // refunds exceed sales: negative revenue
    days.set(date, d);
  }
  return days;
}

function qbReport(days: Map<string, QbDay>, from: string, to: string) {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const cell = (n: number) => ({ value: n === 0 ? "" : n.toFixed(2) });
  const get = (d: string) => days.get(d) ?? { sales: 0, services: 0, cogs: 0, rent: 0, wages: 0, otherIncome: 0, otherExpense: 0 };
  const line = (label: string, f: (d: QbDay) => number, id: string) => ({
    type: "Data",
    ColData: [{ value: label, id }, ...dates.map((d) => cell(f(get(d)))), cell(dates.reduce((s, d) => s + f(get(d)), 0))],
  });
  const summary = (label: string, f: (d: QbDay) => number) => ({
    ColData: [{ value: label }, ...dates.map((d) => cell(money(f(get(d))))), cell(money(dates.reduce((s, d) => s + f(get(d)), 0)))],
  });
  const header = (label: string) => ({ ColData: [{ value: label }, ...dates.map(() => ({ value: "" })), { value: "" }] });
  const t = (d: QbDay) => qbTotals(d);
  return {
    Header: { Time: new Date().toISOString(), ReportName: "ProfitAndLoss", ReportBasis: "Accrual", StartPeriod: from, EndPeriod: to, SummarizeColumnsBy: "Days", Currency: "USD", Option: [{ Name: "AccountingStandard", Value: "GAAP" }, { Name: "NoReportData", Value: "false" }] },
    Columns: {
      Column: [
        { ColTitle: "", ColType: "Account", MetaData: [{ Name: "ColKey", Value: "account" }] },
        ...dates.map((d, i) => ({ ColTitle: d, ColType: "Money", MetaData: [{ Name: "StartDate", Value: d }, { Name: "EndDate", Value: d }, { Name: "ColKey", Value: String(i) }] })),
        { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
      ],
    },
    Rows: {
      Row: [
        { type: "Section", group: "Income", Header: header("Income"), Rows: { Row: [line("Sales", (d) => d.sales, "1"), line("Services", (d) => d.services, "2")] }, Summary: summary("Total Income", (d) => t(d).income) },
        { type: "Section", group: "COGS", Header: header("Cost of Goods Sold"), Rows: { Row: [line("Cost of Goods Sold", (d) => d.cogs, "80")] }, Summary: summary("Total Cost of Goods Sold", (d) => d.cogs) },
        { type: "Section", group: "GrossProfit", Summary: summary("Gross Profit", (d) => t(d).income - d.cogs) },
        {
          type: "Section", group: "Expenses", Header: header("Expenses"),
          Rows: { Row: [line("Rent", (d) => d.rent, "20"), { type: "Section", Header: header("Payroll Expenses"), Rows: { Row: [line("Wages", (d) => d.wages, "21")] }, Summary: summary("Total Payroll Expenses", (d) => d.wages) }] },
          Summary: summary("Total Expenses", (d) => t(d).expenses),
        },
        { type: "Section", group: "NetOperatingIncome", Summary: summary("Net Operating Income", (d) => t(d).income - d.cogs - t(d).expenses) },
        { type: "Section", group: "OtherIncome", Header: header("Other Income"), Rows: { Row: [line("Interest Earned", (d) => d.otherIncome, "30")] }, Summary: summary("Total Other Income", (d) => d.otherIncome) },
        { type: "Section", group: "OtherExpenses", Header: header("Other Expenses"), Rows: { Row: [line("Penalties", (d) => d.otherExpense, "31")] }, Summary: summary("Total Other Expenses", (d) => d.otherExpense) },
        { type: "Section", group: "NetOtherIncome", Summary: summary("Net Other Income", (d) => d.otherIncome - d.otherExpense) },
        { type: "Section", group: "NetIncome", Summary: summary("Net Income", (d) => t(d).net) },
      ],
    },
  };
}

// ------------------------------------------------------------------ Xero

export const XERO = {
  clientId: "xero-app-client",
  clientSecret: "xero-app-secret",
  customId: "0123456789ABCDEF0123456789ABCDEF",
  customSecret: ["cust", "omSecret", "0123456789abcdefXYZ"].join(""),
};

export interface XeroLine { AccountType: string; NetAmount: number }
export interface XeroJournal { JournalID: string; JournalNumber: number; JournalDate: string; CreatedDateUTC: string; date: string; JournalLines: XeroLine[] }
export interface XeroOrg { OrganisationID: string; Name: string; BaseCurrency: string; Timezone: string; CountryCode: string }

export const XERO_ORGS: Record<string, XeroOrg> = {
  "tenant-kiwi": { OrganisationID: "org-kiwi", Name: "Kiwi Traders Ltd", BaseCurrency: "NZD", Timezone: "NEWZEALANDSTANDARDTIME", CountryCode: "NZ" },
  "tenant-uk": { OrganisationID: "org-uk", Name: "Acme UK Ltd", BaseCurrency: "GBP", Timezone: "GMTSTANDARDTIME", CountryCode: "GB" },
  custom: { OrganisationID: "org-custom", Name: "Custom Co", BaseCurrency: "USD", Timezone: "EASTERNSTANDARDTIME", CountryCode: "US" },
};

const msDate = (d: string, hours = 0) => `/Date(${Date.parse(`${d}T00:00:00Z`) + hours * 3_600_000}+0000)/`;

export function xeroJournal(n: number, date: string, lines: XeroLine[], createdOn = date): XeroJournal {
  return { JournalID: `jr-${n}`, JournalNumber: n, JournalDate: msDate(date), CreatedDateUTC: msDate(createdOn, 3), date, JournalLines: lines };
}

function xeroGenerate(today: string, seed: number): XeroJournal[] {
  const out: XeroJournal[] = [];
  let n = 0;
  for (let i = 170; i >= 0; i--) {
    const date = addDays(today, -i);
    const r = (k: number) => rnd(seed * 1000 + i * 17 + k);
    const add = (lines: XeroLine[]) => out.push(xeroJournal(++n, date, lines));
    if (i % 6 === 2) continue; // quiet day
    const sale = money(100 + r(1) * 800);
    add([{ AccountType: "CURRENT", NetAmount: money(sale * 1.15) }, { AccountType: "REVENUE", NetAmount: -sale }, { AccountType: "CURRLIAB", NetAmount: -money(sale * 0.15) }]);
    if (i % 2 === 0) {
      const c = money(40 + r(2) * 200);
      add([{ AccountType: "DIRECTCOSTS", NetAmount: c }, { AccountType: "INVENTORY", NetAmount: -c }]);
    }
    if (i % 5 === 1) {
      const e = money(50 + r(3) * 300);
      add([{ AccountType: i % 10 === 1 ? "OVERHEADS" : "EXPENSE", NetAmount: e }, { AccountType: "CURRLIAB", NetAmount: -e }]);
    }
    if (i % 9 === 0) {
      const o = money(r(4) * 60);
      add([{ AccountType: "BANK", NetAmount: o }, { AccountType: "OTHERINCOME", NetAmount: -o }]);
    }
    if (i % 13 === 7) {
      const cn = money(30 + r(5) * 90); // credit note: debit to revenue
      add([{ AccountType: "SALES", NetAmount: cn }, { AccountType: "CURRENT", NetAmount: -cn }]);
    }
    if (i % 30 === 0) add([{ AccountType: "DEPRECIATN", NetAmount: 120 }, { AccountType: "FIXED", NetAmount: -120 }]);
    if (i % 4 === 3) add([{ AccountType: "BANK", NetAmount: 75 }, { AccountType: "CURRENT", NetAmount: -75 }]); // payment: balance sheet only
  }
  return out;
}

// ------------------------------------------------------------------ server

export interface BooksState {
  today: string;
  qb: { days: Map<string, QbDay>; access: Set<string>; refresh: Set<string>; calls: { token: number; refresh: number; reports: number; revoke: number }; windows: [string, string][] };
  xero: {
    journals: Record<string, XeroJournal[]>;
    access: Map<string, { mode: "oauth" | "custom" }>;
    refresh: Set<string>;
    calls: { journals: { org: string; offset: number; since: string | null }[]; refresh: number; custom: number; revoke: number };
    next429: number;
  };
  sheets: { published: Record<string, string>; values: Record<string, unknown[][]>; titles: Record<string, string>; access: Set<string> };
}

export async function startMockBooks() {
  const today = todayIn(BOOKS_TZ);
  const state: BooksState = {
    today,
    qb: { days: qbGenerate(today), access: new Set(), refresh: new Set(), calls: { token: 0, refresh: 0, reports: 0, revoke: 0 }, windows: [] },
    xero: {
      journals: { "tenant-kiwi": xeroGenerate(today, 1), "tenant-uk": xeroGenerate(today, 2), custom: xeroGenerate(today, 3) },
      access: new Map(),
      refresh: new Set(),
      calls: { journals: [], refresh: 0, custom: 0, revoke: 0 },
      next429: 0,
    },
    sheets: { published: {}, values: {}, titles: {}, access: new Set() },
  };
  let seq = 0;
  const tok = (p: string) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

  const mock = await startMock((app) => {
    // ---------------- QuickBooks
    app.post("/oauth.platform.intuit.com/oauth2/v1/tokens/bearer", (req, res) => {
      if (basicOf(req.get("authorization")) !== `${QB.clientId}:${QB.clientSecret}`) return res.status(401).json({ error: "invalid_client" });
      const issue = () => {
        const access = tok("qb-at");
        const refresh = tok("qb-rt");
        state.qb.access.add(access);
        state.qb.refresh.add(refresh);
        res.json({ token_type: "bearer", access_token: access, refresh_token: refresh, expires_in: 3600, x_refresh_token_expires_in: 8_726_400 });
      };
      if (req.body.grant_type === "authorization_code") {
        if (req.body.code !== "qb-good-code" || !req.body.redirect_uri) return res.status(400).json({ error: "invalid_grant" });
        state.qb.calls.token++;
        return issue();
      }
      if (req.body.grant_type === "refresh_token") {
        if (!state.qb.refresh.has(req.body.refresh_token)) return res.status(400).json({ error: "invalid_grant" });
        state.qb.refresh.delete(req.body.refresh_token); // rotation: the old refresh token is spent
        state.qb.calls.refresh++;
        return issue();
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    });
    app.post("/developer.api.intuit.com/v2/oauth2/tokens/revoke", (req, res) => {
      state.qb.calls.revoke++;
      state.qb.refresh.delete(req.body.token);
      res.status(200).json({});
    });
    const qbAuth = (req: any, res: any, next: any) => {
      const t = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
      if (!t || !state.qb.access.has(t)) return res.status(401).json({ fault: { error: [{ message: "AuthenticationFailed", code: "3200" }], type: "AUTHENTICATION" } });
      if (req.params.realm !== QB.realmId) return res.status(403).json({ fault: { type: "AUTHORIZATION" } });
      if (!req.query.minorversion) return res.status(400).json({ fault: { type: "ValidationFault" } });
      next();
    };
    app.get("/quickbooks.api.intuit.com/v3/company/:realm/companyinfo/:id", qbAuth, (_req, res) => {
      res.json({ CompanyInfo: { CompanyName: "Maple Bikes LLC", LegalName: "Maple Bikes LLC", Country: "US", Id: "1" }, time: new Date().toISOString() });
    });
    app.get("/quickbooks.api.intuit.com/v3/company/:realm/preferences", qbAuth, (_req, res) => {
      res.json({ Preferences: { CurrencyPrefs: { MultiCurrencyEnabled: false, HomeCurrency: { value: "USD" } } } });
    });
    app.get("/quickbooks.api.intuit.com/v3/company/:realm/reports/ProfitAndLoss", qbAuth, (req, res) => {
      const from = String(req.query.start_date);
      const to = String(req.query.end_date);
      if (req.query.summarize_column_by !== "Days" || req.query.accounting_method !== "Accrual") return res.status(400).json({ fault: { type: "ValidationFault" } });
      const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
      if (!(span >= 1 && span <= 31)) return res.status(400).json({ fault: { type: "ValidationFault", error: [{ message: "too many columns" }] } });
      state.qb.calls.reports++;
      state.qb.windows.push([from, to]);
      res.json(qbReport(state.qb.days, from, to));
    });

    // ---------------- Xero
    app.post("/identity.xero.com/connect/token", (req, res) => {
      const who = basicOf(req.get("authorization"));
      const issue = (mode: "oauth" | "custom", withRefresh: boolean) => {
        const access = tok("xero-at");
        state.xero.access.set(access, { mode });
        const body: any = { access_token: access, expires_in: 1800, token_type: "Bearer", scope: "offline_access accounting.settings.read accounting.journals.read" };
        if (withRefresh) {
          body.refresh_token = tok("xero-rt");
          state.xero.refresh.add(body.refresh_token);
        }
        res.json(body);
      };
      if (req.body.grant_type === "client_credentials") {
        if (who !== `${XERO.customId}:${XERO.customSecret}`) return res.status(400).json({ error: "invalid_client" });
        state.xero.calls.custom++;
        return issue("custom", false);
      }
      if (who !== `${XERO.clientId}:${XERO.clientSecret}`) return res.status(400).json({ error: "invalid_client" });
      if (req.body.grant_type === "authorization_code") {
        if (req.body.code !== "xero-good-code") return res.status(400).json({ error: "invalid_grant" });
        return issue("oauth", true);
      }
      if (req.body.grant_type === "refresh_token") {
        if (!state.xero.refresh.has(req.body.refresh_token)) return res.status(400).json({ error: "invalid_grant" });
        state.xero.refresh.delete(req.body.refresh_token);
        state.xero.calls.refresh++;
        return issue("oauth", true);
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    });
    app.post("/identity.xero.com/connect/revocation", (req, res) => {
      state.xero.calls.revoke++;
      state.xero.refresh.delete(req.body.token);
      res.status(200).end();
    });
    const xeroOrg = (req: any, res: any): string | null => {
      const t = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
      const a = t ? state.xero.access.get(t) : undefined;
      if (!a) {
        res.status(401).json({ Title: "Unauthorized", Status: 401 });
        return null;
      }
      if (a.mode === "custom") return "custom";
      const tenant = req.get("xero-tenant-id");
      if (!tenant || !XERO_ORGS[tenant] || tenant === "custom") {
        res.status(403).json({ Title: "Forbidden", Detail: "AuthenticationUnsuccessful" });
        return null;
      }
      return tenant;
    };
    app.get("/api.xero.com/connections", (req, res) => {
      const t = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
      if (!t || state.xero.access.get(t)?.mode !== "oauth") return res.status(401).json({});
      res.json(["tenant-kiwi", "tenant-uk"].map((id, i) => ({ id: `conn-${i}`, authEventId: "auth-1", tenantId: id, tenantType: "ORGANISATION", tenantName: XERO_ORGS[id]!.Name, createdDateUtc: "2026-01-01T00:00:00", updatedDateUtc: "2026-01-01T00:00:00" })));
    });
    app.get("/api.xero.com/api.xro/2.0/Organisation", (req, res) => {
      const org = xeroOrg(req, res);
      if (org) res.json({ Status: "OK", Organisations: [XERO_ORGS[org]] });
    });
    app.get("/api.xero.com/api.xro/2.0/Journals", (req, res) => {
      if (state.xero.next429 > 0) {
        state.xero.next429--;
        return res.status(429).set("Retry-After", "0").json({ Title: "Too Many Requests" });
      }
      const org = xeroOrg(req, res);
      if (!org) return;
      const offset = Number(req.query.offset ?? 0);
      const since = req.get("if-modified-since") ?? null;
      state.xero.calls.journals.push({ org, offset, since });
      const sinceMs = since ? Date.parse(since) : null;
      const created = (j: XeroJournal) => Number(/\((\d+)/.exec(j.CreatedDateUTC)![1]);
      const page = state.xero.journals[org]!
        .filter((j) => j.JournalNumber > offset && (sinceMs == null || created(j) >= sinceMs))
        .sort((a, b) => a.JournalNumber - b.JournalNumber)
        .slice(0, 100)
        .map(({ date: _d, ...j }) => j);
      res.json({ Status: "OK", Journals: page });
    });

    // ---------------- Google Sheets
    app.get("/docs.google.com/spreadsheets/d/e/:id/pub", (req, res) => {
      const text = state.sheets.published[req.params.id];
      if (text === undefined) return res.status(200).type("text/html").send("<!DOCTYPE html><html><body>Sign in</body></html>");
      if (req.query.output !== "csv") return res.status(400).send("bad output");
      res.type("text/csv").send(text);
    });
    app.post("/oauth2.googleapis.com/token", (req, res) => {
      if (req.body.code !== "sheets-good-code" && req.body.grant_type === "authorization_code") return res.status(400).json({ error: "invalid_grant" });
      const access = tok("ya29.sheets");
      state.sheets.access.add(access);
      res.json({ access_token: access, refresh_token: tok("1//sheets"), expires_in: 3599, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", token_type: "Bearer" });
    });
    const gAuth = (req: any, res: any, next: any) => {
      const t = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
      if (!t || !state.sheets.access.has(t)) return res.status(401).json({ error: { code: 401 } });
      if (!state.sheets.titles[req.params.id]) return res.status(404).json({ error: { code: 404 } });
      next();
    };
    app.get("/sheets.googleapis.com/v4/spreadsheets/:id", gAuth, (req, res) => {
      res.json({ properties: { title: state.sheets.titles[req.params.id] }, sheets: Object.keys(state.sheets.values).filter((k) => k.startsWith(`${req.params.id}!`)).map((k) => ({ properties: { title: k.split("!")[1] } })) });
    });
    app.get("/sheets.googleapis.com/v4/spreadsheets/:id/values/:range", gAuth, (req, res) => {
      if (req.query.valueRenderOption !== "UNFORMATTED_VALUE" || req.query.dateTimeRenderOption !== "SERIAL_NUMBER") return res.status(400).json({});
      const tab = String(req.params.range).replace(/^'|'$/g, "").replace(/''/g, "'");
      const values = state.sheets.values[`${req.params.id}!${tab}`];
      if (!values) return res.status(400).json({ error: { message: "Unable to parse range" } });
      res.json({ range: `${tab}!A1:Z${values.length}`, majorDimension: "ROWS", values });
    });
  });
  return { ...mock, state };
}
