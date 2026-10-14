import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, workspaceWithBusiness } from "./helpers.js";
import { bootApp, connectWithToken, connection, fakeToken, localDay, metric } from "./kit.js";
import { STRIPE_TZ, WOO_HOST, WOO_TZ, makeStripeJpy, makeStripeUsd, startMockStripe, startMockWoo, wallTime, wooExpected, type StripeAccount, type WooState } from "./mock-commerce.js";
import { startMockShopify, type MockState as ShopifyState } from "./mock-shopify.js";

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const STRIPE_USD = fakeToken("rk", "_test_", "Usd0123456789abcdef");
const STRIPE_JPY = fakeToken("rk", "_test_", "Jpy0123456789abcdef");
const SHOP_TOKEN = fakeToken("shp", "at_", "0123456789abcdef0123");

let app: any;
let runAll: () => Promise<number>;
let woo: { url: string; state: WooState; close: () => Promise<void> };
let stripe: { url: string; state: { accounts: Map<string, StripeAccount>; versions: Set<string> }; close: () => Promise<void> };
let shopify: { url: string; state: ShopifyState; close: () => Promise<void> };

beforeAll(async () => {
  woo = await startMockWoo();
  stripe = await startMockStripe({ [STRIPE_USD]: makeStripeUsd(), [STRIPE_JPY]: makeStripeJpy() });
  shopify = await startMockShopify();
  process.env.WOOCOMMERCE_BASE_URL_OVERRIDE = woo.url;
  process.env.STRIPE_DATA_BASE_URL_OVERRIDE = stripe.url;
  process.env.SHOPIFY_BASE_URL_OVERRIDE = shopify.url;
  ({ app, runAll } = await bootApp());
});
afterAll(async () => { await woo?.close(); await stripe?.close(); await shopify?.close(); });

const wooInput = (over: Record<string, string> = {}) => ({ url: `https://${WOO_HOST}`, consumerKey: woo.state.key, consumerSecret: woo.state.secret, ...over });
const notesOf = (conn: any): string[] => (conn.latestJob?.result?.results ?? []).flatMap((r: any) => r.notes ?? []);

// ================================================================== WooCommerce

