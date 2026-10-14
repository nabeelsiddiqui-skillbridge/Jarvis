import type express from "express";
import { startMock } from "./kit.js";

/**
 * Local stand-ins for WooCommerce (REST API v3 on a WordPress site) and Stripe (v1),
 * implementing just the endpoints the connectors use, with deterministic generated data.
 * Routes are host-prefixed (see providerUrl): /<host>/<path>. Used only by automated tests.
 */

const DAY = 86_400_000;
const rng = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;

/** "YYYY-MM-DDTHH:mm:ss" wall-clock time of an instant in a timezone (WooCommerce's format). */
export function wallTime(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
const gmt = (d: Date) => d.toISOString().slice(0, 19);

// ================================================================== WooCommerce

export const WOO_HOST = "shop.example.com";
export const WOO_TZ = "America/Chicago";

export interface WooState {
  key: string;
  secret: string;
  orders: any[];
  refunds: Map<number, any[]>;
  products: any[];
  variations: Map<number, any[]>;
  lowStockDefault: string;
  calls: { orders: string[] };
}

const PRODUCTS = [
  { name: "Ceramic Mug", price: 18 },
  { name: "Coffee Beans", price: 24 },
  { name: "Pour-over Kit", price: 65 },
  { name: "Hoodie", price: 55, parent: true },
];

export function makeWooOrders(days = 60, seed = 7) {
  const r = rng(seed);
  const orders: any[] = [];
  const refunds = new Map<number, any[]>();
  const now = Date.now();
  let id = 5000, lineId = 1, refundId = 900;
  for (let d = days; d >= 0; d--) {
    const n = d % 11 === 3 ? 0 : 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const created = new Date(now - d * DAY - Math.floor(r() * 18) * 3600_000 - 60_000);
      const status = r() < 0.08 ? pick(r, ["cancelled", "failed", "pending"]) : pick(r, ["completed", "completed", "processing", "on-hold"]);
      const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
        const p = pick(r, PRODUCTS);
        const qty = 1 + Math.floor(r() * 3);
        const subtotal = p.price * qty;
        const discount = r() < 0.25 ? 5 : 0;
        return {
          id: lineId++, name: p.parent ? `${p.name} - Blue` : p.name, ...(p.parent ? { parent_name: p.name } : {}),
          product_id: PRODUCTS.indexOf(p) + 1, variation_id: p.parent ? 41 : 0, quantity: qty,
          subtotal: subtotal.toFixed(2), subtotal_tax: (subtotal * 0.08).toFixed(2), total: (subtotal - discount).toFixed(2), total_tax: ((subtotal - discount) * 0.08).toFixed(2),
        };
      });
      const o: any = {
        id: id++, status, currency: "USD",
        date_created: wallTime(created, WOO_TZ), date_created_gmt: gmt(created),
        date_modified: wallTime(created, WOO_TZ), date_modified_gmt: gmt(created),
        billing: { country: pick(r, ["US", "US", "CA", "GB"]) }, shipping_total: "5.00", total_tax: "0.00",
        line_items: lines, refunds: [],
      };
      orders.push(o);
      // Some paid orders get a partial line refund.
      if (status === "completed" && r() < 0.15) {
        const l = lines[0]!;
        const amt = Number(l.total) / l.quantity;
        o.refunds = [{ id: refundId, reason: "damaged", total: (-amt).toFixed(2) }];
        refunds.set(o.id, [{ id: refundId++, amount: amt.toFixed(2), line_items: [{ id: lineId++, product_id: l.product_id, variation_id: l.variation_id, quantity: -1, total: (-amt).toFixed(2), meta_data: [{ key: "_refunded_item_id", value: String(l.id) }] }] }]);
      }
    }
  }
  // A EUR order (different currency than the store) and an amount-only refund, a few days ago.
  const t = new Date(now - 4 * DAY);
  orders.push({ id: id++, status: "completed", currency: "EUR", date_created: wallTime(t, WOO_TZ), date_created_gmt: gmt(t), date_modified: wallTime(t, WOO_TZ), date_modified_gmt: gmt(t), billing: { country: "DE" }, line_items: [{ id: lineId++, name: "Ceramic Mug", product_id: 1, variation_id: 0, quantity: 2, subtotal: "36.00", total: "36.00" }], refunds: [] });
  const t2 = new Date(now - 6 * DAY);
  const ao = { id: id++, status: "refunded", currency: "USD", date_created: wallTime(t2, WOO_TZ), date_created_gmt: gmt(t2), date_modified: wallTime(t2, WOO_TZ), date_modified_gmt: gmt(t2), billing: { country: "US" }, line_items: [{ id: lineId++, name: "Pour-over Kit", product_id: 3, variation_id: 0, quantity: 1, subtotal: "65.00", total: "65.00" }], refunds: [{ id: refundId, reason: "", total: "-20.00" }] };
  orders.push(ao);
  refunds.set(ao.id, [{ id: refundId++, amount: "20.00", line_items: [] }]);
  return { orders, refunds, nextId: id };
}

