import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup, workspaceWithBusiness } from "./helpers.js";

let app: any;
let pool: any;
beforeAll(async () => {
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
});

async function demo() {
  const owner = await signup(app, "Demo");
  const { workspaceId, businessId: realBiz } = await workspaceWithBusiness(owner, "Real Co");
  const r = await owner.post(`/api/workspaces/${workspaceId}/demo-business`, {});
  expect(r.status).toBe(201);
  return { owner, workspaceId, realBiz, demoBiz: r.body.id as string };
}

const q = (c: any, biz: string, query: object, dashboardRange?: object) =>
  c.post(`/api/businesses/${biz}/metrics/query`, { query, dashboardRange });

describe("metric engine", () => {
  it("reconciles totals and breakdowns with the stored facts", async () => {
    const { owner, demoBiz } = await demo();
    const range = { from: "2026-01-01", to: "2026-01-31" };
    // Use a fixed historical range relative to the seeded window.
    const { rows: [span] } = await pool.query(`SELECT min(date)::text AS lo, max(date)::text AS hi FROM metric_facts WHERE business_id = $1`, [demoBiz]);
    const from = span.lo > range.from ? span.lo : range.from;
    const to = new Date(new Date(from).getTime() + 29 * 86400000).toISOString().slice(0, 10);

    const res = await q(owner, demoBiz, { metric: "store_net_sales", dateRange: { from, to }, comparison: "none" });
    expect(res.status).toBe(200);
    const { rows: [direct] } = await pool.query(
      `SELECT sum(value)::float8 AS v FROM metric_facts WHERE business_id = $1 AND metric_key = 'store_net_sales' AND dim_key = '' AND date BETWEEN $2 AND $3`,
      [demoBiz, from, to],
    );
    expect(res.body.total).toBeCloseTo(direct.v, 2);
    expect(res.body.availability).toBe("available");
    expect(res.body.isDemo).toBe(true);
    expect(res.body.sources[0].provider).toBe("shopify");

    // Breakdown by product sums to the total (seeded data splits exactly).
    const byProduct = await q(owner, demoBiz, { metric: "store_net_sales", dimension: "product", limit: 100, dateRange: { from, to }, comparison: "none" });
    const sum = byProduct.body.rows.reduce((s: number, r: any) => s + r.value, 0);
    expect(sum).toBeCloseTo(direct.v, 1);

    // Ratios use aggregated numerator ÷ denominator, not an average of daily ratios.
    const aov = await q(owner, demoBiz, { metric: "aov", dateRange: { from, to }, comparison: "none" });
    const orders = await q(owner, demoBiz, { metric: "store_orders", dateRange: { from, to }, comparison: "none" });
    expect(aov.body.total).toBeCloseTo(direct.v / orders.body.total, 6);
    expect(aov.body.metric.formula).toBe("Store net sales ÷ Orders");
  });

  it("reports missing data as unavailable, never zero", async () => {
    const owner = await signup(app, "Empty");
    const { businessId } = await workspaceWithBusiness(owner, "No Data Co");
    const res = await q(owner, businessId, { metric: "store_net_sales" });
    expect(res.body.availability).toBe("unavailable");
    expect(res.body.total).toBeNull();
    expect(res.body.unavailableReason).toMatch(/Connect Shopify/);
  });

  it("marks partial coverage and keeps comparisons honest", async () => {
    const { owner, demoBiz } = await demo();
    const { rows: [span] } = await pool.query(`SELECT min(date)::text AS lo FROM metric_facts WHERE business_id = $1`, [demoBiz]);
    const before = new Date(new Date(span.lo).getTime() - 10 * 86400000).toISOString().slice(0, 10);
    const after = new Date(new Date(span.lo).getTime() + 9 * 86400000).toISOString().slice(0, 10);
    const res = await q(owner, demoBiz, { metric: "sessions", dateRange: { from: before, to: after }, granularity: "day" });
    expect(res.body.availability).toBe("partial");
    expect(res.body.limitations.join(" ")).toMatch(/missing for 10 of 20 days/);
    // Days without data are null in the series, not 0.
    expect(res.body.series.slice(0, 10).every((p: any) => p.value === null)).toBe(true);
    expect(res.body.series[15].value).toBeGreaterThan(0);
    expect(res.body.comparisonTotal).toBeNull();
  });

  it("keeps attribution families separate and needs costs for profit", async () => {
    const { owner, demoBiz } = await demo();
    const mer = await q(owner, demoBiz, { metric: "mer", dateRange: { preset: "last_30_days" } });
    const sales = await q(owner, demoBiz, { metric: "store_net_sales", dateRange: { preset: "last_30_days" } });
    const spend = await q(owner, demoBiz, { metric: "ad_spend", dateRange: { preset: "last_30_days" } });
    expect(mer.body.total).toBeCloseTo(sales.body.total / spend.body.total, 6);
    const profit = await q(owner, demoBiz, { metric: "gross_profit", dateRange: { preset: "last_30_days" } });
    expect(profit.body.availability).not.toBe("unavailable"); // demo store records product costs
  });

  it("evaluates calculated metrics safely from aggregates", async () => {
    const { owner, demoBiz } = await demo();
    const bad = await owner.post(`/api/businesses/${demoBiz}/calculated-metrics`, { name: "x", expression: "process.exit()", unit: "number" });
    expect(bad.status).toBe(400);
    const ok = await owner.post(`/api/businesses/${demoBiz}/calculated-metrics`, { name: "Profit per order", expression: "({store_net_sales} - {store_cogs}) / {store_orders}", unit: "currency" });
    expect(ok.status).toBe(201);
    const r = await q(owner, demoBiz, { metric: ok.body.key, dateRange: { preset: "last_30_days" }, comparison: "none" });
    const net = (await q(owner, demoBiz, { metric: "store_net_sales", dateRange: { preset: "last_30_days" }, comparison: "none" })).body.total;
    const cogs = (await q(owner, demoBiz, { metric: "store_cogs", dateRange: { preset: "last_30_days" }, comparison: "none" })).body.total;
    const orders = (await q(owner, demoBiz, { metric: "store_orders", dateRange: { preset: "last_30_days" }, comparison: "none" })).body.total;
    expect(r.body.total).toBeCloseTo((net - cogs) / orders, 6);
  });

  it("rejects invalid widget queries", async () => {
    const { owner, demoBiz } = await demo();
    expect((await q(owner, demoBiz, { metric: "sessions", dimension: "deal_stage" })).status).toBe(400);
    expect((await q(owner, demoBiz, { metric: "DROP TABLE users" })).status).toBe(400);
  });
});

