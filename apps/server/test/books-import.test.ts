import { addDays, todayIn } from "@bca/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootApp, connection, metric } from "./kit.js";
import { signup, workspaceWithBusiness } from "./helpers.js";
import { BOOKS_TZ, QB, XERO, XERO_ORGS, qbTotals, startMockBooks, xeroJournal, type BooksState, type XeroJournal } from "./mock-books.js";
import { TableError, parseCsv, parseCsvTable, parseNumber, parseTable } from "../src/connectors/sheets/parse.js";

let app: any;
let pool: any;
let runAll: () => Promise<number>;
let mock: { url: string; state: BooksState; close: () => Promise<void> };

beforeAll(async () => {
  mock = await startMockBooks();
  Object.assign(process.env, {
    QUICKBOOKS_CLIENT_ID: QB.clientId,
    QUICKBOOKS_CLIENT_SECRET: QB.clientSecret,
    QUICKBOOKS_BASE_URL_OVERRIDE: mock.url,
    XERO_CLIENT_ID: XERO.clientId,
    XERO_CLIENT_SECRET: XERO.clientSecret,
    XERO_BASE_URL_OVERRIDE: mock.url,
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    GOOGLE_BASE_URL_OVERRIDE: mock.url,
    APP_URL: "http://app.test",
    API_URL: "https://api.example.test",
  });
  ({ app, pool, runAll } = await bootApp());
});
afterAll(async () => mock?.close());

const creds = async (connectionId: string) => {
  const { decryptJson } = await import("../src/lib/crypto.js");
  const r = await pool.query("SELECT credentials_enc FROM connections WHERE id = $1", [connectionId]);
  return decryptJson<Record<string, any>>(r.rows[0].credentials_enc);
};
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
const OPTS = { provider: "csv" as const, defaultCurrency: "USD" };

/** Start OAuth and complete the callback as the provider would; returns the new connection id or error. */
async function oauth(c: any, businessId: string, provider: string, input: Record<string, string>, extra: Record<string, string>) {
  const auth = await c.post(`/api/businesses/${businessId}/connections/${provider}/authorize`, { input });
  expect(auth.status).toBe(200);
  const url = new URL(auth.body.url);
  const cb = await c.get(`/api/oauth/${provider}/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, ...extra })}`);
  expect(cb.status).toBe(302);
  const loc = new URL(cb.headers.location);
  return { url, connectionId: loc.searchParams.get("connection"), error: loc.searchParams.get("oauth_error") };
}

// ====================================================================== parser

