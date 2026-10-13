import { createHmac } from "node:crypto";
import { addDays, todayIn } from "@bca/shared";
import { config } from "../../config.js";
import { safeEqual } from "../../lib/crypto.js";
import { ProviderError, providerFetch } from "../http.js";
import { datesBetween, localDate, replaceFacts, updateAssetCursor, upsertSourceRecords, type FactInput, type SourceRecordInput } from "../normalize.js";
import type { ConnectorDefinition, Credentials, SyncContext, SyncResult, VerifiedWebhook } from "../types.js";

/**
 * Shopify — the reference live connector.
 *
 * Auth: OAuth authorization-code grant requesting an *expiring offline* token
 * (access token ≈1h + rotating refresh token), callback HMAC + state verified.
 * Data: GraphQL Admin API, cursor pagination, cost-based throttling.
 * Sync: initial import → incremental by updated_at (with overlap) → nightly
 * reconciliation of recent days. Webhooks: orders/create|updated|cancelled,
 * refunds/create, app/uninstalled (+ mandatory compliance topics), verified by
 * base64 HMAC and de-duplicated by X-Shopify-Webhook-Id.
 */

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-07";
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Base URL for a shop. A local override exists only for automated tests and is ignored in production. */
function shopBase(shop: string) {
  const override = process.env.SHOPIFY_BASE_URL_OVERRIDE;
  if (override && !config.isProd) return `${override.replace(/\/$/, "")}/${shop}`;
  return `https://${shop}`;
}

export function normalizeShopDomain(input: string): string {
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (s && !s.includes(".")) s = `${s}.myshopify.com`;
  if (!SHOP_RE.test(s)) throw new ProviderError("permanent", "Enter your store's myshopify.com domain, e.g. your-store.myshopify.com");
  return s;
}

const SCOPES = ["read_orders", "read_products", "read_inventory"];
const OPTIONAL_SCOPES = ["read_all_orders"];

const ORDER_FIELDS = `
  id name createdAt updatedAt cancelledAt test
  subtotalPriceSet { shopMoney { amount currencyCode } }
  currentSubtotalPriceSet { shopMoney { amount currencyCode } }
  customer { id }
  shippingAddress { countryCodeV2 country }
  billingAddress { countryCodeV2 country }
  app { name }
  lineItems(first: 250) {
    nodes {
      id title quantity currentQuantity
      originalTotalSet { shopMoney { amount } }
      discountedTotalSet { shopMoney { amount } }
      product { id title }
      variant { id inventoryItem { unitCost { amount } } }
    }
  }`;

/** What we keep from an order: no customer PII beyond Shopify's opaque customer id. */
interface NormalOrder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelled: boolean;
  test: boolean;
  currency: string;
  subtotal: number;
  currentSubtotal: number;
  customerId: string | null;
  country: string | null;
  channel: string;
  lines: { product: string; qty: number; currentQty: number; original: number; discounted: number; unitCost: number | null }[];
}

const num = (v: unknown) => (v == null ? 0 : Number(v));

function normalizeOrder(o: any): NormalOrder {
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    cancelled: Boolean(o.cancelledAt),
    test: Boolean(o.test),
    currency: o.subtotalPriceSet?.shopMoney?.currencyCode ?? o.currentSubtotalPriceSet?.shopMoney?.currencyCode,
    subtotal: num(o.subtotalPriceSet?.shopMoney?.amount),
    currentSubtotal: num(o.currentSubtotalPriceSet?.shopMoney?.amount),
    customerId: o.customer?.id ?? null,
    country: o.shippingAddress?.country ?? o.billingAddress?.country ?? null,
    channel: o.app?.name ?? "Unknown",
    lines: (o.lineItems?.nodes ?? []).map((l: any) => ({
      product: l.product?.title ?? l.title,
      qty: num(l.quantity),
      currentQty: num(l.currentQuantity),
      original: num(l.originalTotalSet?.shopMoney?.amount),
      discounted: num(l.discountedTotalSet?.shopMoney?.amount),
      unitCost: l.variant?.inventoryItem?.unitCost?.amount != null ? num(l.variant.inventoryItem.unitCost.amount) : null,
    })),
  };
}

// ------------------------------------------------------------------ GraphQL with cost throttling