describe("demo mode", () => {
  it("never puts demo data into a real business", async () => {
    const { realBiz, workspaceId } = await demo();
    await expect(
      pool.query(`INSERT INTO connections (workspace_id, business_id, provider, display_name, is_demo) VALUES ($1, $2, 'shopify', 'x', true)`, [workspaceId, realBiz]),
    ).rejects.toThrow(/demo connections are only allowed in demo businesses/);
  });

  it("labels the demo business and seeds starter dashboards", async () => {
    const { owner, demoBiz } = await demo();
    const b = await owner.get(`/api/businesses/${demoBiz}`);
    expect(b.body.isDemo).toBe(true);
    expect(b.body.name).toMatch(/Demo/);
    const list = await owner.get(`/api/businesses/${demoBiz}/dashboards`);
    expect(list.body.map((d: any) => d.name)).toEqual(expect.arrayContaining(["Executive overview", "Ecommerce performance"]));
  });
});

describe("dashboards", () => {
  it("persists edits with versions, detects conflicts and restores", async () => {
    const { owner, demoBiz } = await demo();
    const created = await owner.post(`/api/businesses/${demoBiz}/dashboards`, { name: "Sales team", template: "ecommerce" });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const d1 = (await owner.get(`/api/businesses/${demoBiz}/dashboards/${id}`)).body;
    expect(d1.version).toBe(1);
    const original = d1.spec.widgets.length;

    const spec = { ...d1.spec, widgets: [...d1.spec.widgets, { id: "new1", type: "kpi", title: "Organic clicks", query: { metric: "organic_clicks" }, layout: { x: 0, y: 99, w: 3, h: 4 } }] };
    const save = await owner.put(`/api/businesses/${demoBiz}/dashboards/${id}`, { spec, expectedVersion: 1 });
    expect(save.body.version).toBe(2);
    // Stale save is rejected.
    const stale = await owner.put(`/api/businesses/${demoBiz}/dashboards/${id}`, { spec: d1.spec, expectedVersion: 1 });
    expect(stale.status).toBe(409);

    const d2 = (await owner.get(`/api/businesses/${demoBiz}/dashboards/${id}`)).body;
    expect(d2.spec.widgets.length).toBe(original + 1);
    expect(d2.spec.widgets.at(-1).title).toBe("Organic clicks");

    // Invalid widget is refused (unknown metric).
    const invalid = await owner.put(`/api/businesses/${demoBiz}/dashboards/${id}`, { spec: { ...spec, widgets: [{ ...spec.widgets[0], query: { metric: "fake" } }] }, expectedVersion: 2 });
    expect(invalid.status).toBe(400);

    const versions = (await owner.get(`/api/businesses/${demoBiz}/dashboards/${id}/versions`)).body;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    const restored = await owner.post(`/api/businesses/${demoBiz}/dashboards/${id}/versions/1/restore`, { expectedVersion: 2 });
    expect(restored.body.version).toBe(3);
    expect((await owner.get(`/api/businesses/${demoBiz}/dashboards/${id}`)).body.spec.widgets.length).toBe(original);
  });

  it("enforces visibility, sharing and roles", async () => {
    const { owner, workspaceId, demoBiz } = await demo();
    const viewer = await signup(app, "Viewer");
    const analyst = await signup(app, "Analyst");
    for (const [u, role] of [[viewer, "viewer"], [analyst, "analyst"]] as const) {
      const inv = await owner.post(`/api/workspaces/${workspaceId}/invitations`, { email: u.email, businessGrants: [{ businessId: demoBiz, role }] });
      await u.post(`/api/invites/${inv.body.inviteUrl.split("/invite/")[1]}/accept`);
    }
    const priv = await owner.post(`/api/businesses/${demoBiz}/dashboards`, { name: "Private board", visibility: "private" });
    const pid = priv.body.id;
    expect((await viewer.get(`/api/businesses/${demoBiz}/dashboards/${pid}`)).status).toBe(404);
    expect((await viewer.get(`/api/businesses/${demoBiz}/dashboards`)).body.find((d: any) => d.id === pid)).toBeUndefined();

    // Viewers can't be given edit rights; can be given view.
    expect((await owner.put(`/api/businesses/${demoBiz}/dashboards/${pid}/sharing`, { visibility: "private", shares: [{ userId: viewer.userId, canEdit: true }] })).status).toBe(400);
    expect((await owner.put(`/api/businesses/${demoBiz}/dashboards/${pid}/sharing`, { visibility: "private", shares: [{ userId: viewer.userId, canEdit: false }] })).status).toBe(200);
    const seen = await viewer.get(`/api/businesses/${demoBiz}/dashboards/${pid}`);
    expect(seen.status).toBe(200);
    expect(seen.body.canEdit).toBe(false);
    expect((await viewer.put(`/api/businesses/${demoBiz}/dashboards/${pid}`, { spec: seen.body.spec, expectedVersion: 1 })).status).toBe(403);
    // Analyst without a share can't see it; with business visibility they can edit.
    expect((await analyst.get(`/api/businesses/${demoBiz}/dashboards/${pid}`)).status).toBe(404);
    const pub = await owner.post(`/api/businesses/${demoBiz}/dashboards`, { name: "Team board" });
    const p2 = (await analyst.get(`/api/businesses/${demoBiz}/dashboards/${pub.body.id}`)).body;
    expect(p2.canEdit).toBe(true);
    // Can't share with someone outside the business.
    const outsider = await signup(app, "Outsider");
    expect((await owner.put(`/api/businesses/${demoBiz}/dashboards/${pid}/sharing`, { visibility: "private", shares: [{ userId: outsider.userId, canEdit: false }] })).status).toBe(400);
  });

  it("does not leak dashboards or metrics across businesses", async () => {
    const a = await demo();
    const b = await signup(app, "Other");
    const { businessId: otherBiz } = await workspaceWithBusiness(b, "Other Co");
    const list = await a.owner.get(`/api/businesses/${a.demoBiz}/dashboards`);
    const someId = list.body[0].id;
    expect((await b.get(`/api/businesses/${a.demoBiz}/dashboards/${someId}`)).status).toBe(404);
    expect((await b.get(`/api/businesses/${otherBiz}/dashboards/${someId}`)).status).toBe(404);
    expect((await q(b, a.demoBiz, { metric: "store_net_sales" })).status).toBe(404);
    // Querying their own business never returns the demo business's data.
    const own = await q(b, otherBiz, { metric: "store_net_sales" });
    expect(own.body.availability).toBe("unavailable");
  });
});