describe("table parser", () => {
  it("parses RFC 4180 CSV: BOM, CRLF, quotes, embedded delimiters and newlines", () => {
    const rows = parseCsv('﻿date,"Note, with comma",x\r\n2026-01-01,"say ""hi""\nthere",3\r\n');
    expect(rows).toEqual([["date", "Note, with comma", "x"], ["2026-01-01", 'say "hi"\nthere', "3"]]);
  });

  it("reads numbers with separators, symbols, parentheses and %; empty cells are not zero; unknown columns are ignored", () => {
    expect(parseNumber("$1,234.50")).toBe(1234.5);
    expect(parseNumber("(1,200)")).toBe(-1200);
    expect(parseNumber("EUR 12.5")).toBe(12.5);
    expect(parseNumber("12.5%")).toBe(12.5);
    expect(parseNumber("1.234,56", true)).toBe(1234.56);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNaN();
    const t = parseCsvTable("Date,Store net sales,AD_SPEND,Mood,visits\n2026-03-01,\"$1,000.25\",(5),happy,\n2026-03-02,,10,sad,4\n", OPTS);
    expect(t.metrics.map((m) => m.key)).toEqual(["store_net_sales", "ad_spend"]);
    expect(t.ignoredColumns).toEqual(["Mood", "visits"]);
    expect(t.rows).toEqual([
      { date: "2026-03-01", values: { store_net_sales: 1000.25, ad_spend: -5 }, currency: "USD" },
      { date: "2026-03-02", values: { ad_spend: 10 }, currency: "USD" }, // empty sales cell → no figure, not 0
    ]);
    expect(t).toMatchObject({ rowCount: 2, from: "2026-03-01", to: "2026-03-02" });
  });

  it("detects ; delimiters with decimal commas", () => {
    const t = parseCsvTable("date;store_net_sales;store_orders\n2026-03-01;1.234,50;3\n2026-03-02;99,9;1\n", OPTS);
    expect(t.rows.map((r) => r.values)).toEqual([{ store_net_sales: 1234.5, store_orders: 3 }, { store_net_sales: 99.9, store_orders: 1 }]);
  });

  it("accepts serial and slash dates, rejects ambiguous day/month order, last duplicate wins", () => {
    const serial = parseTable([["date", "store_orders"], [46082, 5], ["2026/03-02", "6"]], { provider: "google_sheets", defaultCurrency: "USD" });
    expect(serial.rows.map((r) => r.date)).toEqual(["2026-03-01", "2026-03-02"]);
    const dmy = parseCsvTable("date,store_orders\n25/03/2026,1\n03/04/2026,2\n", OPTS);
    expect(dmy.rows.map((r) => r.date)).toEqual(["2026-03-25", "2026-04-03"]);
    expect(() => parseCsvTable("date,store_orders\n03/04/2026,1\n05/06/2026,2\n", OPTS)).toThrow(/ambiguous/);
    const dup = parseCsvTable("date,store_orders\n2026-03-01,1\n2026-03-01,7\nnot a date,3\n", OPTS);
    expect(dup.rows).toEqual([{ date: "2026-03-01", values: { store_orders: 7 }, currency: null }]);
    expect(dup.warnings.join(" ")).toMatch(/more than once.*later row/);
    expect(dup.warnings.join(" ")).toMatch(/date is missing or not a valid date/);
  });

  it("keeps one currency for money figures and explains unusable files", () => {
    const t = parseCsvTable("date,currency,ad_spend,ad_clicks\n2026-03-01,USD,10,1\n2026-03-02,EUR,20,2\n", OPTS);
    expect(t.rows[1]).toEqual({ date: "2026-03-02", values: { ad_clicks: 2 }, currency: null });
    expect(t.warnings.join(" ")).toMatch(/another currency than USD/);
    const err = (text: string) => {
      try {
        parseCsvTable(text, OPTS);
      } catch (e) {
        expect(e).toBeInstanceOf(TableError);
        return (e as TableError).problems.join(" ");
      }
      throw new Error("expected an error");
    };
    expect(err("")).toMatch(/empty/);
    expect(err("day_of,store_orders\nx,1\n")).toMatch(/No "date" column/);
    expect(err("date,foo,bar\n2026-01-01,1,2\n")).toMatch(/No recognised metric columns.*"foo"/);
  });
});

// ====================================================================== QuickBooks