async function gql<T = any>(shop: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data } = await providerFetch(`${shopBase(shop)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      provider: "Shopify",
      method: "POST",
      json: { query, variables },
      idempotent: true, // read queries are safe to retry
      headers: { "X-Shopify-Access-Token": token },
    });
    const throttled = data?.errors?.some((e: any) => e?.extensions?.code === "THROTTLED");
    const status = data?.extensions?.cost?.throttleStatus;
    if (throttled) {
      const need = data?.extensions?.cost?.requestedQueryCost ?? 100;
      const wait = status ? Math.ceil(((need - status.currentlyAvailable) / Math.max(1, status.restoreRate)) * 1000) : 2000;
      await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(500, wait))));
      continue;
    }
    if (data?.errors?.length) {
      const msg = String(data.errors[0]?.message ?? "error");
      if (/access denied|ACCESS_DENIED/i.test(msg)) throw new ProviderError("scope", "Shopify denied access. Reconnect and approve the requested permissions.", 403, undefined, msg);
      throw new ProviderError("permanent", "Shopify returned an error for a data request.", 400, undefined, msg);
    }
    // Stay ahead of the bucket: pause when it's nearly empty.
    if (status && status.currentlyAvailable < 200) {
      await new Promise((r) => setTimeout(r, Math.ceil(((200 - status.currentlyAvailable) / Math.max(1, status.restoreRate)) * 1000)));
    }
    return data.data as T;
  }
  throw new ProviderError("rate_limit", "Shopify kept throttling requests", 429, 60_000);
}

// ------------------------------------------------------------------ aggregation

const OWNED = ["store_orders", "store_net_sales", "store_gross_sales", "store_refunds", "store_units", "store_cogs", "store_new_customers"];
const round2 = (n: number) => Math.round(n * 100) / 100;

async function computeDay(ctx: SyncContext, date: string, fullHistory: boolean): Promise<FactInput[]> {
  const { rows } = await ctx.db.query(
    `SELECT payload FROM source_records WHERE asset_id = $1 AND record_type = 'order' AND local_date = $2`,
    [ctx.asset.id, date],
  );
  const orders = rows.map((r) => r.payload as NormalOrder).filter((o) => !o.test && !o.cancelled);
  const currency = ctx.asset.currency ?? orders[0]?.currency ?? null;
  const facts: FactInput[] = [];
  const add = (metric: string, value: number, money = false, dimKey = "", dimValue = "") => facts.push({ metric, value: money ? round2(value) : value, currency: money ? currency : null, dimKey, dimValue });

  let net = 0, gross = 0, refunds = 0, units = 0, cogs = 0, cogsComplete = true;
  const byProduct = new Map<string, { net: number; gross: number; units: number; cogs: number; cogsComplete: boolean }>();
  const byCountry = new Map<string, { orders: number; net: number }>();
  const byChannel = new Map<string, { orders: number; net: number }>();
  for (const o of orders) {
    net += o.currentSubtotal;
    refunds += Math.max(0, o.subtotal - o.currentSubtotal);
    const country = o.country ?? "Unknown";
    const c = byCountry.get(country) ?? { orders: 0, net: 0 };
    c.orders++; c.net += o.currentSubtotal; byCountry.set(country, c);
    const ch = byChannel.get(o.channel) ?? { orders: 0, net: 0 };
    ch.orders++; ch.net += o.currentSubtotal; byChannel.set(o.channel, ch);
    for (const l of o.lines) {
      gross += l.original;
      units += l.currentQty;
      const lineNet = l.qty > 0 ? (l.discounted * l.currentQty) / l.qty : 0;
      const p = byProduct.get(l.product) ?? { net: 0, gross: 0, units: 0, cogs: 0, cogsComplete: true };
      p.net += lineNet; p.gross += l.original; p.units += l.currentQty;
      if (l.unitCost == null) { cogsComplete = false; p.cogsComplete = false; }
      else { cogs += l.unitCost * l.currentQty; p.cogs += l.unitCost * l.currentQty; }
      byProduct.set(l.product, p);
    }
  }
  add("store_orders", orders.length);
  add("store_net_sales", net, true);
  add("store_gross_sales", gross, true);
  add("store_refunds", refunds, true);
  add("store_units", units);
  // COGS is written only when every line item that day has a recorded cost — otherwise profit would be overstated.
  if (cogsComplete) add("store_cogs", cogs, true);
  for (const [name, p] of byProduct) {
    add("store_net_sales", p.net, true, "product", name);
    add("store_gross_sales", p.gross, true, "product", name);
    add("store_units", p.units, false, "product", name);
    if (p.cogsComplete) add("store_cogs", p.cogs, true, "product", name);
  }
  for (const [name, c] of byCountry) { add("store_orders", c.orders, false, "country", name); add("store_net_sales", c.net, true, "country", name); }
  for (const [name, c] of byChannel) { add("store_orders", c.orders, false, "channel", name); add("store_net_sales", c.net, true, "channel", name); }

  // First-time customers can only be identified when the full order history is imported.
  if (fullHistory) {
    const ids = [...new Set(orders.map((o) => o.customerId).filter(Boolean))] as string[];
    if (ids.length) {
      const first = await ctx.db.query(
        `SELECT cid, min(first_at) AS first_at FROM (
           SELECT payload->>'customerId' AS cid, occurred_at AS first_at FROM source_records
            WHERE asset_id = $1 AND record_type = 'order' AND payload->>'customerId' = ANY($2::text[])
              AND NOT (payload->>'test')::boolean AND NOT (payload->>'cancelled')::boolean
           UNION ALL -- first orders whose records were removed by the retention policy
           SELECT customer_id, first_at FROM customer_first_orders WHERE asset_id = $1 AND customer_id = ANY($2::text[])
          ) f GROUP BY 1`,
        [ctx.asset.id, ids],
      );
      const firstAt = new Map(first.rows.map((r) => [r.cid, new Date(r.first_at).toISOString()]));
      add("store_new_customers", orders.filter((o) => o.customerId && firstAt.get(o.customerId) === new Date(o.createdAt).toISOString()).length);
    } else add("store_new_customers", 0);
  }
  return facts;
}

// ------------------------------------------------------------------ sync

async function fetchOrders(ctx: SyncContext, shop: string, token: string, search: string, onPage: (orders: NormalOrder[]) => Promise<void>) {
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const data: any = await gql(shop, token,
      `query($first: Int!, $after: String, $query: String) { orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`,
      { first: 50, after, query: search });
    const orders = data.orders.nodes.map(normalizeOrder);
    total += orders.length;
    await onPage(orders);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  ctx.log(`fetched ${total} orders (${search})`);
  return total;
}

async function storeOrders(ctx: SyncContext, orders: NormalOrder[], tz: string, affected: Set<string>) {
  const recs: SourceRecordInput[] = orders.map((o) => {
    const d = localDate(o.createdAt, tz);
    affected.add(d);
    return { recordType: "order", providerId: o.id, localDate: d, occurredAt: o.createdAt, sourceUpdatedAt: o.updatedAt, payload: o };
  });
  await upsertSourceRecords(ctx, recs);
}

async function syncShop(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const shop = String(ctx.connection.external_account_id);
  const tz = ctx.asset.timezone ?? "UTC";
  const today = todayIn(tz);
  const fullHistory = (ctx.connection.scopes ?? []).includes("read_all_orders");
  const cursor = ctx.asset.sync_cursor ?? {};
  const affected = new Set<string>();
  const notes: string[] = [];
  const startedAt = new Date();

  let coveredFrom: string = cursor.coveredFrom ?? null;
  let search: string;
  if (ctx.mode === "initial" || !cursor.coveredFrom) {
    // Without read_all_orders Shopify only exposes the last 60 days of orders.
    const days = fullHistory ? 730 : 60;
    coveredFrom = addDays(today, -days + 1);
    search = `created_at:>=${coveredFrom}`;
    if (!fullHistory) notes.push("Shopify returns only the last 60 days of orders unless the app is granted read_all_orders.");
  } else if (ctx.mode === "reconcile") {
    search = `created_at:>=${addDays(today, -ZERO_SAFE_RECONCILE_DAYS)}`;
  } else {
    // 10-minute overlap guards against clock skew and in-flight writes.
    const since = new Date(new Date(cursor.lastUpdatedAt ?? startedAt).getTime() - 10 * 60_000).toISOString();
    search = `updated_at:>=${since}`;
  }

  const count = await fetchOrders(ctx, shop, creds.access_token, search, (orders) => storeOrders(ctx, orders, tz, affected));

  // Recompute changed days, and every day since the last covered day (zero-order days are real zeros).
  const prevTo: string | null = cursor.coveredTo ?? null;
  const fill = datesBetween(ctx.mode === "initial" || !prevTo ? coveredFrom : addDays(prevTo, 1) <= today ? addDays(prevTo, 1) : today, today);
  if (ctx.mode === "reconcile") for (const d of datesBetween(addDays(today, -ZERO_SAFE_RECONCILE_DAYS), today)) affected.add(d);
  const dates = [...new Set([...affected, ...fill])].filter((d) => d >= coveredFrom && d <= today).sort();
  const recomputed = await replaceFacts(ctx, dates, (d) => computeDay(ctx, d, fullHistory), OWNED);
  await updateAssetCursor(ctx.db, ctx.asset.id, { coveredFrom, coveredTo: today, lastUpdatedAt: startedAt.toISOString() }, today);
  return { records: count, datesRecomputed: recomputed, coveredFrom, coveredTo: today, notes };
}

const ZERO_SAFE_RECONCILE_DAYS = 14;

// ------------------------------------------------------------------ webhooks

function verifyWebhook(req: any): VerifiedWebhook | null {
  const secret = process.env.SHOPIFY_API_SECRET;
  const raw: Buffer | undefined = req.rawBody;
  const sig = req.get("x-shopify-hmac-sha256");
  if (!secret || !raw || !sig) return null;
  const digest = createHmac("sha256", secret).update(raw).digest("base64");
  if (!safeEqual(digest, sig)) return null;
  const deliveryId = req.get("x-shopify-webhook-id");
  const topic = req.get("x-shopify-topic");
  const shop = req.get("x-shopify-shop-domain");
  if (!deliveryId || !topic || !shop) return null;
  return { deliveryId, topic, accountRef: shop, payload: JSON.parse(raw.toString("utf8") || "{}") };
}

async function handleWebhook(ctx: SyncContext, hook: VerifiedWebhook) {
  const p = hook.payload as any;
  const gid = p?.admin_graphql_api_id ?? (p?.order_id ? `gid://shopify/Order/${p.order_id}` : null);
  if (!hook.topic.startsWith("orders/") && hook.topic !== "refunds/create") return { datesRecomputed: 0 };
  if (!gid) return { datesRecomputed: 0 };
  // Re-fetch the order through the API instead of trusting the webhook body's shape.
  const creds = await ctx.credentials();
  const data: any = await gql(String(ctx.connection.external_account_id), creds.access_token, `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: gid });
  if (!data.order) return { datesRecomputed: 0 };
  const tz = ctx.asset.timezone ?? "UTC";
  const affected = new Set<string>();
  await storeOrders(ctx, [normalizeOrder(data.order)], tz, affected);
  const coveredFrom = ctx.asset.sync_cursor?.coveredFrom;
  const dates = [...affected].filter((d) => !coveredFrom || d >= coveredFrom);
  const n = await replaceFacts(ctx, dates, (d) => computeDay(ctx, d, (ctx.connection.scopes ?? []).includes("read_all_orders")), OWNED);
  return { datesRecomputed: n };
}

const WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE", "APP_UNINSTALLED"];

/** Rotates the expiring offline token. Credentials carry the shop domain so the generic refresher can call this. */
async function refreshCredentials(creds: Credentials) {
  if (!creds.refresh_token) throw new ProviderError("auth", "Shopify access expired. Reconnect the store.");
  if (creds.refresh_token_expires_at && new Date(creds.refresh_token_expires_at) < new Date()) throw new ProviderError("auth", "Shopify authorization expired. Reconnect the store.");
  const { data } = await providerFetch(`${shopBase(creds.shop)}/admin/oauth/access_token`, {
    provider: "Shopify",
    method: "POST",
    form: { client_id: process.env.SHOPIFY_API_KEY!, client_secret: process.env.SHOPIFY_API_SECRET!, grant_type: "refresh_token", refresh_token: creds.refresh_token },
    retries: 0, // single-use refresh tokens: never blindly replay
  });
  return {
    credentials: {
      ...creds,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? creds.refresh_token,
      refresh_token_expires_at: data.refresh_token_expires_in ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString() : creds.refresh_token_expires_at,
    },
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
  };
}

// ------------------------------------------------------------------ definition

export const shopify: ConnectorDefinition = {
  id: "shopify",
  name: "Shopify",
  category: "Commerce",
  description: "Orders, net sales, refunds, units, products, countries and (with product costs) gross profit.",
  implemented: true,
  configKeys: ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"],
  accessRequirements: [
    "Create an app in the Shopify Partner Dashboard (or Dev Dashboard) with redirect URL <API_URL>/api/oauth/shopify/callback.",
    "Order history older than 60 days requires Shopify to approve the read_all_orders scope for your app.",
    "Public apps must pass Shopify's protected customer data review to access customer fields (this connector stores only the opaque customer id).",
  ],
  scopes: [
    { scope: "read_orders", reason: "Orders, totals, refunds and line items" },
    { scope: "read_products", reason: "Product names for product breakdowns" },
    { scope: "read_inventory", reason: "Product unit costs for gross profit" },
    { scope: "read_all_orders", reason: "Order history beyond 60 days (needs Shopify approval)", optional: true },
  ],
  metrics: OWNED,
  actions: [],
  supportsWebhooks: true,
  reportingDelay: "Orders appear within minutes",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: ZERO_SAFE_RECONCILE_DAYS,
  docsUrl: "https://shopify.dev/docs/apps/build/authentication-authorization",
  connectFields: [{ key: "shop", label: "Store domain", placeholder: "your-store.myshopify.com", help: "Find it in Shopify admin → Settings → Domains." }],

  authorizeUrl({ state, redirectUri, input }) {
    const shop = normalizeShopDomain(input.shop ?? "");
    const scopes = [...SCOPES, ...(process.env.SHOPIFY_REQUEST_ALL_ORDERS === "true" ? OPTIONAL_SCOPES : [])];
    const q = new URLSearchParams({ client_id: process.env.SHOPIFY_API_KEY!, scope: scopes.join(","), redirect_uri: redirectUri, state });
    return `${shopBase(shop)}/admin/oauth/authorize?${q}`;
  },

  async handleCallback({ query, input }) {
    const secret = process.env.SHOPIFY_API_SECRET!;
    // 1. HMAC over the sorted query string (hmac removed), hex, constant-time compare.
    const { hmac, ...rest } = query;
    const message = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("&");
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    if (!hmac || !safeEqual(expected, hmac)) throw new ProviderError("permanent", "Shopify's response failed signature verification.");
    // 2. The shop must be a valid myshopify domain and the one the user entered.
    const shop = normalizeShopDomain(query.shop ?? "");
    if (input.shop && normalizeShopDomain(input.shop) !== shop) throw new ProviderError("permanent", "The store that responded doesn't match the store you entered.");
    if (!query.code) throw new ProviderError("permanent", "Shopify didn't return an authorization code.");
    // 3. Exchange the code for an expiring offline token.
    const { data } = await providerFetch(`${shopBase(shop)}/admin/oauth/access_token`, {
      provider: "Shopify",
      method: "POST",
      json: { client_id: process.env.SHOPIFY_API_KEY, client_secret: secret, code: query.code, expiring: 1 },
    });
    const creds: Credentials = {
      shop,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      refresh_token_expires_at: data.refresh_token_expires_in ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString() : null,
    };
    const shopInfo: any = await gql(shop, creds.access_token, `{ shop { name myshopifyDomain currencyCode ianaTimezone } }`);
    return {
      credentials: creds,
      scopes: String(data.scope ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      externalAccountId: shop,
      displayName: shopInfo.shop?.name ?? shop,
      tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
      settings: { shop },
    };
  },

  needsRefresh(creds, expiresAt) {
    return Boolean(creds.refresh_token && expiresAt && expiresAt.getTime() - Date.now() < 5 * 60_000);
  },

  refreshCredentials,

  async discoverAssets(creds, connection) {
    const shop = String(connection.external_account_id);
    const data: any = await gql(shop, creds.access_token, `{ shop { name myshopifyDomain currencyCode ianaTimezone } }`);
    return [{ providerAssetId: data.shop.myshopifyDomain, name: data.shop.name, kind: "store", currency: data.shop.currencyCode, timezone: data.shop.ianaTimezone }];
  },

  sync: syncShop,
  verifyWebhook,
  handleWebhook,

  async registerWebhooks(ctx, callbackUrl) {
    if (!callbackUrl.startsWith("https://")) return [];
    const creds = await ctx.credentials();
    const shop = String(ctx.connection.external_account_id);
    const created: string[] = [];
    for (const topic of WEBHOOK_TOPICS) {
      const r: any = await gql(shop, creds.access_token,
        `mutation($topic: WebhookSubscriptionTopic!, $uri: String!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) { webhookSubscription { id } userErrors { message } } }`,
        { topic, uri: callbackUrl });
      if (r.webhookSubscriptionCreate?.webhookSubscription?.id) created.push(topic);
    }
    return created;
  },

  async healthCheck(ctx) {
    const creds = await ctx.credentials();
    await gql(String(ctx.connection.external_account_id), creds.access_token, `{ shop { name } }`);
  },

  async revoke(creds, connection) {
    // Uninstalls the app from the store, revoking the token on Shopify's side.
    await providerFetch(`${shopBase(String(connection.external_account_id))}/admin/api_permissions/current.json`, {
      provider: "Shopify",
      method: "DELETE",
      headers: { "X-Shopify-Access-Token": creds.access_token },
      retries: 0,
    });
  },
};
