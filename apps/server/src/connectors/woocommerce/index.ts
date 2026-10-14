import { addDays } from "@bca/shared";
import { config } from "../../config.js";
import { ProviderError, providerFetch } from "../http.js";
import {
  Tally, basic, businessTimezone, deleteRecords, finishRecordSync, overridable, recomputeDays, recordWindow, required, storeRecords, writeSnapshot, type StoredRecord,
} from "../kit.js";
import { datesBetween, type FactInput } from "../normalize.js";
import type { ConnectorDefinition, Credentials, SyncContext, SyncResult } from "../types.js";

/**
 * WooCommerce (self-hosted WordPress stores).
 *
 * Auth: a REST API consumer key/secret pair (ck_… / cs_…, "Read" permission) sent as
 * HTTP Basic auth over HTTPS to `<store>/wp-json/wc/v3/`. Keys never expire; there is
 * nothing to refresh or revoke on our side (the merchant deletes the key in WooCommerce).
 *
 * Data model: orders are imported as source records (one per order, keyed by order id)
 * and aggregated per reporting day = the order's `date_created` in the site's own local
 * time (WooCommerce reports it without an offset). Figures, all excluding tax and shipping:
 *  - store_gross_sales = Σ line `subtotal` (before coupons)
 *  - store_net_sales   = Σ line `total` (after coupons) − refunded merchandise, where refunded
 *    merchandise is Σ |refund line total| from the order's refund details; refunds without line
 *    items (amount-only refunds) are subtracted in full and spread pro-rata over the lines
 *  - store_refunds     = Σ |refunds[].total| (the full refunded amount), on the ORDER's day
 *  - store_orders, store_units (quantity net of refunded quantity)
 * Dimensions: product (parent product name for variations) and country (billing country).
 * Unpaid / void orders (pending, failed, cancelled, trash, checkout-draft) are excluded.
 * Orders in a currency other than the store's are counted but left out of money metrics.
 *
 * Sync: initial import of 365 days by creation date; incremental syncs fetch orders modified
 * since the last sync (10-minute overlap); reconciliation re-scans the last 30 days by creation
 * date and drops orders that disappeared (permanently deleted / trashed).
 * Inventory: a snapshot for today from products (and variations) with managed stock.
 */

const W = overridable("WOOCOMMERCE_BASE_URL_OVERRIDE");
const PROVIDER = "WooCommerce";
const INITIAL_DAYS = 365;
const RECONCILE_DAYS = 30;
const OVERLAP_MS = 10 * 60_000;
const PER_PAGE = 100;
/** Statuses that never count as a sale. Everything else (processing, completed, on-hold, refunded, custom) does. */
const EXCLUDED_STATUSES = new Set(["cancelled", "failed", "trash", "checkout-draft", "pending", "auto-draft"]);
/** WooCommerce's default "low stock threshold" when the store setting can't be read. */
const DEFAULT_LOW_STOCK = 2;

const FLOW = ["store_gross_sales", "store_net_sales", "store_refunds", "store_orders", "store_units"];
const MONEY = new Set(["store_gross_sales", "store_net_sales", "store_refunds"]);
const INVENTORY = ["inv_units_on_hand", "inv_out_of_stock", "inv_low_stock"];

// ------------------------------------------------------------------ store URL + HTTP

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;
const PRIVATE_IP = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

/** Normalize the store address the user typed to `https://host[/subdir]` (no trailing slash). */
export function normalizeStoreUrl(input: string): string {
  let s = (input ?? "").trim();
  if (!s) throw new ProviderError("permanent", "Store URL is required.");
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ProviderError("permanent", "Enter your store's address, e.g. https://shop.example.com");
  }
  const allowHttp = process.env.WOOCOMMERCE_ALLOW_HTTP === "true" && !config.isProd;
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new ProviderError("permanent", "The store must be served over HTTPS (https://…) so the API key is sent securely.");
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || PRIVATE_HOST.test(host) || PRIVATE_IP.test(host) || u.username || u.password) {
    throw new ProviderError("permanent", "Enter your store's public address, e.g. https://shop.example.com");
  }
  // Strip anything after the WordPress root (people paste admin or API links).
  const path = u.pathname.replace(/\/(wp-admin|wp-json|shop|my-account)(\/.*)?$/i, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

const auth = (creds: Credentials) => ({ Authorization: basic(creds.consumerKey, creds.consumerSecret) });

async function wc<T = any>(creds: Credentials, path: string, params: Record<string, string | number> = {}) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const url = W(`${creds.url}/wp-json/wc/v3/${path}${q.size ? `?${q}` : ""}`);
  const r = await providerFetch<T>(url, { provider: PROVIDER, headers: auth(creds) });
  if (typeof r.data === "string") throw new ProviderError("permanent", "The store didn't return WooCommerce API data. Check the URL and that permalinks are enabled in WordPress.");
  return r;
}