describe("QuickBooks Online", () => {
  let owner: any, businessId: string, connectionId: string;
  const expected = (from: string, to: string) => {
    const days = [...mock.state.qb.days].filter(([d]) => d >= from && d <= to).map(([, v]) => qbTotals(v));
    return { revenue: sum(days.map((d) => d.income)), cogs: sum(days.map((d) => d.cogs)), opex: sum(days.map((d) => d.expenses)), net: sum(days.map((d) => d.net)) };
  };

  it("authorizes with the accounting scope and needs the company (realmId) from the callback", async () => {
    owner = await signup(app, "QbOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Maple"));
    const missing = await oauth(owner, businessId, "quickbooks", {}, { code: "qb-good-code" });
    expect(missing.url.pathname).toBe("/appcenter.intuit.com/connect/oauth2");
    expect(missing.url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(missing.url.searchParams.get("response_type")).toBe("code");
    expect(missing.url.searchParams.get("redirect_uri")).toBe("https://api.example.test/api/oauth/quickbooks/callback");
    expect(missing.error).toMatch(/which company/);

    const r = await oauth(owner, businessId, "quickbooks", {}, { code: "qb-good-code", realmId: QB.realmId });
    expect(r.error).toBeNull();
    connectionId = r.connectionId!;
    const conn = await connection(owner, businessId, connectionId);
    expect(conn).toMatchObject({ accountName: "Maple Bikes LLC", externalAccountId: QB.realmId });
    expect(conn.assets[0]).toMatchObject({ name: "Maple Bikes LLC", currency: "USD" });
    expect(JSON.stringify(conn)).not.toMatch(/qb-at-|qb-rt-/);
    expect((await owner.put(`/api/businesses/${businessId}/connections/${connectionId}/assets`, { assetIds: [conn.assets[0].id] })).status).toBe(200);
  });

  it("imports the daily P&L (≤ 31-day windows) and reconciles with the books, incl. negative and blank days", async () => {
    await runAll();
    const conn = await connection(owner, businessId, connectionId);
    expect(conn.latestJob.status).toBe("succeeded");
    expect(conn.assets[0].timezone).toBe(BOOKS_TZ);
    expect(mock.state.qb.windows.every(([f, t]) => (Date.parse(t) - Date.parse(f)) / 86_400_000 < 31)).toBe(true);
    const today = todayIn(BOOKS_TZ);
    const from = conn.assets[0].coveredFrom as string;
    expect(from).toBe(addDays(today, -364));
    const e = expected(from, today);
    const q = (m: string) => metric(owner, businessId, { metric: m, dateRange: { from, to: today } });
    expect((await q("acct_revenue")).total).toBeCloseTo(e.revenue, 2);
    expect((await q("acct_cost_of_sales")).total).toBeCloseTo(e.cogs, 2);
    expect((await q("acct_operating_expenses")).total).toBeCloseTo(e.opex, 2);
    expect((await q("acct_net_profit")).total).toBeCloseTo(e.net, 2);
    expect((await q("acct_gross_profit")).total).toBeCloseTo(e.revenue - e.cogs, 2);

    const series = (await metric(owner, businessId, { metric: "acct_revenue", dateRange: { from: addDays(today, -30), to: today }, granularity: "day" })).series;
    for (const p of series) expect(p.value).toBeCloseTo(qbTotals(mock.state.qb.days.get(p.bucket) ?? ({ sales: 0, services: 0, cogs: 0, rent: 0, wages: 0, otherIncome: 0, otherExpense: 0 })).income, 2);
    expect(series.some((p: any) => p.value < 0)).toBe(true); // refund-heavy day
    expect(series.some((p: any) => p.value === 0)).toBe(true); // blank day is a real zero
    expect(series).toHaveLength(31);
  });

  it("re-reads 45 days on each sync and 120 days on reconciliation (books change retroactively)", async () => {
    const today = todayIn(BOOKS_TZ);
    const recent = addDays(today, -10);
    const old = addDays(today, -60);
    for (const d of [recent, old]) mock.state.qb.days.set(d, { ...(mock.state.qb.days.get(d) ?? { services: 0, cogs: 0, rent: 0, wages: 0, otherIncome: 0, otherExpense: 0, sales: 0 }), sales: 5000 });
    const day = async (d: string) => (await metric(owner, businessId, { metric: "acct_revenue", dateRange: { from: d, to: d } })).total;
    const windows = mock.state.qb.windows.length;
    expect((await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`)).status).toBe(202);
    await runAll();
    expect(mock.state.qb.windows.length - windows).toBe(2); // 46 days → two windows
    expect(await day(recent)).toBeCloseTo(qbTotals(mock.state.qb.days.get(recent)!).income, 2);
    expect(await day(old)).not.toBeCloseTo(qbTotals(mock.state.qb.days.get(old)!).income, 2);

    const { enqueue } = await import("../src/jobs/queue.js");
    const ws = (await pool.query("SELECT workspace_id FROM connections WHERE id = $1", [connectionId])).rows[0].workspace_id;
    await enqueue(pool, { type: "connection.sync", workspaceId: ws, businessId, connectionId, payload: { mode: "reconcile" }, dedupeKey: `sync:${connectionId}` });
    await runAll();
    expect(await day(old)).toBeCloseTo(qbTotals(mock.state.qb.days.get(old)!).income, 2);
    const e = expected(addDays(today, -364), today);
    expect((await metric(owner, businessId, { metric: "acct_net_profit", dateRange: { from: addDays(today, -364), to: today } })).total).toBeCloseTo(e.net, 2);
  });

  it("stores each rotated refresh token and revokes on disconnect", async () => {
    const refreshes = mock.state.qb.calls.refresh;
    for (let i = 0; i < 2; i++) {
      await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [connectionId]);
      await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
      await runAll();
      expect((await connection(owner, businessId, connectionId)).latestJob.status).toBe("succeeded");
    }
    expect(mock.state.qb.calls.refresh).toBe(refreshes + 2); // the second refresh only works with the rotated token
    const c = await creds(connectionId);
    expect(mock.state.qb.refresh.has(c.refresh_token)).toBe(true);
    expect(c.realmId).toBe(QB.realmId);
    const r = await owner.del(`/api/businesses/${businessId}/connections/${connectionId}`, { deleteData: true });
    expect(r.body.revoked).toBe(true);
    expect(mock.state.qb.calls.revoke).toBe(1);
  });
});

// ====================================================================== Xero

const xeroExpected = (journals: XeroJournal[], from: string, to: string) => {
  const lines = journals.filter((j) => j.date >= from && j.date <= to).flatMap((j) => j.JournalLines);
  const tot = (types: string[]) => sum(lines.filter((l) => types.includes(l.AccountType)).map((l) => l.NetAmount));
  const revenue = -tot(["REVENUE", "SALES"]);
  const other = -tot(["OTHERINCOME"]);
  const cogs = tot(["DIRECTCOSTS"]);
  const opex = tot(["EXPENSE", "OVERHEADS", "DEPRECIATN"]);
  return { revenue, other, cogs, opex, net: Math.round((revenue + other - cogs - opex) * 100) / 100 };
};

describe("Xero", () => {
  let owner: any, businessId: string, connectionId: string;

  it("validates custom connection credentials and rejects ones Xero refuses", async () => {
    owner = await signup(app, "XeroOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Custom Co"));
    const post = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/xero/token`, { input });
    const bad = await post({ clientId: "nope", clientSecret: XERO.customSecret });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/client ID/);
    const wrong = await post({ clientId: XERO.customId, clientSecret: ["wrong", "Secret", "0000000000000000"].join("") });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/rejected/);
    expect(JSON.stringify(wrong.body)).not.toContain("wrongSecret");
  });

  it("connects a custom connection, imports journals and aggregates them by account type", async () => {
    const r = await owner.post(`/api/businesses/${businessId}/connections/xero/token`, { input: { clientId: XERO.customId, clientSecret: XERO.customSecret } });
    expect(r.status).toBe(201);
    connectionId = r.body.connectionId;
    const conn = await connection(owner, businessId, connectionId);
    expect(conn).toMatchObject({ accountName: "Custom Co", authMode: "token" });
    expect(conn.assets[0]).toMatchObject({ name: "Custom Co", currency: "USD", timezone: "America/New_York" });
    mock.state.xero.next429 = 1; // rate limited once: retried after Retry-After
    await owner.put(`/api/businesses/${businessId}/connections/${connectionId}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    expect((await connection(owner, businessId, connectionId)).latestJob.status).toBe("succeeded");
    const calls = mock.state.xero.calls.journals.filter((c) => c.org === "custom");
    expect(calls.map((c) => c.offset)).toEqual([0, 100, 200, ...(calls.length > 3 ? calls.slice(3).map((c) => c.offset) : [])]);
    expect(calls[0]!.since).toBeTruthy();

    const today = todayIn("America/New_York");
    const from = addDays(today, -364);
    const e = xeroExpected(mock.state.xero.journals.custom!, from, today);
    expect(e.other).toBeGreaterThan(0);
    const q = async (m: string) => (await metric(owner, businessId, { metric: m, dateRange: { from, to: today } })).total;
    expect(await q("acct_revenue")).toBeCloseTo(e.revenue, 2); // credits flipped; credit notes reduce revenue; other income excluded
    expect(await q("acct_cost_of_sales")).toBeCloseTo(e.cogs, 2);
    expect(await q("acct_operating_expenses")).toBeCloseTo(e.opex, 2);
    expect(await q("acct_net_profit")).toBeCloseTo(e.net, 2); // includes other income
    expect(e.net).not.toBeCloseTo(e.revenue - e.cogs - e.opex, 2);
    const margin = (await metric(owner, businessId, { metric: "acct_net_margin", dateRange: { from, to: today } })).total;
    expect(margin).toBeCloseTo((e.net / e.revenue) * 100, 4);
  });

  it("incremental syncs continue from the last journal number and pick up backdated entries", async () => {
    const list = mock.state.xero.journals.custom!;
    const last = Math.max(...list.map((j) => j.JournalNumber));
    const today = todayIn("America/New_York");
    const back = addDays(today, -20);
    list.push(xeroJournal(last + 1, today, [{ AccountType: "REVENUE", NetAmount: -1000 }, { AccountType: "CURRENT", NetAmount: 1000 }], today));
    list.push(xeroJournal(last + 2, back, [{ AccountType: "OVERHEADS", NetAmount: 333.33 }, { AccountType: "CURRLIAB", NetAmount: -333.33 }], today));
    const before = mock.state.xero.calls.journals.length;
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    const calls = mock.state.xero.calls.journals.slice(before);
    expect(calls).toEqual([{ org: "custom", offset: last, since: null }]);
    const e = xeroExpected(list, back, back);
    expect((await metric(owner, businessId, { metric: "acct_operating_expenses", dateRange: { from: back, to: back } })).total).toBeCloseTo(e.opex, 2);
    expect((await metric(owner, businessId, { metric: "acct_revenue", dateRange: { from: today, to: today } })).total).toBeCloseTo(xeroExpected(list, today, today).revenue, 2);
    // Re-running with no new journals changes nothing.
    const snap = async () => (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
    const s1 = await snap();
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    expect(await snap()).toEqual(s1);
  });

  it("OAuth: requests read scopes, discovers every authorized organisation and syncs with the tenant header", async () => {
    const o = await signup(app, "XeroOauth");
    const { businessId: bid } = await workspaceWithBusiness(o, "Kiwi");
    const r = await oauth(o, bid, "xero", {}, { code: "xero-good-code" });
    expect(r.url.pathname).toBe("/login.xero.com/identity/connect/authorize");
    expect(r.url.searchParams.get("scope")).toBe("offline_access accounting.settings.read accounting.journals.read");
    expect(r.error).toBeNull();
    const conn = await connection(o, bid, r.connectionId!);
    expect(conn.assets.map((a: any) => [a.name, a.currency, a.timezone]).sort()).toEqual([
      ["Acme UK Ltd", "GBP", "Europe/London"],
      ["Kiwi Traders Ltd", "NZD", "Pacific/Auckland"],
    ]);
    const kiwi = conn.assets.find((a: any) => a.currency === "NZD");
    await o.put(`/api/businesses/${bid}/connections/${r.connectionId}/assets`, { assetIds: [kiwi.id] });
    await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [r.connectionId]);
    await runAll();
    expect((await connection(o, bid, r.connectionId!)).latestJob.status).toBe("succeeded");
    expect(mock.state.xero.calls.refresh).toBe(1);
    expect(mock.state.xero.refresh.has((await creds(r.connectionId!)).refresh_token)).toBe(true);
    const today = todayIn("Pacific/Auckland");
    const from = addDays(today, -364);
    const e = xeroExpected(mock.state.xero.journals["tenant-kiwi"]!, from, today);
    const res = await metric(o, bid, { metric: "acct_revenue", dateRange: { from, to: today } });
    expect(res.total).toBeCloseTo(e.revenue, 2);
    const ccy = await pool.query("SELECT DISTINCT currency FROM metric_facts WHERE connection_id = $1", [r.connectionId]);
    expect(ccy.rows.map((x: any) => x.currency)).toEqual([XERO_ORGS["tenant-kiwi"]!.BaseCurrency]);
  });
});

// ====================================================================== CSV upload

describe("CSV upload", () => {
  let owner: any, businessId: string, workspaceId: string, connectionId: string;
  const today = todayIn(BOOKS_TZ);
  const d = (n: number) => addDays(today, -n);
  const upload = (c: any, body: Record<string, unknown>) => c.post(`/api/businesses/${businessId}/imports/csv`, body);

  it("lists importable columns and serves a template", async () => {
    owner = await signup(app, "CsvOwner");
    ({ businessId, workspaceId } = await workspaceWithBusiness(owner, "Corner Shop"));
    const cols = await owner.get(`/api/businesses/${businessId}/imports/columns`);
    expect(cols.status).toBe(200);
    expect(cols.body.find((c: any) => c.key === "store_net_sales")).toMatchObject({ label: "Store net sales", unit: "currency", aggregation: "sum", category: "sales" });
    expect(cols.body.some((c: any) => c.key === "sessions")).toBe(false); // not importable by CSV
    const t = await owner.get(`/api/businesses/${businessId}/imports/csv/template`);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toMatch(/text\/csv/);
    expect(t.headers["content-disposition"]).toMatch(/attachment/);
    const parsed = parseCsvTable(t.text, OPTS);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.ignoredColumns).toEqual([]);
  });

  it("imports an upload; the CSV is used as the only source of store sales", async () => {
    const content = ["date,store_net_sales,store_orders,ad_spend,notes", `${d(3)},"1,000.50",10,50,a`, `${d(2)},200,,25,b`, `${d(1)},300.25,5,,c`].join("\n");
    const r = await upload(owner, { fileName: "march.csv", content });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ rows: 3, from: d(3), to: d(1), ignoredColumns: ["notes"] });
    expect(r.body.metrics.map((m: any) => m.key)).toEqual(["store_net_sales", "store_orders", "ad_spend"]);
    connectionId = r.body.connectionId;
    await runAll();
    const conn = await connection(owner, businessId, connectionId);
    expect(conn).toMatchObject({ provider: "csv", accountName: "march.csv", status: "active" });
    expect(conn.assets[0]).toMatchObject({ name: "march.csv", currency: "USD", coveredFrom: d(3) });
    const sales = await metric(owner, businessId, { metric: "store_net_sales", dateRange: { from: d(3), to: d(1) } });
    expect(sales.total).toBeCloseTo(1500.75, 2);
    expect(sales.availability).toBe("available");
    expect(sales.sources.map((s: any) => s.provider)).toEqual(["csv"]);
    expect((await metric(owner, businessId, { metric: "store_orders", dateRange: { from: d(10), to: today } })).total).toBe(15);
    // Empty cells are missing data: store_orders has no fact for that day.
    const facts = await pool.query("SELECT date::text AS d FROM metric_facts WHERE connection_id = $1 AND metric_key = 'store_orders' ORDER BY date", [connectionId]);
    expect(facts.rows.map((x: any) => x.d)).toEqual([d(3), d(1)]);
  });

  it("re-uploading into the connection replaces all of its previous figures", async () => {
    const content = ["date,store_net_sales", `${d(2)},999`, `${d(5)},1`].join("\n");
    const r = await upload(owner, { fileName: "march-v2.csv", content, connectionId });
    expect(r.status).toBe(201);
    expect(r.body.connectionId).toBe(connectionId);
    await runAll();
    expect((await metric(owner, businessId, { metric: "store_net_sales", dateRange: { from: d(10), to: today } })).total).toBe(1000);
    const left = await pool.query("SELECT metric_key, date::text AS d FROM metric_facts WHERE connection_id = $1 ORDER BY date", [connectionId]);
    expect(left.rows).toEqual([{ metric_key: "store_net_sales", d: d(5) }, { metric_key: "store_net_sales", d: d(2) }]);
    expect((await connection(owner, businessId, connectionId)).accountName).toBe("march-v2.csv");
  });

  it("rejects invalid, oversized and unauthorized uploads, and respects the plan's connection limit", async () => {
    const bad = await upload(owner, { fileName: "x.csv", content: "when,what\n1,2\n" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/No "date" column/);
    const ambiguous = await upload(owner, { fileName: "x.csv", content: "date,store_orders\n03/04/2026,1\n" });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.message).toMatch(/ambiguous/);
    const big = await upload(owner, { fileName: "big.csv", content: `date,store_orders\n${"2026-01-01,1\n".repeat(Math.ceil((5 * 1024 * 1024) / 13) + 10)}` });
    expect(big.status).toBe(400);
    expect(big.body.error.message).toMatch(/5 MB/);

    const viewer = await signup(app, "CsvViewer");
    const inv = await owner.post(`/api/workspaces/${workspaceId}/invitations`, { email: viewer.email, role: "member", businessGrants: [{ businessId, role: "viewer" }] });
    expect((await viewer.post(`/api/invites/${inv.body.inviteUrl.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await viewer.get(`/api/businesses/${businessId}/imports/columns`)).status).toBe(200);
    const denied = await upload(viewer, { fileName: "v.csv", content: `date,store_orders\n${d(1)},1\n` });
    expect(denied.status).toBe(403);

    // Free plan: 2 connections. One exists; a second upload is allowed, a third isn't.
    await pool.query("DELETE FROM workspace_subscriptions WHERE workspace_id = $1", [workspaceId]);
    expect((await upload(owner, { fileName: "second.csv", content: `date,email_sends\n${d(1)},100\n` })).status).toBe(201);
    const third = await upload(owner, { fileName: "third.csv", content: `date,email_sends\n${d(1)},100\n` });
    expect(third.status).toBe(402);
    await runAll();
  });
});

