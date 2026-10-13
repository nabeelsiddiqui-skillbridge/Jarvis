import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup, workspaceWithBusiness } from "./helpers.js";
import { startMockShopify, type MockState } from "./mock-shopify.js";

const SECRET = "test-shopify-secret";
const SHOP = "acme-outdoors.myshopify.com";
let app: any;
let pool: any;
let mock: { url: string; state: MockState; close: () => Promise<void> };
let runAll: () => Promise<number>;

beforeAll(async () => {
  mock = await startMockShopify();
  process.env.SHOPIFY_API_KEY = "test-key";
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.SHOPIFY_BASE_URL_OVERRIDE = mock.url;
  process.env.APP_URL = "http://app.test";
  process.env.API_URL = "https://api.example.test";
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
  const { claim } = await import("../src/jobs/queue.js");
  const { runJob } = await import("../src/jobs/handlers.js");
  // Run every due job inline (what the worker does), until the queue is empty.
  runAll = async () => {
    let n = 0;
    for (let job = await claim("test"); job; job = await claim("test")) {
      await runJob(job);
      n++;
    }
    return n;
  };
});
afterAll(async () => mock?.close());

const signQuery = (q: Record<string, string>) => {
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join("&");
  return { ...q, hmac: createHmac("sha256", SECRET).update(msg).digest("hex") };
};

async function connect(c: any, businessId: string) {
  const auth = await c.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: "acme-outdoors" } });
  expect(auth.status).toBe(200);
  const url = new URL(auth.body.url);
  expect(url.pathname).toBe(`/${SHOP}/admin/oauth/authorize`);
  expect(url.searchParams.get("scope")).toBe("read_orders,read_products,read_inventory");
  expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.test/api/oauth/shopify/callback");
  const state = url.searchParams.get("state")!;
  const q = signQuery({ code: "good-code", shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) });
  const cb = await c.get(`/api/oauth/shopify/callback?${new URLSearchParams(q)}`);
  expect(cb.status).toBe(302);
  const loc = new URL(cb.headers.location);
  expect(loc.searchParams.get("oauth_error")).toBeNull();
  return { connectionId: loc.searchParams.get("connection")!, state, query: q };
}

/** Expected per-day net sales straight from the mock's raw orders (shop timezone America/New_York). */
function expectedByDay(state: MockState) {
  const out = new Map<string, { net: number; orders: number }>();
  for (const o of state.orders) {
    if (o.test || o.cancelledAt) continue;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(o.createdAt));
    const e = out.get(day) ?? { net: 0, orders: 0 };
    e.net += o.currentSubtotal;
    e.orders += 1;
    out.set(day, e);
  }
  return out;
}

