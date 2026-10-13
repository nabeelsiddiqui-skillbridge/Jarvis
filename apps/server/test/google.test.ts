import { addDays, todayIn } from "@bca/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup, workspaceWithBusiness } from "./helpers.js";
import { ADS_TZ, GA4_TZ, GSC_TZ, startMockGoogle, type GoogleState } from "./mock-providers.js";

let app: any;
let pool: any;
let mock: { url: string; state: GoogleState; close: () => Promise<void> };
let runAll: () => Promise<number>;

beforeAll(async () => {
  mock = await startMockGoogle();
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    GOOGLE_ADS_DEVELOPER_TOKEN: "test-dev-token",
    GOOGLE_BASE_URL_OVERRIDE: mock.url,
    APP_URL: "http://app.test",
    API_URL: "https://api.example.test",
  });
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
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

const query = (c: any, businessId: string, q: Record<string, unknown>) => c.post(`/api/businesses/${businessId}/metrics/query`, { query: { comparison: "none", ...q } });

/** Start OAuth, check the authorize URL, and complete the callback as Google would. */
async function connect(c: any, businessId: string, provider: string, scope: string, opts: { partial?: boolean } = {}) {
  const auth = await c.post(`/api/businesses/${businessId}/connections/${provider}/authorize`, { input: {} });
  expect(auth.status).toBe(200);
  const url = new URL(auth.body.url);
  expect(url.pathname).toBe("/accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("scope")).toBe(scope);
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("redirect_uri")).toBe(`https://api.example.test/api/oauth/${provider}/callback`);
  const code = `gcode.${Buffer.from(scope).toString("base64url")}${opts.partial ? ".partial" : ""}`;
  const cb = await c.get(`/api/oauth/${provider}/callback?${new URLSearchParams({ code, state: url.searchParams.get("state")!, scope })}`);
  expect(cb.status).toBe(302);
  const loc = new URL(cb.headers.location);
  return { connectionId: loc.searchParams.get("connection"), error: loc.searchParams.get("oauth_error") };
}

async function selectAssets(c: any, businessId: string, connectionId: string, pick: (a: any) => boolean) {
  const conn = (await c.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === connectionId);
  const ids = conn.assets.filter(pick).map((a: any) => a.id);
  expect((await c.put(`/api/businesses/${businessId}/connections/${connectionId}/assets`, { assetIds: ids })).status).toBe(200);
  return conn;
}

const sumBy = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => number) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
  return m;
};