// ====================================================================== Google Sheets

describe("Google Sheets", () => {
  const PUB = "2PACX-1vTestPublishedSheetId_abcdefghij";
  const today = todayIn(BOOKS_TZ);
  const d = (n: number) => addDays(today, -n);
  let owner: any, businessId: string;

  it("validates published links and connects one, importing its figures", async () => {
    owner = await signup(app, "SheetsOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Sheet Co"));
    const post = (url: string) => owner.post(`/api/businesses/${businessId}/connections/google_sheets/token`, { input: { url } });
    expect((await post("https://example.com/x.csv")).body.error.message).toMatch(/published Google Sheets link/);
    expect((await post("https://docs.google.com/spreadsheets/d/1AbcdefghijklmnopqrstuvwxyZ/edit#gid=0")).body.error.message).toMatch(/editing link/);
    const unpublished = await post("https://docs.google.com/spreadsheets/d/e/2PACX-1vNotPublishedAtAll_xxxxxxxx/pub?output=csv");
    expect(unpublished.status).toBe(400);
    expect(unpublished.body.error.message).toMatch(/web page instead of CSV/);

    mock.state.sheets.published[PUB] = ["Date,Revenue (books),Operating expenses,Comment", `${d(2)},"$2,000.00",500,ok`, `${d(1)},1500,(100),refund`].join("\r\n");
    const r = await post(`https://docs.google.com/spreadsheets/d/e/${PUB}/pub?gid=0&single=true&output=csv`);
    expect(r.status).toBe(201);
    const conn = await connection(owner, businessId, r.body.connectionId);
    expect(conn).toMatchObject({ authMode: "token", accountName: "Published Google Sheet" });
    await owner.put(`/api/businesses/${businessId}/connections/${r.body.connectionId}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    expect((await connection(owner, businessId, r.body.connectionId)).latestJob.status).toBe("succeeded");
    const q = (m: string) => metric(owner, businessId, { metric: m, dateRange: { from: d(10), to: today } });
    expect((await q("acct_revenue")).total).toBe(3500);
    expect((await q("acct_operating_expenses")).total).toBe(400);
    expect((await q("acct_revenue")).sources[0].provider).toBe("google_sheets");

    // Each sync re-reads the sheet and replaces its figures.
    mock.state.sheets.published[PUB] = ["date,acct_revenue", `${d(1)},10`].join("\n");
    await owner.post(`/api/businesses/${businessId}/connections/${r.body.connectionId}/sync`);
    await runAll();
    expect((await q("acct_revenue")).total).toBe(10);
    expect((await q("acct_operating_expenses")).availability).toBe("unavailable");
  });

  it("OAuth: reads a private sheet's tab through the Sheets API with serial dates", async () => {
    const o = await signup(app, "SheetsOauth");
    const { businessId: bid } = await workspaceWithBusiness(o, "Private Sheet Co");
    const ID = "1PrivateSpreadsheetIdAbcdefghijklmnop";
    const serial = (date: string) => (Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
    mock.state.sheets.titles[ID] = "Weekly KPIs";
    mock.state.sheets.values[`${ID}!Figures`] = [["date", "email_sends", "support_tickets_created"], [serial(d(2)), 1200, 4], [serial(d(1)), 800, ""]];
    mock.state.sheets.values[`${ID}!Other`] = [["nothing"]];
    const bad = await o.post(`/api/businesses/${bid}/connections/google_sheets/authorize`, { input: { spreadsheetUrl: "not a link" } });
    expect(bad.status).toBe(400);
    const r = await oauth(o, bid, "google_sheets", { spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, tab: "figures" }, { code: "sheets-good-code", scope: "https://www.googleapis.com/auth/spreadsheets.readonly" });
    expect(r.url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/spreadsheets.readonly");
    expect(r.error).toBeNull();
    const conn = await connection(o, bid, r.connectionId!);
    expect(conn.assets[0].name).toBe("Weekly KPIs · Figures");
    await o.put(`/api/businesses/${bid}/connections/${r.connectionId}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    expect((await metric(o, bid, { metric: "email_sends", dateRange: { from: d(10), to: today } })).total).toBe(2000);
    expect((await metric(o, bid, { metric: "support_tickets_created", dateRange: { from: d(10), to: today } })).total).toBe(4);
  });
});