export function makeWooProducts() {
  const products = [
    { id: 1, name: "Ceramic Mug", type: "simple", manage_stock: true, stock_quantity: 40, stock_status: "instock", low_stock_amount: null, variations: [] },
    { id: 2, name: "Coffee Beans", type: "simple", manage_stock: true, stock_quantity: 2, stock_status: "instock", low_stock_amount: null, variations: [] }, // low (default threshold 3)
    { id: 3, name: "Pour-over Kit", type: "simple", manage_stock: true, stock_quantity: 0, stock_status: "outofstock", low_stock_amount: 5, variations: [] },
    { id: 4, name: "Hoodie", type: "variable", manage_stock: false, stock_quantity: null, stock_status: "instock", low_stock_amount: 4, variations: [41, 42, 43] },
    { id: 5, name: "Gift Wrap", type: "simple", manage_stock: false, stock_quantity: null, stock_status: "instock", low_stock_amount: null, variations: [] },
    { id: 6, name: "Tote Bag", type: "simple", manage_stock: true, stock_quantity: -1, stock_status: "onbackorder", low_stock_amount: null, variations: [] },
  ];
  const variations = new Map<number, any[]>([[4, [
    { id: 41, manage_stock: true, stock_quantity: 10, stock_status: "instock", low_stock_amount: null },
    { id: 42, manage_stock: true, stock_quantity: 3, stock_status: "instock", low_stock_amount: null }, // low via parent threshold 4
    { id: 43, manage_stock: "parent", stock_quantity: null, stock_status: "instock", low_stock_amount: null },
  ]]]);
  return { products, variations };
}

/** Paginate like WordPress: X-WP-Total / X-WP-TotalPages headers. */
function wpPage(req: express.Request, res: express.Response, list: any[]) {
  const per = Math.min(100, Number(req.query.per_page ?? 10));
  const page = Number(req.query.page ?? 1);
  res.set("X-WP-Total", String(list.length)).set("X-WP-TotalPages", String(Math.max(1, Math.ceil(list.length / per))));
  res.json(list.slice((page - 1) * per, page * per));
}