describe("WooCommerce connector", () => {
  let owner: any, businessId: string, connectionId: string;
  const today = () => localDay(new Date(), WOO_TZ);

  it("validates the store URL and keys, and reports a rejected key", async () => {
    owner = await signup(app, "Woo");
    ({ businessId } = await workspaceWithBusiness(owner, "Bean & Brew"));
    const connect = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/woocommerce/token`, { input });
    expect((await connect(wooInput({ url: "http://shop.example.com" }))).body.error.message).toMatch(/HTTPS/);
    expect((await connect(wooInput({ url: "https://localhost/" }))).body.error.message).toMatch(/public address/);
    expect((await connect(wooInput({ consumerKey: "abc" }))).body.error.message).toMatch(/ck_/);
    const rejected = await connect(wooInput({ consumerSecret: ["cs", "0000000000000000000000000000000000000000"].join("_") }));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/rejected the token/);
  });

  it("connects, discovers the store and imports orders that reconcile with the source", async () => {
    const { id, conn } = await connectWithToken(owner, businessId, "woocommerce", wooInput({ url: `${WOO_HOST}/wp-admin/` }), runAll);
    connectionId = id;
    expect(conn).toMatchObject({ provider: "woocommerce", status: "active", accountName: "Bean & Brew", authMode: "token" });
    expect(conn.assets[0]).toMatchObject({ currency: "USD", timezone: WOO_TZ, selected: true });
    expect(JSON.stringify(conn)).not.toContain(woo.state.secret);
    expect(woo.state.calls.orders[0]).toMatch(/after=/);

    const to = today();
    const from = addDays(to, -45);
    const exp = wooExpected(woo.state, from, to);
    expect(woo.state.orders.some((o) => o.status === "cancelled" && o.date_created.slice(0, 10) >= from)).toBe(true);
    expect(exp.refunds).toBeGreaterThan(20); // line refunds + the amount-only refund
    expect(woo.state.orders.length).toBeGreaterThan(100); // the import spans more than one page of 100
    expect(exp.orders).toBeGreaterThan(50);
    expect(exp.net).toBeLessThan(exp.gross);
    const q = (m: string) => metric(owner, businessId, { metric: m, dateRange: { from, to } });
    const net = await q("store_net_sales");
    expect(net.availability).toBe("available");
    expect(net.total).toBeCloseTo(exp.net, 2);
    expect((await q("store_gross_sales")).total).toBeCloseTo(exp.gross, 2);
    expect((await q("store_refunds")).total).toBeCloseTo(exp.refunds, 2);
    expect((await q("store_orders")).total).toBe(exp.orders);
    expect((await q("store_units")).total).toBe(exp.units);
    // Product breakdown (variations roll up to the parent product).
    const byProduct = await metric(owner, businessId, { metric: "store_gross_sales", dateRange: { from, to }, dimension: "product" });
    for (const [name, v] of exp.byProduct) expect(byProduct.rows.find((r: any) => r.label === name)?.value).toBeCloseTo(v, 2);
    expect(byProduct.rows.some((r: any) => r.label === "Hoodie")).toBe(true);
    // Country names (not codes) so they line up with Shopify's.
    const byCountry = await metric(owner, businessId, { metric: "store_orders", dateRange: { from, to }, dimension: "country" });
    expect(byCountry.rows.map((r: any) => r.label)).toContain("United States");
    // The EUR order is left out of money metrics, with a note.
    expect(notesOf(conn).join(" ")).toMatch(/EUR/);
  });

  it("incremental sync picks up a moved order and a new refund", async () => {
    const now = new Date();
    const stamp = (o: any) => { o.date_modified = wallTime(now, WOO_TZ); o.date_modified_gmt = now.toISOString().slice(0, 19); };
    const paid = woo.state.orders.filter((o) => o.status === "completed" && o.currency === "USD" && !o.refunds.length);
    // Move one order to another day (e.g. a corrected import date).
    const moved = paid[3]!;
    const newDay = addDays(moved.date_created.slice(0, 10), -1);
    moved.date_created = `${newDay}${moved.date_created.slice(10)}`;
    stamp(moved);
    // Refund a line on another order.
    const refunded = paid[10]!;
    const line = refunded.line_items[0];
    refunded.refunds = [{ id: 7777, total: (-Number(line.total)).toFixed(2) }];
    woo.state.refunds.set(refunded.id, [{ id: 7777, amount: line.total, line_items: [{ id: 99999, product_id: line.product_id, variation_id: line.variation_id, quantity: -line.quantity, total: (-Number(line.total)).toFixed(2), meta_data: [{ key: "_refunded_item_id", value: String(line.id) }] }] }]);
    stamp(refunded);

    expect((await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`)).status).toBeLessThan(300);
    await runAll();
    expect(woo.state.calls.orders.at(-1)).toMatch(/modified_after=/);
    const to = today();
    const from = addDays(to, -45);
    const exp = wooExpected(woo.state, from, to);
    const q = (m: string, r = { from, to }) => metric(owner, businessId, { metric: m, dateRange: r });
    expect((await q("store_net_sales")).total).toBeCloseTo(exp.net, 2);
    expect((await q("store_refunds")).total).toBeCloseTo(exp.refunds, 2);
    expect((await q("store_units")).total).toBe(exp.units);
    const day = { from: newDay, to: newDay };
    expect((await q("store_orders", day)).total).toBe(wooExpected(woo.state, newDay, newDay).orders);
  });

  it("records a stock snapshot for today", async () => {
    const d = { from: today(), to: today() };
    expect((await metric(owner, businessId, { metric: "inv_units_on_hand", dateRange: d })).total).toBe(55); // 40+2+0+10+3+max(-1,0)
    expect((await metric(owner, businessId, { metric: "inv_out_of_stock", dateRange: d })).total).toBe(2); // Pour-over Kit, Tote Bag
    expect((await metric(owner, businessId, { metric: "inv_low_stock", dateRange: d })).total).toBe(2); // Coffee Beans (≤3), Hoodie variation (≤4)
    const rows = (await metric(owner, businessId, { metric: "inv_units_on_hand", dateRange: d, dimension: "product" })).rows;
    expect(rows.find((r: any) => r.label === "Hoodie")?.value).toBe(13);
  });

  it("re-running a sync yields identical facts", async () => {
    const { pool } = await import("../src/db/pool.js");
    const snap = async () => (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
    const before = await snap();
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    expect(await snap()).toEqual(before);
  });
});

// ================================================================== Stripe

