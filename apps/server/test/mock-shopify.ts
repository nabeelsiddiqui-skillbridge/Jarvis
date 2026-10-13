import express from "express";
import type { Server } from "node:http";
import { createHmac, randomBytes } from "node:crypto";

/**
 * A local stand-in for Shopify implementing the endpoints the connector uses:
 * OAuth token exchange + rotating refresh, GraphQL Admin (shop, orders with search
 * + cursor pagination, order by id, webhook subscription), cost-throttle
 * extensions, and permission revocation. Used only by automated tests.
 */

export interface MockLine { title: string; quantity: number; currentQuantity: number; price: number; discount: number; unitCost: number | null }
export interface MockOrder { id: string; createdAt: string; updatedAt: string; test: boolean; cancelledAt: string | null; customerId: string | null; country: string; subtotal: number; currentSubtotal: number; lines: MockLine[] }

export interface MockState {
  orders: MockOrder[];
  tokens: Set<string>;
  refreshTokens: Set<string>;
  calls: { refresh: number; graphql: number; revoke: number; webhooksCreated: string[] };
  /** Scopes reported for a custom-app token (currentAppInstallation). */
  appScopes?: string[];
  fail: { nextGraphql503: number; nextGraphql401: number; throttleOnce: boolean };
}

export function makeOrders(timezoneOffsetHours = -4, days = 40, seed = 1): MockOrder[] {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: MockOrder[] = [];
  const now = Date.now();
  let n = 1000;
  for (let d = days; d >= 0; d--) {
    const perDay = d % 9 === 4 ? 0 : 2 + Math.floor(r() * 4); // some days have no orders
    for (let i = 0; i < perDay; i++) {
      const created = new Date(now - d * 86400000 - Math.floor(r() * 20) * 3600000);
      const lines: MockLine[] = [];
      const nl = 1 + Math.floor(r() * 3);
      for (let k = 0; k < nl; k++) {
        const price = [25, 49, 89, 120][Math.floor(r() * 4)]!;
        const qty = 1 + Math.floor(r() * 2);
        lines.push({ title: ["Rain Jacket", "Daypack", "Socks", "Boots"][Math.floor(r() * 4)]!, quantity: qty, currentQuantity: qty, price, discount: r() < 0.3 ? 5 : 0, unitCost: d === 7 && k === 0 ? null : Math.round(price * 0.4) });
      }
      const subtotal = lines.reduce((t, l) => t + l.price * l.quantity - l.discount, 0);
      out.push({
        id: `gid://shopify/Order/${n++}`,
        createdAt: created.toISOString(),
        updatedAt: created.toISOString(),
        test: r() < 0.05,
        cancelledAt: r() < 0.05 ? created.toISOString() : null,
        customerId: `gid://shopify/Customer/${Math.floor(r() * 40)}`,
        country: r() < 0.7 ? "United States" : "Canada",
        subtotal,
        currentSubtotal: subtotal,
        lines,
      });
    }
  }
  void timezoneOffsetHours;
  return out;
}

const money = (v: number) => ({ shopMoney: { amount: v.toFixed(2), currencyCode: "USD" } });

function toNode(o: MockOrder) {
  return {
    id: o.id, name: `#${o.id.split("/").pop()}`, createdAt: o.createdAt, updatedAt: o.updatedAt, cancelledAt: o.cancelledAt, test: o.test,
    subtotalPriceSet: money(o.subtotal), currentSubtotalPriceSet: money(o.currentSubtotal),
    customer: o.customerId ? { id: o.customerId } : null,
    shippingAddress: { countryCodeV2: o.country === "Canada" ? "CA" : "US", country: o.country }, billingAddress: null,
    app: { name: "Online Store" },
    lineItems: { nodes: o.lines.map((l, i) => ({
      id: `${o.id}-L${i}`, title: l.title, quantity: l.quantity, currentQuantity: l.currentQuantity,
      originalTotalSet: { shopMoney: { amount: (l.price * l.quantity).toFixed(2) } },
      discountedTotalSet: { shopMoney: { amount: (l.price * l.quantity - l.discount).toFixed(2) } },
      product: { id: `gid://shopify/Product/${l.title.length}`, title: l.title },
      variant: { id: "v", inventoryItem: { unitCost: l.unitCost == null ? null : { amount: l.unitCost.toFixed(2) } } },
    })) },
  };
}