/** Every page of a list endpoint (pages counted by X-WP-TotalPages). */
async function wcAll(creds: Credentials, path: string, params: Record<string, string | number>, onPage: (items: any[]) => Promise<void> | void) {
  let total = 0;
  for (let page = 1; ; page++) {
    const { data, headers } = await wc<any[]>(creds, path, { ...params, per_page: PER_PAGE, page });
    const items = Array.isArray(data) ? data : [];
    total += items.length;
    if (items.length) await onPage(items);
    const pages = Number(headers.get("x-wp-totalpages") ?? 0);
    if (!items.length || (pages ? page >= pages : items.length < PER_PAGE)) break;
  }
  return total;
}

/** Site name + timezone from the WordPress REST index (public). */
async function siteInfo(url: string) {
  const { data } = await providerFetch(W(`${url}/wp-json/`), { provider: PROVIDER }).catch((e) => {
    if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "permanent")) throw new ProviderError("permanent", "Couldn't find the WordPress REST API at that address. Check the store URL.");
    throw e;
  });
  if (!data || typeof data !== "object") throw new ProviderError("permanent", "That address doesn't look like a WordPress site. Check the store URL.");
  const namespaces: string[] = Array.isArray(data.namespaces) ? data.namespaces : [];
  if (namespaces.length && !namespaces.includes("wc/v3")) throw new ProviderError("permanent", "WooCommerce's REST API (wc/v3) isn't enabled on this site. Make sure WooCommerce is installed and active.");
  return { name: String(data.name ?? "") || null, timezone: siteTimezone(data.timezone_string, data.gmt_offset) };
}

/** IANA timezone from WordPress settings: the named zone, or a whole-hour UTC offset as Etc/GMT±N. */
export function siteTimezone(tzString: unknown, gmtOffset: unknown): string | null {
  if (typeof tzString === "string" && tzString) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tzString });
      return tzString;
    } catch { /* fall through */ }
  }
  const off = Number(gmtOffset);
  if (gmtOffset === "" || gmtOffset == null || !Number.isFinite(off)) return null;
  if (off === 0) return "UTC";
  if (!Number.isInteger(off)) return null; // e.g. +5.5: no Etc zone; reporting falls back to the business timezone
  return `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`; // Etc zones use inverted signs
}

async function storeCurrency(creds: Credentials): Promise<string | null> {
  const { data } = await wc<any[]>(creds, "settings/general");
  const cur = (Array.isArray(data) ? data : []).find((s: any) => s?.id === "woocommerce_currency")?.value;
  return cur ? String(cur).toUpperCase() : null;
}

// ------------------------------------------------------------------ normalize orders

interface OrderLine { product: string; qty: number; refundedQty: number; subtotal: number; total: number; refunded: number }
interface OrderRec {
  day: string;
  status: string;
  currency: string;
  country: string | null;
  refundTotal: number;
  lines: OrderLine[];
  modifiedGmt: string | null;
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
/** Country name (matching Shopify's names, so platforms combine) from an ISO code. */
function countryName(code: unknown): string | null {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return null;
  try {
    return regionNames.of(c) ?? c;
  } catch {
    return c;
  }
}

/** WooCommerce returns local times without offset ("2026-03-01T14:05:00"); the day is the first 10 chars. */
const localDay = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const gmtIso = (s: unknown) => (typeof s === "string" && s ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).toISOString() : null);