describe("Google connectors (end to end against local Google stand-ins)", () => {
  let owner: any, businessId: string;

  it("lists the four Stage 4 connectors as implemented", async () => {
    owner = await signup(app, "Owner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme"));
    const cat = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    for (const id of ["ga4", "gsc", "google_ads", "hubspot"]) expect(cat.find((c: any) => c.id === id).status).not.toBe("planned");
    expect(cat.find((c: any) => c.id === "ga4").status).toBe("available");
    expect(cat.find((c: any) => c.id === "hubspot")).toMatchObject({ status: "config_required", missingConfig: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"] });
  });

  describe("GA4", () => {
    let connectionId: string;
    it("refuses a partial grant", async () => {
      const r = await connect(owner, businessId, "ga4", "https://www.googleapis.com/auth/analytics.readonly", { partial: true });
      expect(r.error).toMatch(/permissions weren't granted/);
    });

    it("authorizes and discovers properties with their own timezone, currency and available metrics", async () => {
      const r = await connect(owner, businessId, "ga4", "https://www.googleapis.com/auth/analytics.readonly");
      expect(r.error).toBeNull();
      connectionId = r.connectionId!;
      const conn = await selectAssets(owner, businessId, connectionId, (a) => a.name.startsWith("Acme Web"));
      expect(conn.assets).toHaveLength(2);
      expect(conn.assets.find((a: any) => a.name.startsWith("Acme Web"))).toMatchObject({ timezone: GA4_TZ, currency: "GBP" });
      expect(JSON.stringify(conn)).not.toMatch(/ya29\.|1\/\//);
    });

    it("imports daily reports that reconcile with the source, with real zero days", async () => {
      mock.state.fail.next503 = 1;
      await runAll();
      const conn = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === connectionId);
      expect(conn.status).toBe("active");
      expect(conn.latestJob.status).toBe("succeeded");

      const today = todayIn(GA4_TZ);
      const from = addDays(today, -120);
      const rows = mock.state.ga4.filter((r) => r.date >= from && r.date <= today);
      const byDay = sumBy(rows, (r) => r.date, (r) => r.m.sessions!);
      const q = await query(owner, businessId, { metric: "sessions", dateRange: { from, to: today }, granularity: "day" });
      expect(q.status).toBe(200);
      expect(q.body.availability).toBe("available");
      expect(q.body.total).toBe([...byDay.values()].reduce((a, b) => a + b, 0));
      for (const p of q.body.series) expect(p.value).toBe(byDay.get(p.bucket) ?? 0);
      expect(q.body.series.some((p: any) => p.value === 0)).toBe(true); // no-traffic day is a real zero
      expect(q.body.sources[0]).toMatchObject({ provider: "ga4", isDemo: false });

      const rev = await query(owner, businessId, { metric: "ga4_revenue", dateRange: { from, to: today } });
      expect(rev.body.total).toBeCloseTo(rows.reduce((s, r) => s + r.m.purchaseRevenue!, 0), 1);

      // Channel breakdown reconciles with the total; ratio metrics come from aggregates.
      const ch = await query(owner, businessId, { metric: "sessions", dimension: "channel", dateRange: { from, to: today }, limit: 20 });
      expect(ch.body.rows.reduce((s: number, r: any) => s + r.value, 0)).toBe(q.body.total);
      const er = await query(owner, businessId, { metric: "engagement_rate", dateRange: { from, to: today } });
      const engaged = rows.reduce((s, r) => s + r.m.engagedSessions!, 0);
      expect(er.body.total).toBeCloseTo((engaged / q.body.total) * 100, 6);

      // Before the import window: unavailable, never zero.
      const old = await query(owner, businessId, { metric: "sessions", dateRange: { from: "2020-01-01", to: "2020-01-31" } });
      expect(old.body.availability).toBe("unavailable");
    });

    it("refreshes expired access tokens and flags revoked access", async () => {
      await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [connectionId]);
      const before = mock.state.calls.refresh;
      await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
      await runAll();
      expect(mock.state.calls.refresh).toBe(before + 1);

      mock.state.accessTokens.clear();
      mock.state.refreshTokens.clear();
      await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [connectionId]);
      await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
      await runAll();
      const conn = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === connectionId);
      expect(conn.status).toBe("reauth_required");
      expect(conn.lastError).toMatch(/Reconnect/);
    });
  });

  describe("Search Console", () => {
    let connectionId: string;
    it("imports finalized days only, keeps omitted days unavailable and reconciles breakdowns", async () => {
      const r = await connect(owner, businessId, "gsc", "https://www.googleapis.com/auth/webmasters.readonly");
      expect(r.error).toBeNull();
      connectionId = r.connectionId!;
      const conn = await selectAssets(owner, businessId, connectionId, () => true);
      expect(conn.assets.map((a: any) => a.name)).toEqual(["Domain: example.com"]); // unverified sites excluded
      expect(conn.assets[0].timezone).toBe(GSC_TZ);
      await runAll();

      const today = todayIn(GSC_TZ);
      const lastFinal = addDays(today, -mock.state.gscLagDays);
      const from = addDays(today, -60);
      const rows = mock.state.gsc.filter((x) => x.date >= from && x.date <= lastFinal);
      const clicks = rows.reduce((s, x) => s + x.clicks, 0);
      const q = await query(owner, businessId, { metric: "organic_clicks", dateRange: { from, to: lastFinal }, granularity: "day" });
      expect(q.body.total).toBe(clicks);
      const omitted = q.body.series.filter((p: any) => p.value === null).map((p: any) => p.bucket);
      const dataDays = new Set(rows.map((x) => x.date));
      expect(omitted.every((d: string) => !dataDays.has(d))).toBe(true);
      expect(q.body.availability).toBe(omitted.length ? "partial" : "available");

      // Days Search Console hasn't finalized are unavailable, not zero.
      const recent = await query(owner, businessId, { metric: "organic_clicks", dateRange: { from: addDays(lastFinal, 1), to: today } });
      expect(recent.body.availability).toBe("unavailable");

      // Average position is impression-weighted from stored sums.
      const pos = await query(owner, businessId, { metric: "avg_position", dateRange: { from, to: lastFinal } });
      const imp = rows.reduce((s, x) => s + x.impressions, 0);
      expect(pos.body.total).toBeCloseTo(rows.reduce((s, x) => s + x.posSum, 0) / imp, 6);

      // Query breakdown + "(other / anonymized)" adds back up to the property total.
      const byQuery = await query(owner, businessId, { metric: "organic_clicks", dimension: "query", dateRange: { from, to: lastFinal }, limit: 100 });
      expect(byQuery.body.rows.reduce((s: number, x: any) => s + x.value, 0)).toBe(clicks);
      expect(byQuery.body.rows.some((x: any) => x.label === "(other / anonymized)")).toBe(true);
      const dev = await query(owner, businessId, { metric: "organic_impressions", dimension: "device", dateRange: { from, to: lastFinal } });
      expect(dev.body.rows.map((x: any) => x.label).sort()).toEqual(["desktop", "mobile"]);
    });

    it("re-running a sync is idempotent", async () => {
      const snap = async () => (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
      const before = await snap();
      await owner.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
      await runAll();
      expect(await snap()).toEqual(before);
    });
  });

  describe("Google Ads", () => {
    const SCOPE = "https://www.googleapis.com/auth/adwords";
    it("explains an unapproved developer token instead of failing vaguely", async () => {
      mock.state.adsTokenApproved = false;
      const r = await connect(owner, businessId, "google_ads", SCOPE);
      expect(r.error).toMatch(/developer token isn't approved/);
      mock.state.adsTokenApproved = true;
    });

    it("discovers client accounts (including via a manager) and reconciles spend per day", async () => {
      const r = await connect(owner, businessId, "google_ads", SCOPE);
      expect(r.error).toBeNull();
      const conn = await selectAssets(owner, businessId, r.connectionId!, (a) => a.name.startsWith("Acme US"));
      expect(conn.assets.map((a: any) => a.name).sort()).toEqual(["Acme EU (333-333-3333)", "Acme US (222-222-2222)"]); // manager itself excluded
      await runAll();
      const c2 = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === r.connectionId);
      expect(c2.latestJob.status).toBe("succeeded");

      const today = todayIn(ADS_TZ);
      const from = addDays(today, -90);
      const rows = mock.state.ads.filter((x) => x.customer === "2222222222" && x.date >= from && x.date <= today);
      const spendByDay = sumBy(rows, (x) => x.date, (x) => x.costMicros / 1e6);
      const q = await query(owner, businessId, { metric: "ad_spend", dateRange: { from, to: today }, granularity: "day" });
      expect(q.body.availability).toBe("available");
      for (const p of q.body.series) expect(p.value).toBeCloseTo(spendByDay.get(p.bucket) ?? 0, 1);
      expect(q.body.series.some((p: any) => p.value === 0)).toBe(true); // paused day = real zero
      expect(q.body.currency).toBe("USD");

      const camp = await query(owner, businessId, { metric: "ad_clicks", dimension: "campaign", dateRange: { from, to: today } });
      expect(camp.body.rows.map((x: any) => x.label).sort()).toEqual(["Brand Search", "Performance Max — All products", "Shopping — Jackets"]);
      expect(camp.body.rows.reduce((s: number, x: any) => s + x.value, 0)).toBe(rows.reduce((s, x) => s + x.clicks, 0));
      const roas = await query(owner, businessId, { metric: "roas", dateRange: { from, to: today } });
      expect(roas.body.total).toBeCloseTo(rows.reduce((s, x) => s + x.value, 0) / rows.reduce((s, x) => s + x.costMicros / 1e6, 0), 2);

      // The manager-linked account syncs only with login-customer-id (the stand-in enforces it).
      const all = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === r.connectionId);
      await owner.put(`/api/businesses/${businessId}/connections/${r.connectionId}/assets`, { assetIds: all.assets.map((a: any) => a.id) });
      await runAll();
      const eu = await pool.query(`SELECT count(*)::int AS n FROM metric_facts f JOIN connection_assets a ON a.id = f.asset_id WHERE a.provider_asset_id = '3333333333' AND f.currency = 'EUR'`);
      expect(eu.rows[0].n).toBeGreaterThan(0);
    });

    it("disconnects and revokes the Google grant", async () => {
      const conn = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.provider === "google_ads");
      const before = mock.state.calls.revoke;
      const r = await owner.del(`/api/businesses/${businessId}/connections/${conn.id}`, { deleteData: true });
      expect(r.status).toBe(200);
      expect(mock.state.calls.revoke).toBe(before + 1);
      const q = await query(owner, businessId, { metric: "ad_spend" });
      expect(q.body.availability).toBe("unavailable");
    });
  });
});