export function startMockShopify(): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { orders: makeOrders(), tokens: new Set(), refreshTokens: new Set(), calls: { refresh: 0, graphql: 0, revoke: 0, webhooksCreated: [] }, fail: { nextGraphql503: 0, nextGraphql401: 0, throttleOnce: false } };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const issue = () => {
    const access = `shpat_${randomBytes(8).toString("hex")}`;
    const refresh = `shprt_${randomBytes(8).toString("hex")}`;
    state.tokens.add(access);
    state.refreshTokens.add(refresh);
    return { access_token: access, scope: "read_orders,read_products,read_inventory", expires_in: 3600, refresh_token: refresh, refresh_token_expires_in: 7776000 };
  };

  // Stand-in for Shopify's install/consent page: a button that redirects back with a signed code.
  app.get("/:shop/admin/oauth/authorize", (req, res) => {
    const q: Record<string, string> = { code: "good-code", shop: req.params.shop, state: String(req.query.state), timestamp: String(Math.floor(Date.now() / 1000)) };
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&");
    const hmac = createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "").update(msg).digest("hex");
    const back = `${req.query.redirect_uri}?${new URLSearchParams({ ...q, hmac })}`;
    res.send(`<!doctype html><title>Install app — Shopify (test stand-in)</title><body style="font-family:sans-serif;padding:40px"><h1>Install Business Command AI?</h1><p>Requested: ${req.query.scope}</p><a id="install" href="${back}">Install app</a></body>`);
  });

  app.post("/:shop/admin/oauth/access_token", (req, res) => {
    const b = req.body;
    if (b.client_id !== process.env.SHOPIFY_API_KEY || b.client_secret !== process.env.SHOPIFY_API_SECRET) return res.status(401).json({ error: "invalid_client" });
    if (b.grant_type === "refresh_token") {
      if (!state.refreshTokens.has(b.refresh_token)) return res.status(400).json({ error: "invalid_grant" });
      state.refreshTokens.delete(b.refresh_token); // rotation: single use
      state.calls.refresh++;
      return res.json(issue());
    }
    if (b.code !== "good-code") return res.status(400).json({ error: "invalid_code" });
    if (String(b.expiring) !== "1") return res.status(400).json({ error: "expected expiring token request" });
    res.json(issue());
  });

  app.post("/:shop/admin/api/:version/graphql.json", (req, res) => {
    state.calls.graphql++;
    if (state.fail.nextGraphql503 > 0) { state.fail.nextGraphql503--; return res.status(503).send("unavailable"); }
    if (state.fail.nextGraphql401 > 0) { state.fail.nextGraphql401--; return res.status(401).json({ errors: "Invalid API key or access token" }); }
    const token = req.get("x-shopify-access-token");
    if (!token || !state.tokens.has(token)) return res.status(401).json({ errors: "Invalid API key or access token" });
    const ext = { cost: { requestedQueryCost: 50, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 } } };
    if (state.fail.throttleOnce) { state.fail.throttleOnce = false; return res.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 50, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 1000 } } } }); }
    const q: string = req.body.query;
    const v = req.body.variables ?? {};
    if (q.includes("webhookSubscriptionCreate")) { state.calls.webhooksCreated.push(v.topic); return res.json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${v.topic}` }, userErrors: [] } }, extensions: ext }); }
    if (q.includes("order(id:")) {
      const o = state.orders.find((x) => x.id === v.id);
      return res.json({ data: { order: o ? toNode(o) : null }, extensions: ext });
    }
    if (q.includes("orders(")) {
      const search: string = v.query ?? "";
      const m = /(created_at|updated_at):>=(\S+)/.exec(search);
      let list = [...state.orders];
      if (m) list = list.filter((o) => (m[1] === "created_at" ? o.createdAt : o.updatedAt) >= new Date(m[2]!).toISOString());
      list.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const start = v.after ? Number(v.after) : 0;
      const page = list.slice(start, start + (v.first ?? 50));
      return res.json({ data: { orders: { pageInfo: { hasNextPage: start + page.length < list.length, endCursor: String(start + page.length) }, nodes: page.map(toNode) } }, extensions: ext });
    }
    if (q.includes("shop")) {
      const installation = q.includes("currentAppInstallation") ? { currentAppInstallation: { accessScopes: (state.appScopes ?? ["read_orders", "read_products", "read_inventory"]).map((handle) => ({ handle })) } } : {};
      return res.json({ data: { shop: { name: "Acme Outdoors", myshopifyDomain: req.params.shop, currencyCode: "USD", ianaTimezone: "America/New_York" }, ...installation }, extensions: ext });
    }
    res.status(400).json({ errors: [{ message: "unsupported query" }] });
  });

  app.delete("/:shop/admin/api_permissions/current.json", (req, res) => {
    const token = req.get("x-shopify-access-token");
    if (token) state.tokens.delete(token);
    state.calls.revoke++;
    res.json({});
  });

  return new Promise((resolve) => {
    const server: Server = app.listen(Number(process.env.MOCK_SHOPIFY_PORT ?? 0), () => {
      const port = (server.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