function normalizeOrder(o: any, refundDetails: any[] | null): OrderRec | null {
  const day = localDay(o.date_created);
  if (!day) return null;
  const lines = (o.line_items ?? []).map((l: any) => ({
    id: String(l.id),
    productId: num(l.product_id),
    variationId: num(l.variation_id),
    product: String(l.parent_name || l.name || "Unknown product"),
    qty: num(l.quantity),
    refundedQty: 0,
    subtotal: num(l.subtotal),
    total: num(l.total),
    refunded: 0,
  }));
  const refundTotal = (o.refunds ?? []).reduce((s: number, r: any) => s + Math.abs(num(r.total)), 0);
  let unallocated = 0;
  if (refundDetails) {
    for (const r of refundDetails) {
      const items: any[] = r.line_items ?? [];
      // Amount-only refunds (no line items) reduce net sales by their full amount.
      if (!items.length) unallocated += Math.abs(num(r.amount ?? r.total));
      for (const ri of items) {
        const ref = (ri.meta_data ?? []).find((m: any) => m?.key === "_refunded_item_id")?.value;
        const line = ref != null
          ? lines.find((l: any) => l.id === String(ref))
          : lines.find((l: any) => l.productId === num(ri.product_id) && l.variationId === num(ri.variation_id));
        const amt = Math.abs(num(ri.total));
        if (line) {
          line.refundedQty += Math.abs(num(ri.quantity));
          line.refunded += amt;
        } else unallocated += amt;
      }
    }
  } else if (refundTotal > 0) {
    unallocated = refundTotal; // details unavailable: treat the whole refund as merchandise
  }
  if (unallocated > 0) {
    const base = lines.reduce((s: number, l: any) => s + Math.max(0, l.total - l.refunded), 0);
    for (const l of lines) l.refunded += base > 0 ? (unallocated * Math.max(0, l.total - l.refunded)) / base : 0;
  }
  return {
    day,
    status: String(o.status ?? ""),
    currency: String(o.currency ?? "").toUpperCase(),
    country: countryName(o.billing?.country) ?? countryName(o.shipping?.country),
    refundTotal: Math.round(refundTotal * 100) / 100,
    lines: lines.map((l: any) => ({
      product: l.product, qty: l.qty, refundedQty: Math.min(l.qty, l.refundedQty), subtotal: l.subtotal, total: l.total,
      refunded: Math.round(Math.min(l.total, l.refunded) * 1e4) / 1e4,
    })),
    modifiedGmt: gmtIso(o.date_modified_gmt) ?? gmtIso(o.date_created_gmt),
  };
}

function computeDay(storeCur: string | null, notes: Set<string>) {
  return (_date: string, records: (OrderRec & { _type: string })[]): FactInput[] => {
    const t = new Tally(FLOW);
    for (const o of records) {
      if (EXCLUDED_STATUSES.has(o.status)) continue;
      const moneyOk = !storeCur || o.currency === storeCur;
      if (!moneyOk) notes.add(`Some orders are in ${o.currency}, not the store currency ${storeCur}; they're counted as orders but left out of sales figures.`);
      const country = o.country ?? "Unknown";
      t.addAll("store_orders", 1, { country });
      // Product refund rows are the refunded merchandise scaled to the full refund amount, so they add up to the total.
      const merch = o.lines.reduce((s, l) => s + l.refunded, 0);
      for (const l of o.lines) {
        t.addAll("store_units", l.qty - l.refundedQty, { product: l.product });
        if (!moneyOk) continue;
        t.addAll("store_gross_sales", l.subtotal, { product: l.product, country });
        t.addAll("store_net_sales", l.total - l.refunded, { product: l.product, country });
        if (l.refunded && merch > 0) t.add("store_refunds", (l.refunded * o.refundTotal) / merch, "product", l.product);
      }
      if (moneyOk && o.refundTotal) t.add("store_refunds", o.refundTotal).add("store_refunds", o.refundTotal, "country", country);
    }
    return t.facts(MONEY, storeCur);
  };
}

// ------------------------------------------------------------------ inventory snapshot

interface StockItem { product: string; qty: number; status: string; low: number | null }

async function lowStockDefault(creds: Credentials) {
  try {
    const { data } = await wc<any>(creds, "settings/products/woocommerce_notify_low_stock_amount");
    const v = Number(data?.value);
    return Number.isFinite(v) ? v : DEFAULT_LOW_STOCK;
  } catch {
    return DEFAULT_LOW_STOCK;
  }
}

const lowAmount = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