export async function startMockWoo() {
  const { orders, refunds } = makeWooOrders();
  const { products, variations } = makeWooProducts();
  const state: WooState = {
    key: ["ck", "0123456789abcdef0123456789abcdef01234567"].join("_"),
    secret: ["cs", "fedcba9876543210fedcba9876543210fedcba98"].join("_"),
    orders, refunds, products, variations, lowStockDefault: "3", calls: { orders: [] },
  };
  const base = `/${WOO_HOST}/wp-json`;
  const authed = (req: express.Request, res: express.Response) => {
    const h = req.get("authorization") ?? "";
    const [u, p] = Buffer.from(h.replace(/^Basic /, ""), "base64").toString().split(":");
    if (u === state.key && p === state.secret) return true;
    res.status(401).json({ code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources.", data: { status: 401 } });
    return false;
  };
  const mock = await startMock((app) => {
    app.get(`${base}/`, (_req, res) => res.json({ name: "Bean & Brew", description: "Coffee shop", url: `https://${WOO_HOST}`, gmt_offset: -5, timezone_string: WOO_TZ, namespaces: ["oembed/1.0", "wc/v3", "wp/v2"] }));
    app.get(`${base}/wc/v3/settings/general`, (req, res) => authed(req, res) && res.json([{ id: "woocommerce_store_city", value: "Austin" }, { id: "woocommerce_currency", value: "USD" }]));
    app.get(`${base}/wc/v3/settings/products/woocommerce_notify_low_stock_amount`, (req, res) => authed(req, res) && res.json({ id: "woocommerce_notify_low_stock_amount", value: state.lowStockDefault }));
    app.get(`${base}/wc/v3/orders`, (req, res) => {
      if (!authed(req, res)) return;
      state.calls.orders.push(new URLSearchParams(req.query as Record<string, string>).toString());
      let list = state.orders.filter((o) => o.status !== "trash");
      const { after, modified_after: modAfter, dates_are_gmt: gmtDates } = req.query as Record<string, string>;
      if (after) list = list.filter((o) => (gmtDates === "true" ? o.date_created_gmt : o.date_created) > after);
      if (modAfter) list = list.filter((o) => (gmtDates === "true" ? o.date_modified_gmt : o.date_modified) > modAfter);
      if (req.query.orderby === "modified") list.sort((a, b) => a.date_modified_gmt.localeCompare(b.date_modified_gmt) || a.id - b.id);
      wpPage(req, res, list);
    });
    app.get(`${base}/wc/v3/orders/:id/refunds`, (req, res) => authed(req, res) && res.json(state.refunds.get(Number(req.params.id)) ?? []));
    app.get(`${base}/wc/v3/products`, (req, res) => authed(req, res) && wpPage(req, res, state.products));
    app.get(`${base}/wc/v3/products/:id/variations`, (req, res) => authed(req, res) && wpPage(req, res, state.variations.get(Number(req.params.id)) ?? []));
  });
  return { ...mock, state };
}

/** Expected figures straight from the mock's raw orders (statuses/currency filtered like the connector documents). */
export function wooExpected(state: WooState, from: string, to: string) {
  const out = { gross: 0, net: 0, refunds: 0, orders: 0, units: 0, byProduct: new Map<string, number>() };
  for (const o of state.orders) {
    const day = o.date_created.slice(0, 10);
    if (day < from || day > to || ["cancelled", "failed", "pending", "trash", "checkout-draft"].includes(o.status)) continue;
    out.orders++;
    const refundedQty = new Map<string, number>();
    for (const r of state.refunds.get(o.id) ?? []) for (const li of r.line_items) {
      const ref = li.meta_data?.find((m: any) => m.key === "_refunded_item_id")?.value;
      refundedQty.set(ref, (refundedQty.get(ref) ?? 0) + Math.abs(li.quantity));
    }
    for (const l of o.line_items) out.units += l.quantity - (refundedQty.get(String(l.id)) ?? 0);
    if (o.currency !== "USD") continue;
    const refund = o.refunds.reduce((s: number, r: any) => s + Math.abs(Number(r.total)), 0);
    out.refunds += refund;
    for (const l of o.line_items) {
      out.gross += Number(l.subtotal);
      const name = l.parent_name ?? l.name;
      out.byProduct.set(name, (out.byProduct.get(name) ?? 0) + Number(l.subtotal));
    }
    out.net += o.line_items.reduce((s: number, l: any) => s + Number(l.total), 0) - refund;
  }
  return out;
}

// ================================================================== Stripe

export interface StripeAccount {
  account: any;
  balance_transactions: any[];
  customers: any[];
  subscriptions: any[];
}
export interface StripeState { accounts: Map<string, StripeAccount>; versions: Set<string> }

export const STRIPE_TZ = "America/Los_Angeles";

/** USD account: charges with fees, refunds of earlier charges, a Stripe Billing fee, and one EUR charge. */
export function makeStripeUsd(days = 50, seed = 3): StripeAccount {
  const r = rng(seed);
  const now = Math.floor(Date.now() / 1000) - 120;
  const txns: any[] = [];
  const customers: any[] = [];
  let n = 1;
  for (let d = days; d >= 0; d--) {
    const k = d % 13 === 5 ? 0 : 1 + Math.floor(r() * 4);
    for (let i = 0; i < k; i++) {
      const created = now - d * 86400 - Math.floor(r() * 20) * 3600;
      const amount = pick(r, [1999, 4900, 12000, 2500]);
      txns.push({ id: `txn_${n++}`, object: "balance_transaction", type: "charge", reporting_category: "charge", amount, fee: Math.round(amount * 0.029) + 30, net: 0, currency: "usd", created, status: "available" });
      if (r() < 0.12) txns.push({ id: `txn_${n++}`, object: "balance_transaction", type: "refund", reporting_category: "refund", amount: -Math.round(amount / 2), fee: 0, net: 0, currency: "usd", created: Math.min(now, created + 2 * 86400), status: "available" });
      if (r() < 0.4) customers.push({ id: `cus_${n++}`, object: "customer", created });
    }
  }
  txns.push({ id: `txn_${n++}`, object: "balance_transaction", type: "stripe_fee", reporting_category: "fee", amount: -500, fee: 0, net: -500, currency: "usd", created: now - 10 * 86400 });
  txns.push({ id: `txn_${n++}`, object: "balance_transaction", type: "charge", reporting_category: "charge", amount: 8000, fee: 262, net: 0, currency: "eur", created: now - 3 * 86400 });
  txns.push({ id: `txn_${n++}`, object: "balance_transaction", type: "payout", reporting_category: "payout", amount: -50000, fee: 0, net: -50000, currency: "usd", created: now - 2 * 86400 });

  const price = (unit: number, interval: string, count = 1, currency = "usd") => ({ id: `price_${unit}_${interval}`, object: "price", unit_amount: unit, currency, recurring: { interval, interval_count: count, usage_type: "licensed" } });
  const sub = (id: string, status: string, items: { price: any; quantity: number }[], extra: Record<string, unknown> = {}) => ({
    id, object: "subscription", status, currency: items[0]!.price.currency, created: now - 20 * 86400, start_date: now - 20 * 86400, ended_at: null, canceled_at: null,
    items: { object: "list", data: items.map((it, i) => ({ id: `si_${id}_${i}`, price: it.price, quantity: it.quantity })) }, discounts: [], discount: null, ...extra,
  });
  const subscriptions = [
    sub("sub_monthly", "active", [{ price: price(5000, "month"), quantity: 1 }]), // 50
    sub("sub_yearly", "active", [{ price: price(120000, "year"), quantity: 1 }]), // 100
    sub("sub_qty_pct", "active", [{ price: price(2000, "month"), quantity: 3 }], { discounts: [{ id: "di_1", object: "discount", end: null, coupon: { id: "C25", percent_off: 25, amount_off: null } }] }), // 45
    sub("sub_amount_off", "past_due", [{ price: price(4000, "month"), quantity: 1 }], { discounts: [{ id: "di_2", object: "discount", end: null, coupon: { id: "C10", percent_off: null, amount_off: 1000, currency: "usd" } }] }), // 30
    sub("sub_quarterly", "active", [{ price: price(9000, "month", 3), quantity: 1 }]), // 30
    sub("sub_trial", "trialing", [{ price: price(9900, "month"), quantity: 1 }]),
    sub("sub_eur", "active", [{ price: price(3000, "month", 1, "eur"), quantity: 1 }]),
    sub("sub_canceled", "canceled", [{ price: price(5000, "month"), quantity: 1 }], { created: now - 30 * 86400, ended_at: now - 3 * 86400, canceled_at: now - 3 * 86400 }),
    sub("sub_new_today", "active", [{ price: price(1000, "week"), quantity: 1 }], { created: now - 60 }), // 10*52/12 = 43.333
  ];
  return {
    account: { id: "acct_1USD", object: "account", business_profile: { name: "Acme Payments LLC" }, settings: { dashboard: { display_name: "Acme Payments", timezone: STRIPE_TZ } }, default_currency: "usd" },
    balance_transactions: txns, customers, subscriptions,
  };
}

/** JPY account (zero-decimal currency): amounts are whole yen. */
export function makeStripeJpy(): StripeAccount {
  const now = Math.floor(Date.now() / 1000) - 120;
  return {
    account: { id: "acct_2JPY", object: "account", business_profile: { name: "Tokyo Tea KK" }, settings: { dashboard: { display_name: "Tokyo Tea", timezone: "Asia/Tokyo" } }, default_currency: "jpy" },
    balance_transactions: [
      { id: "txn_j1", type: "charge", amount: 3500, fee: 126, currency: "jpy", created: now - 2 * 86400 },
      { id: "txn_j2", type: "payment", amount: 12000, fee: 432, currency: "jpy", created: now - 86400 },
      { id: "txn_j3", type: "payment_refund", amount: -2000, fee: 0, currency: "jpy", created: now - 3600 },
    ],
    customers: [],
    subscriptions: [],
  };
}

export async function startMockStripe(keys: Record<string, StripeAccount>) {
  const state: StripeState = { accounts: new Map(Object.entries(keys)), versions: new Set() };
  const acct = (req: express.Request, res: express.Response) => {
    state.versions.add(req.get("stripe-version") ?? "");
    const a = state.accounts.get((req.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (!a) res.status(401).json({ error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
    return a;
  };
  const q = (req: express.Request, k: string) => {
    const v: any = (req.query as any)[k];
    return v == null ? undefined : String(v);
  };
  const listRoute = (key: "balance_transactions" | "customers" | "subscriptions") => (req: express.Request, res: express.Response) => {
    const a = acct(req, res);
    if (!a) return;
    const gte = Number(q(req, "created[gte]") ?? (req.query as any).created?.gte ?? 0);
    let list = [...a[key]].filter((x) => x.created >= gte).sort((x, y) => y.created - x.created || String(y.id).localeCompare(String(x.id)));
    if (key === "subscriptions" && q(req, "status") !== "all") list = list.filter((s) => s.status !== "canceled");
    const after = q(req, "starting_after");
    if (after) list = list.slice(list.findIndex((x) => x.id === after) + 1);
    const limit = Math.min(100, Number(q(req, "limit") ?? 10));
    res.json({ object: "list", url: `/v1/${key}`, has_more: list.length > limit, data: list.slice(0, limit) });
  };
  const mock = await startMock((app) => {
    app.get("/api.stripe.com/v1/account", (req, res) => { const a = acct(req, res); if (a) res.json(a.account); });
    app.get("/api.stripe.com/v1/balance", (req, res) => { const a = acct(req, res); if (a) res.json({ object: "balance", available: [{ amount: 0, currency: a.account.default_currency }], pending: [] }); });
    app.get("/api.stripe.com/v1/balance_transactions", listRoute("balance_transactions"));
    app.get("/api.stripe.com/v1/customers", listRoute("customers"));
    app.get("/api.stripe.com/v1/subscriptions", listRoute("subscriptions"));
  });
  return { ...mock, state };
}