describe("Stripe connector", () => {
  let owner: any, businessId: string, connectionId: string;
  const usd = () => stripe.state.accounts.get(STRIPE_USD)!;
  const today = () => localDay(new Date(), STRIPE_TZ);
  const expected = (acct: StripeAccount, from: string, to: string, tz: string, div = 100, cur = "usd") => {
    const out = { gross: 0, refunds: 0, fees: 0, charges: 0 };
    for (const t of acct.balance_transactions) {
      const day = localDay(new Date(t.created * 1000), tz);
      if (day < from || day > to || t.currency !== cur) continue;
      if (t.type === "charge" || t.type === "payment") { out.gross += t.amount / div; out.charges++; }
      if (t.type === "refund" || t.type === "payment_refund") out.refunds += -t.amount / div;
      out.fees += t.fee / div + (t.type === "stripe_fee" ? -t.amount / div : 0);
    }
    return out;
  };

  it("validates the key format and reports a rejected key", async () => {
    owner = await signup(app, "Stripe");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme Payments"));
    const connect = (apiKey: string) => owner.post(`/api/businesses/${businessId}/connections/stripe/token`, { input: { apiKey } });
    expect((await connect(fakeToken("pk", "_test_", "abcdefghijklmnop"))).body.error.message).toMatch(/publishable/);
    expect((await connect("hello")).body.error.message).toMatch(/rk_live_/);
    const rejected = await connect(fakeToken("rk", "_test_", "Unknown0123456789"));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/rejected the token/);
  });

  it("imports balance transactions: gross, refunds, fees and charges in the default currency only", async () => {
    const { id, conn } = await connectWithToken(owner, businessId, "stripe", { apiKey: STRIPE_USD }, runAll);
    connectionId = id;
    expect(conn).toMatchObject({ status: "active", accountName: "Acme Payments", authMode: "token" });
    expect(conn.assets[0]).toMatchObject({ currency: "USD", timezone: STRIPE_TZ });
    expect([...stripe.state.versions]).toEqual(["2024-06-20"]);
    const to = today();
    const from = addDays(to, -60);
    const exp = expected(usd(), from, to, STRIPE_TZ);
    expect(exp.charges).toBeGreaterThan(100); // several pages
    expect(exp.refunds).toBeGreaterThan(0);
    const q = (m: string) => metric(owner, businessId, { metric: m, dateRange: { from, to } });
    const gross = await q("pay_gross_volume");
    expect(gross.availability).toBe("available");
    expect(gross.total).toBeCloseTo(exp.gross, 2);
    expect((await q("pay_refunds")).total).toBeCloseTo(exp.refunds, 2);
    expect((await q("pay_fees")).total).toBeCloseTo(exp.fees, 2);
    expect((await q("pay_charges")).total).toBe(exp.charges);
    expect((await q("pay_net_volume")).total).toBeCloseTo(exp.gross - exp.refunds, 2);
    expect((await q("pay_new_customers")).total).toBe(usd().customers.filter((c) => localDay(new Date(c.created * 1000), STRIPE_TZ) >= from).length);
    expect(notesOf(conn).join(" ")).toMatch(/EUR/);
  });

  it("snapshots active subscriptions and MRR (yearly, quantity, quarterly, weekly, discounts; trials excluded)", async () => {
    const d = { from: today(), to: today() };
    // 50 + 1200/12 + 3×20×0.75 + (40−10) + 90/3 + 10×52/12 = 298.33; the EUR subscription is active but not in USD MRR.
    expect((await metric(owner, businessId, { metric: "sub_mrr", dateRange: d })).total).toBeCloseTo(298.33, 2);
    expect((await metric(owner, businessId, { metric: "sub_active", dateRange: d })).total).toBe(7);
    expect((await metric(owner, businessId, { metric: "sub_new", dateRange: d })).total).toBeGreaterThanOrEqual(1);
    const canceledDay = localDay(new Date(usd().subscriptions.find((s) => s.id === "sub_canceled")!.ended_at * 1000), STRIPE_TZ);
    expect((await metric(owner, businessId, { metric: "sub_canceled", dateRange: { from: canceledDay, to: canceledDay } })).total).toBe(1);
    const conn = await connection(owner, businessId, connectionId);
    expect(notesOf(conn).join(" ")).toMatch(/another currency/);
  });

  it("incremental sync picks up a new charge and a refund of an older charge", async () => {
    const now = Math.floor(Date.now() / 1000);
    usd().balance_transactions.push(
      { id: "txn_new_1", type: "charge", amount: 77700, fee: 2283, currency: "usd", created: now },
      { id: "txn_new_2", type: "refund", amount: -1999, fee: 0, currency: "usd", created: now },
    );
    const to = today();
    const from = addDays(to, -60);
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    const exp = expected(usd(), from, to, STRIPE_TZ);
    expect((await metric(owner, businessId, { metric: "pay_gross_volume", dateRange: { from, to } })).total).toBeCloseTo(exp.gross, 2);
    expect((await metric(owner, businessId, { metric: "pay_refunds", dateRange: { from, to } })).total).toBeCloseTo(exp.refunds, 2);
    expect((await metric(owner, businessId, { metric: "pay_charges", dateRange: { from: to, to } })).total).toBe(expected(usd(), to, to, STRIPE_TZ).charges);
  });

  it("handles zero-decimal currencies (JPY amounts are whole yen)", async () => {
    const { businessId: biz } = await workspaceWithBusiness(owner, "Tokyo Tea");
    const { conn } = await connectWithToken(owner, biz, "stripe", { apiKey: STRIPE_JPY }, runAll);
    expect(conn.assets[0]).toMatchObject({ currency: "JPY", timezone: "Asia/Tokyo" });
    const to = localDay(new Date(), "Asia/Tokyo");
    const r = { from: addDays(to, -10), to };
    const gross = await metric(owner, biz, { metric: "pay_gross_volume", dateRange: r });
    expect(gross.total).toBe(15500);
    expect(gross.currency).toBe("JPY");
    expect((await metric(owner, biz, { metric: "pay_refunds", dateRange: r })).total).toBe(2000);
    expect((await metric(owner, biz, { metric: "pay_fees", dateRange: r })).total).toBe(558);
  });
});