async function inventory(ctx: SyncContext, creds: Credentials, today: string, notes: Set<string>) {
  const items: StockItem[] = [];
  const variable: any[] = [];
  await wcAll(creds, "products", {}, (products) => {
    for (const p of products) {
      if (p.manage_stock === true) items.push({ product: String(p.name), qty: num(p.stock_quantity), status: String(p.stock_status ?? ""), low: lowAmount(p.low_stock_amount) });
      if (p.type === "variable" && (p.variations ?? []).length) variable.push(p);
    }
  });
  for (const p of variable) {
    await wcAll(creds, `products/${encodeURIComponent(p.id)}/variations`, {}, (vars) => {
      for (const v of vars) {
        // manage_stock "parent" means the parent product's stock (already counted) applies.
        if (v.manage_stock !== true) continue;
        items.push({ product: String(p.name), qty: num(v.stock_quantity), status: String(v.stock_status ?? ""), low: lowAmount(v.low_stock_amount) ?? lowAmount(p.low_stock_amount) });
      }
    });
  }
  const threshold = await lowStockDefault(creds);
  const t = new Tally(INVENTORY);
  for (const i of items) {
    t.addAll("inv_units_on_hand", Math.max(0, i.qty), { product: i.product });
    const out = i.status === "outofstock" || i.qty <= 0;
    if (out) t.add("inv_out_of_stock");
    else if (i.qty <= (i.low ?? threshold)) t.add("inv_low_stock");
  }
  if (!items.length) notes.add("No products with managed stock were found, so stock levels are zero. Enable “Manage stock” on products in WooCommerce to track them.");
  await writeSnapshot(ctx, today, t.facts(), INVENTORY);
  return items.length;
}

// ------------------------------------------------------------------ sync

async function syncStore(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
  const { today, initial, coveredFrom, cursor, allDays } = recordWindow(ctx, tz, INITIAL_DAYS);
  const storeCur = ctx.asset.currency ?? null;
  const affected = new Set<string>();
  const notes = new Set<string>();
  const startedAt = Date.now();
  let maxModified: number = cursor.lastModifiedMs ?? 0;
  const seen = new Set<string>();

  const params: Record<string, string> = { orderby: "modified", order: "asc" };
  if (initial) params.after = `${coveredFrom}T00:00:00`;
  else if (ctx.mode === "reconcile") params.after = `${addDays(today, -RECONCILE_DAYS + 1)}T00:00:00`;
  else {
    params.modified_after = new Date((cursor.lastModifiedMs ?? startedAt) - OVERLAP_MS).toISOString().slice(0, 19);
    params.dates_are_gmt = "true";
  }

  const records = await wcAll(creds, "orders", params, async (orders) => {
    const recs: StoredRecord<OrderRec>[] = [];
    for (const o of orders) {
      seen.add(String(o.id));
      // Line-level refund detail (quantities, merchandise amounts) only for orders that have refunds.
      let details: any[] | null = null;
      if ((o.refunds ?? []).length) {
        details = await wc<any[]>(creds, `orders/${encodeURIComponent(o.id)}/refunds`).then((r) => (Array.isArray(r.data) ? r.data : null)).catch((e) => {
          if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "scope")) return null;
          throw e;
        });
      }
      const n = normalizeOrder(o, details);
      if (!n) continue;
      if (n.modifiedGmt) maxModified = Math.max(maxModified, Date.parse(n.modifiedGmt));
      recs.push({ type: "order", id: String(o.id), payload: n, date: n.day, occurredAt: gmtIso(o.date_created_gmt) ?? `${n.day}T00:00:00Z`, updatedAt: n.modifiedGmt });
    }
    await storeRecords(ctx, recs, ["day"], affected);
  });

  // Reconciliation: orders stored for the re-scanned days that the store no longer returns were deleted.
  if (ctx.mode === "reconcile") {
    const from = addDays(today, -RECONCILE_DAYS + 1);
    const { rows } = await ctx.db.query(`SELECT provider_id FROM source_records WHERE asset_id = $1 AND record_type = 'order' AND local_date >= $2`, [ctx.asset.id, from]);
    const gone = rows.map((r) => String(r.provider_id)).filter((id) => !seen.has(id));
    await deleteRecords(ctx, "order", gone, ["day"], affected);
    for (const d of datesBetween(from, today)) affected.add(d);
  }

  // Recompute changed days plus every day since the last covered day (empty days are real zeros).
  const fillFrom = initial || !cursor.coveredTo ? coveredFrom : cursor.coveredTo < today ? cursor.coveredTo : today;
  const dates = initial ? allDays() : [...affected, ...datesBetween(fillFrom < coveredFrom ? coveredFrom : fillFrom, today)];
  const recomputed = await recomputeDays<OrderRec>(ctx, dates.filter((d) => d >= coveredFrom && d <= today), {
    recordTypes: ["order"], dateFields: ["day"], owned: FLOW, compute: computeDay(storeCur, notes),
  });

  try {
    await inventory(ctx, creds, today, notes);
  } catch (e) {
    if (!(e instanceof ProviderError) || (e.kind !== "scope" && e.kind !== "not_found")) throw e;
    notes.add("Stock levels couldn't be read: the API key needs Read access to products.");
  }

  return finishRecordSync(ctx, {
    coveredFrom, today, records, recomputed,
    cursor: { lastModifiedMs: maxModified || startedAt },
    notes: [...notes],
  });
}