describe("Shopify connector (end to end against a local Shopify stand-in)", () => {
  let owner: any, businessId: string, connectionId: string;

  it("rejects tampered callbacks, reused state and other users", async () => {
    owner = await signup(app, "Owner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme Outdoors"));
    const auth = await owner.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: SHOP } });
    const state = new URL(auth.body.url).searchParams.get("state")!;
    // Bad HMAC.
    const bad = { ...signQuery({ code: "good-code", shop: SHOP, state, timestamp: "1" }), hmac: "deadbeef" };
    const r1 = await owner.get(`/api/oauth/shopify/callback?${new URLSearchParams(bad)}`);
    expect(new URL(r1.headers.location).searchParams.get("oauth_error")).toMatch(/signature/);
    // The state was consumed by that attempt: it can't be replayed.
    const replay = await owner.get(`/api/oauth/shopify/callback?${new URLSearchParams(signQuery({ code: "good-code", shop: SHOP, state, timestamp: "1" }))}`);
    expect(new URL(replay.headers.location).searchParams.get("oauth_error")).toMatch(/expired or was already used/);
    // A different user can't complete someone else's flow.
    const auth2 = await owner.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: SHOP } });
    const intruder = await signup(app, "Intruder");
    const st2 = new URL(auth2.body.url).searchParams.get("state")!;
    const r3 = await intruder.get(`/api/oauth/shopify/callback?${new URLSearchParams(signQuery({ code: "good-code", shop: SHOP, state: st2, timestamp: "1" }))}`);
    expect(new URL(r3.headers.location).searchParams.get("oauth_error")).toMatch(/same browser session/);
    // Invalid shop domains are refused before redirecting.
    expect((await owner.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: "evil.com/admin" } })).status).toBe(400);
  });

  it("authorizes, discovers the store, stores credentials encrypted", async () => {
    ({ connectionId } = await connect(owner, businessId));
    const list = await owner.get(`/api/businesses/${businessId}/connections`);
    const c = list.body.find((x: any) => x.id === connectionId);
    expect(c.status).toBe("selecting_assets");
    expect(c.accountName).toBe("Acme Outdoors");
    expect(c.assets).toHaveLength(1);
    expect(c.assets[0]).toMatchObject({ currency: "USD", timezone: "America/New_York", selected: false });
    expect(JSON.stringify(list.body)).not.toMatch(/shpat_|shprt_/);
    const { rows } = await pool.query("SELECT credentials_enc FROM connections WHERE id = $1", [connectionId]);
    expect(rows[0].credentials_enc).toMatch(/^v1:/);
    expect(rows[0].credentials_enc).not.toMatch(/shpat_/);
  });

  it("imports orders and the numbers reconcile with the source", async () => {
    const list = (await owner.get(`/api/businesses/${businessId}/connections`)).body;
    const assetId = list.find((x: any) => x.id === connectionId).assets[0].id;
    expect((await owner.put(`/api/businesses/${businessId}/connections/${connectionId}/assets`, { assetIds: [assetId] })).status).toBe(200);
    mock.state.fail.nextGraphql503 = 1; // transient outage: retried transparently
    mock.state.fail.throttleOnce = true; // cost throttle: waits and retries
    expect(await runAll()).toBeGreaterThan(0);

    const c = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === connectionId);
    expect(c.status).toBe("active");
    expect(c.latestJob.status).toBe("succeeded");
    expect(c.webhookTopics).toEqual(["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE", "APP_UNINSTALLED"]);

    const expected = expectedByDay(mock.state);
    const days = [...expected.keys()].sort();
    const from = days[0]!;
    const to = days[days.length - 1]!;
    const q = await owner.post(`/api/businesses/${businessId}/metrics/query`, { query: { metric: "store_net_sales", dateRange: { from, to }, granularity: "day", comparison: "none" } });
    expect(q.status).toBe(200);
    const total = [...expected.values()].reduce((s, e) => s + e.net, 0);
    expect(q.body.total).toBeCloseTo(total, 2);
    expect(q.body.availability).toBe("available");
    expect(q.body.isDemo).toBe(false);
    expect(q.body.sources[0].provider).toBe("shopify");
    // Per-day reconciliation, including zero-order days (real zeros, not gaps).
    for (const p of q.body.series) expect(p.value).toBeCloseTo(expected.get(p.bucket)?.net ?? 0, 2);
    expect(q.body.series.some((p: any) => p.value === 0)).toBe(true);
    const orders = await owner.post(`/api/businesses/${businessId}/metrics/query`, { query: { metric: "store_orders", dateRange: { from, to }, comparison: "none" } });
    expect(orders.body.total).toBe([...expected.values()].reduce((s, e) => s + e.orders, 0));
    // Before the import window there is no data: unavailable, not zero.
    const before = await owner.post(`/api/businesses/${businessId}/metrics/query`, { query: { metric: "store_net_sales", dateRange: { from: "2020-01-01", to: "2020-01-31" }, comparison: "none" } });
    expect(before.body.availability).toBe("unavailable");
  });

  it("processes webhooks once, verifies signatures, and updates facts", async () => {
    const order = mock.state.orders.find((o) => !o.test && !o.cancelledAt)!;
    order.currentSubtotal = Math.max(0, order.currentSubtotal - 20); // partial refund
    order.updatedAt = new Date().toISOString();
    const body = JSON.stringify({ admin_graphql_api_id: order.id });
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const send = (s: string, id = "delivery-1") =>
      request(app).post("/api/webhooks/shopify").set("Content-Type", "application/json")
        .set("X-Shopify-Hmac-Sha256", s).set("X-Shopify-Webhook-Id", id).set("X-Shopify-Topic", "orders/updated").set("X-Shopify-Shop-Domain", SHOP).send(body);
    expect((await send("forged")).status).toBe(401);
    expect((await send(sig)).status).toBe(200);
    const dup = await send(sig);
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect(await runAll()).toBe(1); // one job despite two deliveries

    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(order.createdAt));
    const q = await owner.post(`/api/businesses/${businessId}/metrics/query`, { query: { metric: "store_net_sales", dateRange: { from: day, to: day }, comparison: "none" } });
    expect(q.body.total).toBeCloseTo(expectedByDay(mock.state).get(day)!.net, 2);
    const receipts = await pool.query("SELECT status FROM webhook_receipts WHERE delivery_id = 'delivery-1'");
    expect(receipts.rows.map((r: any) => r.status)).toEqual(["processed"]);
  });

  it("re-running a sync is idempotent", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    const again = await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    expect(again.body.alreadyQueued).toBe(true); // de-duplicated while pending
    await runAll();
    const after = (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
    expect(after).toEqual(before);
  });

  it("refreshes expiring tokens with rotation, once", async () => {
    await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [connectionId]);
    const refreshesBefore = mock.state.calls.refresh;
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    expect(mock.state.calls.refresh).toBe(refreshesBefore + 1);
    const { rows } = await pool.query("SELECT token_expires_at FROM connections WHERE id = $1", [connectionId]);
    expect(new Date(rows[0].token_expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("flags revoked credentials as needing reconnection without retry storms", async () => {
    mock.state.tokens.clear(); // provider-side revocation
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    const c = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === connectionId);
    expect(c.status).toBe("reauth_required");
    expect(c.latestJob.status).toBe("failed");
    expect(c.lastError).toMatch(/Reconnect/);
    expect((await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`)).status).toBe(412);
    // Reconnecting restores the same connection (no duplicate).
    const auth = await owner.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: SHOP }, connectionId });
    const state = new URL(auth.body.url).searchParams.get("state")!;
    const cb = await owner.get(`/api/oauth/shopify/callback?${new URLSearchParams(signQuery({ code: "good-code", shop: SHOP, state, timestamp: "1" }))}`);
    expect(new URL(cb.headers.location).searchParams.get("reconnected")).toBe("1");
    const list = (await owner.get(`/api/businesses/${businessId}/connections`)).body;
    expect(list.filter((x: any) => x.provider === "shopify")).toHaveLength(1);
    expect(list[0].status).toBe("active");
  });

  it("keeps connections private to the business", async () => {
    const other = await signup(app, "Other");
    const { businessId: otherBiz } = await workspaceWithBusiness(other, "Other Co");
    expect((await other.get(`/api/businesses/${businessId}/connections`)).status).toBe(404);
    expect((await other.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`)).status).toBe(404);
    expect((await other.post(`/api/businesses/${otherBiz}/connections/${connectionId}/sync`)).status).toBe(404);
    expect((await other.del(`/api/businesses/${otherBiz}/connections/${connectionId}`)).status).toBe(404);
    const q = await other.post(`/api/businesses/${otherBiz}/metrics/query`, { query: { metric: "store_net_sales" } });
    expect(q.body.availability).toBe("unavailable");
  });

  it("disconnects, revokes at the provider and deletes data on request", async () => {
    const revokes = mock.state.calls.revoke;
    const r = await owner.del(`/api/businesses/${businessId}/connections/${connectionId}`, { deleteData: true });
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(true);
    expect(mock.state.calls.revoke).toBe(revokes + 1);
    const n = (await pool.query("SELECT count(*)::int AS n FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0].n;
    expect(n).toBe(0);
    const q = await owner.post(`/api/businesses/${businessId}/metrics/query`, { query: { metric: "store_net_sales" } });
    expect(q.body.availability).toBe("unavailable");
  });
});

describe("connector catalog", () => {
  it("labels configuration, availability and planned connectors honestly", async () => {
    const owner = await signup(app, "Cat");
    const { businessId } = await workspaceWithBusiness(owner, "Catalog Co");
    const cat = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    expect(cat.find((c: any) => c.id === "shopify").status).toBe("available");
    expect(cat.find((c: any) => c.id === "meta_ads").status).toBe("planned");
    delete process.env.SHOPIFY_API_SECRET;
    const cat2 = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    expect(cat2.find((c: any) => c.id === "shopify")).toMatchObject({ status: "config_required", missingConfig: ["SHOPIFY_API_SECRET"] });
    const blocked = await owner.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: SHOP } });
    expect(blocked.status).toBe(412);
    expect(blocked.body.error.message).toMatch(/SHOPIFY_API_SECRET/);
    process.env.SHOPIFY_API_SECRET = SECRET;
  });
});
