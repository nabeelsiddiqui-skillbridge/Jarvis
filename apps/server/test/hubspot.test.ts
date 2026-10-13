import { createHmac } from "node:crypto";
import request from "supertest";
import { todayIn } from "@bca/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup, workspaceWithBusiness } from "./helpers.js";
import { HUBSPOT_TZ, startMockHubSpot, type HubSpotState } from "./mock-providers.js";

const SECRET = "test-hubspot-secret";
let app: any;
let pool: any;
let mock: { url: string; state: HubSpotState; close: () => Promise<void> };
let runAll: () => Promise<number>;

beforeAll(async () => {
  mock = await startMockHubSpot();
  Object.assign(process.env, {
    HUBSPOT_CLIENT_ID: "test-hubspot-client",
    HUBSPOT_CLIENT_SECRET: SECRET,
    HUBSPOT_BASE_URL_OVERRIDE: mock.url,
    APP_URL: "http://app.test",
    API_URL: "https://api.example.test",
  });
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
  // Exercise the 10k search-window restart with a small window.
  const { HUBSPOT_LIMITS } = await import("../src/connectors/hubspot/index.js");
  HUBSPOT_LIMITS.searchWindow = 400;
  mock.state.searchCap = 400;
  const { claim } = await import("../src/jobs/queue.js");
  const { runJob } = await import("../src/jobs/handlers.js");
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

const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: HUBSPOT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const query = (c: any, businessId: string, q: Record<string, unknown>) => c.post(`/api/businesses/${businessId}/metrics/query`, { query: { comparison: "none", ...q } });

function expected(s: HubSpotState, from: string, to: string) {
  const inRange = (iso: string | null) => iso != null && day(iso) >= from && day(iso) <= to;
  const firstQualified = (c: HubSpotState["contacts"][number]) => [c.mql, c.sql].filter(Boolean).sort()[0] ?? null;
  const won = s.deals.filter((d) => d.status === "won" && inRange(d.closedate));
  const open = s.deals.filter((d) => d.status === "open");
  return {
    contacts: s.contacts.filter((c) => inRange(c.createdate)).length,
    qualified: s.contacts.filter((c) => inRange(firstQualified(c))).length,
    created: s.deals.filter((d) => inRange(d.createdate)).length,
    won: won.length,
    lost: s.deals.filter((d) => d.status === "lost" && inRange(d.closedate)).length,
    wonValue: won.reduce((t, d) => t + (d.amount ?? 0), 0),
    openDeals: open.length,
    openValue: open.reduce((t, d) => t + (d.amount ?? 0), 0),
  };
}

function signWebhook(body: string, ts = String(Date.now())) {
  const uri = "https://api.example.test/api/webhooks/hubspot";
  return { ts, sig: createHmac("sha256", SECRET).update(`POST${uri}${body}${ts}`).digest("base64") };
}

describe("HubSpot connector (end to end against a local HubSpot stand-in)", () => {
  let owner: any, businessId: string, connectionId: string;

  it("authorizes and discovers the portal with its timezone and currency", async () => {
    owner = await signup(app, "Owner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme"));
    const auth = await owner.post(`/api/businesses/${businessId}/connections/hubspot/authorize`, { input: {} });
    expect(auth.status).toBe(200);
    const url = new URL(auth.body.url);
    expect(url.pathname).toBe("/app.hubspot.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("oauth crm.objects.contacts.read crm.objects.deals.read");
    const cb = await owner.get(`/api/oauth/hubspot/callback?${new URLSearchParams({ code: "hs-good-code", state: url.searchParams.get("state")! })}`);
    const loc = new URL(cb.headers.location);
    expect(loc.searchParams.get("oauth_error")).toBeNull();
    connectionId = loc.searchParams.get("connection")!;
    const conn = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === connectionId);
    expect(conn.assets[0]).toMatchObject({ timezone: HUBSPOT_TZ, currency: "USD" });
    expect(JSON.stringify(conn)).not.toMatch(/hs-at-|hs-rt-/);
    await owner.put(`/api/businesses/${businessId}/connections/${connectionId}/assets`, { assetIds: [conn.assets[0].id] });
  });

  it("imports contacts and deals; CRM metrics reconcile with the source", async () => {
    await runAll();
    const conn = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === connectionId);
    expect(conn.latestJob.status).toBe("succeeded");
    const today = todayIn(HUBSPOT_TZ);
    const from: string = (await pool.query("SELECT sync_cursor->>'coveredFrom' AS f FROM connection_assets WHERE connection_id = $1", [connectionId])).rows[0].f;
    const e = expected(mock.state, from, today);
    const total = async (metric: string, extra: Record<string, unknown> = {}) => (await query(owner, businessId, { metric, dateRange: { from, to: today }, ...extra })).body;

    expect((await total("crm_new_contacts")).total).toBe(e.contacts);
    expect((await total("crm_qualified_leads")).total).toBe(e.qualified);
    expect((await total("crm_deals_created")).total).toBe(e.created);
    expect((await total("crm_deals_won")).total).toBe(e.won);
    expect((await total("crm_deals_lost")).total).toBe(e.lost);
    expect((await total("crm_won_value")).total).toBeCloseTo(e.wonValue, 2);
    const wr = await total("win_rate");
    expect(wr.total).toBeCloseTo((e.won / (e.won + e.lost)) * 100, 6);

    // Breakdowns reconcile; no personal data is stored.
    const bySource = await total("crm_new_contacts", { dimension: "source_medium", limit: 20 });
    expect(bySource.rows.reduce((s: number, r: any) => s + r.value, 0)).toBe(e.contacts);
    expect(bySource.rows.map((r: any) => r.label)).toContain("Organic search");
    const byPipeline = await total("crm_deals_won", { dimension: "pipeline" });
    expect(byPipeline.rows.map((r: any) => r.label).sort()).toEqual(["Sales Pipeline", "Wholesale"]);
    const sample = (await pool.query("SELECT payload FROM source_records WHERE connection_id = $1 AND record_type = 'contact' LIMIT 1", [connectionId])).rows[0].payload;
    expect(Object.keys(sample).sort()).toEqual(["created", "kind", "qualified", "source", "stage"]);

    // Open pipeline is a snapshot for today only, including old open deals; history isn't invented.
    const pipe = await query(owner, businessId, { metric: "crm_open_pipeline", dateRange: { from: today, to: today } });
    expect(pipe.body.total).toBeCloseTo(e.openValue, 2);
    expect((await query(owner, businessId, { metric: "crm_open_deals", dateRange: { from: today, to: today } })).body.total).toBe(e.openDeals);
    const pipeMonth = await query(owner, businessId, { metric: "crm_open_pipeline", dateRange: { preset: "last_30_days" } });
    expect(pipeMonth.body.availability).not.toBe("available");
    const byStage = await query(owner, businessId, { metric: "crm_open_deals", dimension: "deal_stage", dateRange: { from: today, to: today } });
    expect(byStage.body.rows.reduce((s: number, r: any) => s + r.value, 0)).toBe(e.openDeals);
  });

  it("verifies webhook signatures, de-duplicates and re-fetches changed deals", async () => {
    const deal = mock.state.deals.find((d) => d.status === "open" && d.amount != null)!;
    const before = expected(mock.state, todayIn(HUBSPOT_TZ), todayIn(HUBSPOT_TZ));
    deal.status = "won";
    deal.dealstage = deal.pipeline === "default" ? "closedwon" : "wwon";
    deal.closedate = new Date().toISOString();
    deal.lastmodifieddate = new Date().toISOString();
    const body = JSON.stringify([{ eventId: 777, subscriptionId: 1, portalId: 4455667, appId: 1, occurredAt: Date.now(), subscriptionType: "deal.propertyChange", attemptNumber: 0, objectId: Number(deal.id), propertyName: "dealstage", propertyValue: "closedwon" }]);
    const send = (sig: string, ts: string) => request(app).post("/api/webhooks/hubspot").set("Content-Type", "application/json").set("X-HubSpot-Signature-v3", sig).set("X-HubSpot-Request-Timestamp", ts).send(body);
    const { ts, sig } = signWebhook(body);
    expect((await send("forged", ts)).status).toBe(401);
    const stale = signWebhook(body, String(Date.now() - 10 * 60_000));
    expect((await send(stale.sig, stale.ts)).status).toBe(401); // replay window
    expect((await send(sig, ts)).status).toBe(200);
    expect((await send(sig, ts)).body.duplicate).toBe(true);
    expect(await runAll()).toBe(1);

    const today = todayIn(HUBSPOT_TZ);
    const after = expected(mock.state, today, today);
    expect(after.openDeals).toBe(before.openDeals - 1);
    const won = await query(owner, businessId, { metric: "crm_deals_won", dateRange: { from: today, to: today } });
    expect(won.body.total).toBe(after.won);
    const open = await query(owner, businessId, { metric: "crm_open_deals", dateRange: { from: today, to: today } });
    expect(open.body.total).toBe(after.openDeals);
  });

  it("incremental syncs only fetch changes and are idempotent", async () => {
    const snap = async () => (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
    const before = await snap();
    const searches = mock.state.calls.search;
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    expect(mock.state.calls.search - searches).toBeLessThanOrEqual(2);
    expect(await snap()).toEqual(before);
  });

  it("refreshes the 30-minute access token and revokes on disconnect", async () => {
    await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [connectionId]);
    const refreshes = mock.state.calls.refresh;
    await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
    await runAll();
    expect(mock.state.calls.refresh).toBe(refreshes + 1);
    const r = await owner.del(`/api/businesses/${businessId}/connections/${connectionId}`, { deleteData: true });
    expect(r.body.revoked).toBe(true);
    expect(mock.state.calls.revoke).toBe(1);
    expect(mock.state.refreshTokens.size).toBe(0);
  });
});