// ------------------------------------------------------------------ definition

const KEY_RE = /^ck_[a-f0-9]{20,64}$/i;
const SECRET_RE = /^cs_[a-f0-9]{20,64}$/i;

export const woocommerce: ConnectorDefinition = {
  id: "woocommerce",
  name: "WooCommerce",
  category: "Commerce",
  description: "Orders, gross and net sales, refunds, units, products, countries and stock levels from a WooCommerce store.",
  implemented: true,
  configKeys: [],
  scopes: [{ scope: "read", reason: "Read-only REST API key: orders, refunds, products and store settings" }],
  metrics: [...FLOW, ...INVENTORY],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Orders appear at the next sync (every hour)",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: RECONCILE_DAYS,
  docsUrl: "https://woocommerce.github.io/woocommerce-rest-api-docs/",

  tokenConnect: {
    fields: [
      { key: "url", label: "Store URL", placeholder: "https://shop.example.com", help: "The address of your WordPress site (must use https)." },
      { key: "consumerKey", label: "Consumer key", placeholder: "ck_…", secret: true },
      { key: "consumerSecret", label: "Consumer secret", placeholder: "cs_…", secret: true },
    ],
    instructions: [
      "In WordPress admin open WooCommerce → Settings → Advanced → REST API and click “Add key”.",
      "Enter a description (e.g. Business Command AI), choose your user, and set Permissions to “Read”.",
      "Click “Generate API key” and copy the Consumer key (ck_…) and Consumer secret (cs_…) — the secret is shown only once.",
      "Make sure WordPress permalinks are not set to “Plain” (Settings → Permalinks), otherwise the REST API isn't reachable.",
    ],
    async connect(input) {
      const f = required(input, { url: "Store URL", consumerKey: "Consumer key", consumerSecret: "Consumer secret" });
      const url = normalizeStoreUrl(f.url);
      if (!KEY_RE.test(f.consumerKey)) throw new ProviderError("permanent", "That doesn't look like a WooCommerce consumer key (it starts with ck_).");
      if (!SECRET_RE.test(f.consumerSecret)) throw new ProviderError("permanent", "That doesn't look like a WooCommerce consumer secret (it starts with cs_).");
      const creds = { url, consumerKey: f.consumerKey, consumerSecret: f.consumerSecret };
      const site = await siteInfo(url);
      const currency = await storeCurrency(creds); // authenticated: verifies the key
      const host = new URL(url).host;
      return {
        credentials: creds,
        scopes: ["read"],
        externalAccountId: url.replace(/^https?:\/\//, ""),
        displayName: site.name ?? host,
        tokenExpiresAt: null,
        settings: { authMode: "token", url, currency, timezone: site.timezone },
      };
    },
  },

  async discoverAssets(creds, connection) {
    const site = await siteInfo(creds.url);
    const currency = await storeCurrency(creds);
    return [{
      providerAssetId: creds.url.replace(/^https?:\/\//, ""),
      name: site.name ?? connection.display_name ?? new URL(creds.url).host,
      kind: "store",
      currency,
      timezone: site.timezone,
      metadata: { url: creds.url },
    }];
  },

  sync: syncStore,

  async healthCheck(ctx) {
    const creds = await ctx.credentials();
    await wc(creds, "orders", { per_page: 1 });
  },
};