// ================================================================== Shopify + WooCommerce in one business

describe("Shopify inventory and multi-store combination", () => {
  it("adds Shopify's stock snapshot and sums store sales across Shopify and WooCommerce", async () => {
    const owner = await signup(app, "Both");
    const { businessId } = await workspaceWithBusiness(owner, "Two Stores");
    shopify.state.tokens.add(SHOP_TOKEN);
    await connectWithToken(owner, businessId, "shopify", { shop: "two-stores.myshopify.com", accessToken: SHOP_TOKEN }, runAll);
    await connectWithToken(owner, businessId, "woocommerce", wooInput(), runAll);

    // Stock: tracked Shopify variants 12+0+30+max(-2,0)+7 = 49 (untracked gift card ignored); WooCommerce 55.
    const nyToday = localDay(new Date(), "America/New_York");
    const stock = await metric(owner, businessId, { metric: "inv_units_on_hand", dateRange: { from: addDays(nyToday, -1), to: nyToday }, dimension: "platform" });
    expect(stock.rows.find((r: any) => r.label === "Shopify")?.value).toBe(49);
    expect(stock.rows.find((r: any) => r.label === "WooCommerce")?.value).toBe(55);
    const out = await metric(owner, businessId, { metric: "inv_out_of_stock", dateRange: { from: addDays(nyToday, -1), to: nyToday }, dimension: "platform" });
    expect(out.rows.find((r: any) => r.label === "Shopify")?.value).toBe(2); // M jacket (0), socks (−2)

    // Net sales over the last 30 days = Shopify (NY days) + WooCommerce (Chicago days).
    const to = addDays(nyToday, -1);
    const from = addDays(to, -29);
    let shop = 0;
    for (const o of shopify.state.orders) {
      const d = localDay(o.createdAt, "America/New_York");
      if (!o.test && !o.cancelledAt && d >= from && d <= to) shop += o.currentSubtotal;
    }
    const wooNet = wooExpected(woo.state, from, to).net;
    const net = await metric(owner, businessId, { metric: "store_net_sales", dateRange: { from, to } });
    expect(net.availability).toBe("available");
    expect(net.total).toBeCloseTo(shop + wooNet, 2);
    const byPlatform = await metric(owner, businessId, { metric: "store_net_sales", dateRange: { from, to }, dimension: "platform" });
    expect(byPlatform.rows.find((r: any) => r.label === "Shopify")?.value).toBeCloseTo(shop, 2);
    expect(byPlatform.rows.find((r: any) => r.label === "WooCommerce")?.value).toBeCloseTo(wooNet, 2);
  });
});
