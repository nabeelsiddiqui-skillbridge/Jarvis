import { addDays, todayIn } from "@bca/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup } from "./helpers.js";
import { startMockAnthropic, type MockAnthropicState } from "./mock-anthropic.js";

let app: any;
let pool: any;
let llm: { url: string; state: MockAnthropicState; close: () => Promise<void> };
let runAll: () => Promise<number>;

beforeAll(async () => {
  llm = await startMockAnthropic((body) => {
    const sys = body.system?.[0]?.text ?? "";
    const text = sys.includes('Start with "Possible explanations:"')
      ? "Possible explanations: a stock-out on jackets [I1], or a paused campaign. Check inventory and campaign status."
      : sys.includes("summarize what this dashboard shows")
        ? "Net sales fell sharply [C1]; check jackets."
        : "Sales were weaker than the previous period [R1].\n- Jackets drove the drop [R1]";
    return { stop_reason: "end_turn", content: [{ type: "text", text }] };
  });
  Object.assign(process.env, { ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_BASE_URL: llm.url });
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
  const { claim } = await import("../src/jobs/queue.js");
  const { runJob } = await import("../src/jobs/handlers.js");
  runAll = async () => {
    let n = 0;
    for (let job = await claim("test"); job; job = await claim("test")) { await runJob(job); n++; }
    return n;
  };
});
afterAll(async () => llm?.close());

/** A business with Shopify-like facts: a steady baseline, then a sharp 7-day drop driven by one product, and an anomalous yesterday. */
async function seedBusiness(owner: any) {
  const ws = (await owner.post("/api/workspaces", { name: "Acme WS" })).body.id;
  const businessId = (await owner.post(`/api/workspaces/${ws}/businesses`, { name: "Acme", industry: "ecommerce", timezone: "UTC", currency: "USD" })).body.id;
  const c = (await pool.query(`INSERT INTO connections (workspace_id, business_id, provider, display_name, status, last_success_at) VALUES ($1, $2, 'shopify', 'Acme Store', 'active', now()) RETURNING id`, [ws, businessId])).rows[0].id;
  const a = (await pool.query(`INSERT INTO connection_assets (workspace_id, business_id, connection_id, provider_asset_id, name, kind, currency, timezone, selected, latest_data_date, last_synced_at) VALUES ($1, $2, $3, 'acme.myshopify.com', 'Acme Store', 'store', 'USD', 'UTC', true, $4, now()) RETURNING id`, [ws, businessId, c, todayIn("UTC")])).rows[0].id;
  const today = todayIn("UTC");
  const rows: any[] = [];
  const day = (d: number) => {
    if (d === 1) return { jackets: 50, boots: 100 };
    if (d <= 7) return { jackets: 300, boots: 300 };
    return { jackets: 700 + (d % 5) * 20, boots: 300 };
  };
  for (let d = 0; d <= 70; d++) {
    const date = addDays(today, -d);
    const v = day(d);
    rows.push(["store_net_sales", date, "", "", v.jackets + v.boots], ["store_net_sales", date, "product", "Jackets", v.jackets], ["store_net_sales", date, "product", "Boots", v.boots], ["store_orders", date, "", "", 20]);
  }
  for (const [metric, date, dk, dv, value] of rows) {
    await pool.query(`INSERT INTO metric_facts (workspace_id, business_id, connection_id, asset_id, provider, metric_key, date, dim_key, dim_value, value, currency) VALUES ($1, $2, $3, $4, 'shopify', $5, $6, $7, $8, $9, $10)`,
      [ws, businessId, c, a, metric, date, dk, dv, value, metric === "store_net_sales" ? "USD" : null]);
  }
  return { ws, businessId, connectionId: c, expected: { last7: [1, 2, 3, 4, 5, 6, 7].reduce((s, d) => s + day(d).jackets + day(d).boots, 0), prev7: [8, 9, 10, 11, 12, 13, 14].reduce((s, d) => s + day(d).jackets + day(d).boots, 0) } };
}

async function member(ws: string, businessId: string, role: "analyst" | "viewer" | "admin") {
  const u = await signup(app, role[0]!.toUpperCase() + role.slice(1));
  await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [ws, u.userId]);
  await pool.query(`INSERT INTO business_memberships (workspace_id, business_id, user_id, role) VALUES ($1, $2, $3, $4)`, [ws, businessId, u.userId, role]);
  return u;
}

describe("insights (deterministic detection)", () => {
  let owner: any, ws: string, businessId: string, connectionId: string, expected: any, viewer: any, analyst: any;

  it("detects a significant drop with exact figures, drivers, impact and next step", async () => {
    owner = await signup(app, "Owner");
    ({ ws, businessId, connectionId, expected } = await seedBusiness(owner));
    viewer = await member(ws, businessId, "viewer");
    analyst = await member(ws, businessId, "analyst");
    expect((await viewer.post(`/api/businesses/${businessId}/insights/detect`, {})).status).toBe(403);
    const r = await owner.post(`/api/businesses/${businessId}/insights/detect`, {});
    expect(r.status).toBe(200);
    expect(r.body.created).toBeGreaterThanOrEqual(2);

    const list = (await viewer.get(`/api/businesses/${businessId}/insights`)).body.insights;
    const drop = list.find((i: any) => i.rule === "period_change" && i.metricKey === "store_net_sales");
    expect(drop).toBeTruthy();
    const change = ((expected.last7 - expected.prev7) / expected.prev7) * 100;
    expect(drop.severity).toBe(Math.abs(change) >= 40 ? "critical" : "warning");
    expect(drop.title).toMatch(/Store net sales down/);
    expect(drop.finding).toContain(`$${expected.last7.toLocaleString("en-US")}`);
    expect(drop.finding).toContain(`$${expected.prev7.toLocaleString("en-US")}`);
    expect(drop.evidence[0]).toMatchObject({ kind: "metric", total: expected.last7, comparisonTotal: expected.prev7, availability: "available" });
    expect(drop.drivers[0]).toMatchObject({ dimension: "product", label: "Jackets" });
    expect(drop.impact).toMatch(/less store net sales/);
    expect(drop.impact).toMatch(/Jackets/);
    expect(drop.nextStep).toBeTruthy();
    expect(drop.period).toEqual({ from: addDays(todayIn("UTC"), -7), to: addDays(todayIn("UTC"), -1) });

    const anomaly = list.find((i: any) => i.rule === "anomaly" && i.metricKey === "store_net_sales");
    expect(anomaly.finding).toMatch(/standard deviations/);
    // AOV (net sales ÷ orders) also fell, with enough orders behind it.
    expect(list.some((i: any) => i.metricKey === "aov")).toBe(true);
  });

  it("re-detection updates instead of duplicating, and dismissed findings stay closed", async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM insights WHERE business_id = $1`, [businessId])).rows[0].n;
    const r = await owner.post(`/api/businesses/${businessId}/insights/detect`, {});
    expect(r.body.created).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM insights WHERE business_id = $1`, [businessId])).rows[0].n).toBe(before);
    const anomaly = (await owner.get(`/api/businesses/${businessId}/insights`)).body.insights.find((i: any) => i.rule === "anomaly");
    expect((await viewer.patch(`/api/businesses/${businessId}/insights/${anomaly.id}`, { status: "dismissed" })).status).toBe(403);
    expect((await analyst.patch(`/api/businesses/${businessId}/insights/${anomaly.id}`, { status: "dismissed" })).body.status).toBe("dismissed");
    await owner.post(`/api/businesses/${businessId}/insights/detect`, {});
    expect((await owner.get(`/api/businesses/${businessId}/insights/${anomaly.id}`)).body.status).toBe("dismissed");
  });

  it("adds AI explanations as a separate, labelled step", async () => {
    await runAll();
    const drop = (await owner.get(`/api/businesses/${businessId}/insights`)).body.insights.find((i: any) => i.rule === "period_change" && i.metricKey === "store_net_sales");
    expect(drop.explanationStatus).toBe("ready");
    expect(drop.explanation).toMatch(/^Possible explanations:/);
    // The model got the insight's evidence, not database access.
    const req = llm.state.requests.find((r) => r.body.messages[0].content.includes("Store net sales down"))!;
    expect(req.body.tools).toBeUndefined();
    expect(JSON.parse(req.body.messages[0].content).evidence[0].total).toBe(expected.last7);
  });

  it("flags connection problems and resolves them when the connection recovers", async () => {
    await pool.query(`UPDATE connections SET status = 'reauth_required', last_error = 'Shopify rejected the credentials.' WHERE id = $1`, [connectionId]);
    await owner.post(`/api/businesses/${businessId}/insights/detect`, {});
    let health = (await owner.get(`/api/businesses/${businessId}/insights`)).body.insights.find((i: any) => i.rule === "data_health");
    expect(health).toMatchObject({ severity: "critical", title: "Acme Store needs to be reconnected" });
    await pool.query(`UPDATE connections SET status = 'active', last_error = NULL WHERE id = $1`, [connectionId]);
    await owner.post(`/api/businesses/${businessId}/insights/detect`, {});
    health = (await owner.get(`/api/businesses/${businessId}/insights/${health.id}`)).body;
    expect(health.status).toBe("resolved");
  });

  it("tracks goal pacing against user-confirmed goals", async () => {
    await pool.query(`INSERT INTO business_goals (workspace_id, business_id, title, metric_key, target_value, period) VALUES ($1, $2, 'Sell $100k this month', 'store_net_sales', 100000, 'month')`, [ws, businessId]);
    await owner.post(`/api/businesses/${businessId}/insights/detect`, {});
    const g = (await owner.get(`/api/businesses/${businessId}/insights`)).body.insights.find((i: any) => i.rule === "goal_pacing");
    const dom = Number(todayIn("UTC").slice(8, 10));
    if (dom >= 6) {
      expect(g).toBeTruthy();
      expect(g.title).toMatch(/Behind pace/);
    } else expect(g).toBeUndefined(); // too early in the month to judge
  });

  it("keeps insights inside the business", async () => {
    const other = await signup(app, "Other");
    expect((await other.get(`/api/businesses/${businessId}/insights`)).status).toBe(404);
    const id = (await pool.query(`SELECT id FROM insights WHERE business_id = $1 LIMIT 1`, [businessId])).rows[0].id;
    expect((await other.patch(`/api/businesses/${businessId}/insights/${id}`, { status: "resolved" })).status).toBe(404);
  });

  describe("automations", () => {
    it("validates the builder input", async () => {
      const bad = await owner.post(`/api/businesses/${businessId}/automations`, { name: "x", kind: "daily_briefing", trigger: { type: "schedule", frequency: "weekly", hour: 8 } });
      expect(bad.status).toBe(400);
      const bad2 = await owner.post(`/api/businesses/${businessId}/automations`, { name: "x", kind: "threshold_alert", trigger: { type: "schedule", frequency: "daily" }, conditions: { metric: "nope", test: "above", value: 1 } });
      expect(bad2.status).toBe(400);
      const outsider = await signup(app, "Outsider");
      const bad3 = await owner.post(`/api/businesses/${businessId}/automations`, { name: "x", kind: "daily_briefing", trigger: { type: "schedule", frequency: "daily", hour: 8 }, actions: { notify: { userIds: [outsider.userId] } } });
      expect(bad3.status).toBe(400);
      expect((await viewer.post(`/api/businesses/${businessId}/automations`, { name: "x", kind: "daily_briefing", trigger: { type: "schedule", frequency: "daily", hour: 8 } })).status).toBe(403);
    });

    it("daily briefing: scheduled next run, run now, report with evidence, notification, no duplicates", async () => {
      const a = await owner.post(`/api/businesses/${businessId}/automations`, { name: "Morning briefing", kind: "daily_briefing", trigger: { type: "schedule", frequency: "daily", hour: 7, minute: 30 }, timezone: "America/New_York" });
      expect(a.status).toBe(201);
      const next = new Date(a.body.nextRunAt);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next)).toBe("07:30");
      const r1 = await owner.post(`/api/businesses/${businessId}/automations/${a.body.id}/run`, {});
      const r2 = await owner.post(`/api/businesses/${businessId}/automations/${a.body.id}/run`, {});
      expect(r1.body.runId).toBeTruthy();
      expect(r2.body.duplicate).toBe(true);
      await runAll();
      const runs = (await owner.get(`/api/businesses/${businessId}/automations/${a.body.id}/runs`)).body;
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("succeeded");
      const report = (await viewer.get(`/api/businesses/${businessId}/reports/${runs[0].output.reportId}`)).body;
      expect(report.kind).toBe("daily_briefing");
      const y = addDays(todayIn("UTC"), -1);
      expect(report.period).toEqual({ from: y, to: y });
      const sales = report.content.headline.find((h: any) => h.metric.key === "store_net_sales" && h.range.from === y);
      expect(sales.total).toBe(150);
      expect(report.content.deterministicSummary[0]).toMatch(/Store net sales: \$150/);
      expect(report.narrativeStatus).toBe("ready");
      expect(report.narrative).toMatch(/\[R1\]/);
      expect(report.content.insights.length).toBeGreaterThan(0);
      const notes = (await owner.get(`/api/notifications`)).body;
      expect(notes.items.some((n: any) => n.title === "Daily briefing for Acme" && n.link.endsWith(`/reports/${report.id}`))).toBe(true);
      expect(runs[0].output.emailSkipped).toBeUndefined(); // email not requested
    });

    it("approval policy holds actions until an administrator approves", async () => {
      const a = await owner.post(`/api/businesses/${businessId}/automations`, { name: "Weekly to the team", kind: "weekly_report", trigger: { type: "schedule", frequency: "weekly", weekday: 1, hour: 9 }, approvalPolicy: "approval_required", actions: { notify: { userIds: [analyst.userId], email: true } } });
      await owner.post(`/api/businesses/${businessId}/automations/${a.body.id}/run`, {});
      await runAll();
      const run = (await owner.get(`/api/businesses/${businessId}/automations/${a.body.id}/runs`)).body[0];
      expect(run.status).toBe("awaiting_approval");
      expect(run.output.reportId).toBeTruthy(); // the report exists; delivery is held
      expect((await analyst.get(`/api/notifications`)).body.items.filter((n: any) => n.kind === "automation")).toHaveLength(0);
      expect((await owner.get(`/api/notifications`)).body.items.some((n: any) => n.kind === "approval")).toBe(true);
      expect((await analyst.post(`/api/businesses/${businessId}/automation-runs/${run.id}/approve`, {})).status).toBe(403);
      const ok = await owner.post(`/api/businesses/${businessId}/automation-runs/${run.id}/approve`, {});
      expect(ok.body.status).toBe("succeeded");
      expect((await owner.post(`/api/businesses/${businessId}/automation-runs/${run.id}/approve`, {})).status).toBe(409);
      const after = (await owner.get(`/api/businesses/${businessId}/automation-runs/${run.id}`)).body;
      expect(after.output.emailSkipped).toMatch(/SMTP_URL/);
      expect((await analyst.get(`/api/notifications`)).body.items.filter((n: any) => n.kind === "automation")).toHaveLength(1);
    });

    it("threshold alert: creates an insight + task when met, nothing when not", async () => {
      const make = (value: number) => owner.post(`/api/businesses/${businessId}/automations`, { name: `Sales below ${value}`, kind: "threshold_alert", trigger: { type: "schedule", frequency: "daily", hour: 6 }, conditions: { metric: "store_net_sales", window: "yesterday", test: "below", value }, actions: { notify: { userIds: [] }, task: { assigneeId: analyst.userId } } });
      const met = (await make(500)).body;
      const notMet = (await make(100)).body;
      await owner.post(`/api/businesses/${businessId}/automations/${met.id}/run`, {});
      await owner.post(`/api/businesses/${businessId}/automations/${notMet.id}/run`, {});
      await runAll();
      const r1 = (await owner.get(`/api/businesses/${businessId}/automations/${met.id}/runs`)).body[0];
      const r2 = (await owner.get(`/api/businesses/${businessId}/automations/${notMet.id}/runs`)).body[0];
      expect(r1.output.summary).toMatch(/Alert: Store net sales below \$500/);
      expect(r1.output.insightIds).toHaveLength(1);
      expect(r1.output.taskIds).toHaveLength(1);
      expect(r2.output.summary).toMatch(/Condition not met/);
      const tasks = (await analyst.get(`/api/businesses/${businessId}/tasks`)).body;
      const t = tasks.find((x: any) => x.id === r1.output.taskIds[0]);
      expect(t).toMatchObject({ assigneeId: analyst.userId, source: "automation" });
      // The assignee can complete it, but a viewer can't edit others' tasks.
      expect((await viewer.patch(`/api/businesses/${businessId}/tasks/${t.id}`, { status: "done" })).status).toBe(404);
      expect((await analyst.patch(`/api/businesses/${businessId}/tasks/${t.id}`, { status: "done" })).body.status).toBe("done");
    });

    it("connection failure alerts fire once per connection, status and day", async () => {
      const a = (await owner.post(`/api/businesses/${businessId}/automations`, { name: "Connection alerts", kind: "connection_alert", trigger: { type: "event", event: "connection_failed" } })).body;
      expect(a.nextRunAt).toBeNull();
      expect((await owner.post(`/api/businesses/${businessId}/automations/${a.id}/run`, {})).status).toBe(400);
      const { fireEvent } = await import("../src/automations/engine.js");
      const { withSystem } = await import("../src/db/pool.js");
      const info = { connectionId, provider: "shopify", name: "Acme Store", status: "reauth_required", error: "Shopify rejected the credentials." };
      await withSystem((db: any) => fireEvent(db, businessId, "connection_failed", info, `${connectionId}:reauth_required:2026-10-13`));
      await withSystem((db: any) => fireEvent(db, businessId, "connection_failed", info, `${connectionId}:reauth_required:2026-10-13`));
      await runAll();
      const runs = (await owner.get(`/api/businesses/${businessId}/automations/${a.id}/runs`)).body;
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("succeeded");
      expect((await owner.get(`/api/notifications`)).body.items.filter((n: any) => n.title === "Acme Store needs to be reconnected")).toHaveLength(1);
    });

    it("tasks from new insights (de-duplicated per insight)", async () => {
      await owner.post(`/api/businesses/${businessId}/automations`, { name: "Insight tasks", kind: "insight_tasks", trigger: { type: "event", event: "insights_detected" }, conditions: { minSeverity: "warning" }, actions: { task: { assigneeId: analyst.userId } } });
      await pool.query(`DELETE FROM insights WHERE business_id = $1 AND rule = 'period_change'`, [businessId]); // force re-creation
      await owner.post(`/api/businesses/${businessId}/insights/detect`, {});
      await runAll();
      const tasks = (await owner.get(`/api/businesses/${businessId}/tasks`)).body.filter((t: any) => t.source === "automation" && t.insightId);
      expect(tasks.length).toBeGreaterThan(0);
      expect(new Set(tasks.map((t: any) => t.insightId)).size).toBe(tasks.length);
    });
  });

  describe("reports, export and commentary", () => {
    it("generates a custom report; export needs the export permission and neutralises formulas", async () => {
      const today = todayIn("UTC");
      const r = await analyst.post(`/api/businesses/${businessId}/reports`, { kind: "custom", period: { from: addDays(today, -14), to: addDays(today, -1) } });
      expect(r.status).toBe(201);
      expect((await viewer.post(`/api/businesses/${businessId}/reports`, { kind: "weekly_report" })).status).toBe(403);
      expect((await viewer.get(`/api/businesses/${businessId}/reports/${r.body.id}/export.csv`)).status).toBe(403);
      const csv = await analyst.get(`/api/businesses/${businessId}/reports/${r.body.id}/export.csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers["content-type"]).toMatch(/text\/csv/);
      expect(csv.text.split("\n")[0]).toBe("evidence_id,metric,period_from,period_to,value,formatted,comparison_value,change_pct,availability,sources,limitations");
      expect(csv.text).toContain("R1,Store net sales");
      expect(csv.text).toMatch(/"'-\d/); // negative change values can't be read as formulas
      const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'report.exported' AND business_id = $1`, [businessId]);
      expect(audit.rowCount).toBe(1);
    });

    it("dashboard commentary is cached per version and data", async () => {
      const d = (await owner.post(`/api/businesses/${businessId}/dashboards`, { name: "Sales", template: "ecommerce" })).body;
      const c1 = await viewer.post(`/api/businesses/${businessId}/dashboards/${d.id}/commentary`, {});
      expect(c1.status).toBe(200);
      expect(c1.body.cached).toBe(false);
      expect(c1.body.commentary.text).toMatch(/\[C1\]/);
      expect(c1.body.commentary.evidence[0].id).toBe("C1");
      const c2 = await viewer.post(`/api/businesses/${businessId}/dashboards/${d.id}/commentary`, {});
      expect(c2.body.cached).toBe(true);
      expect((await viewer.get(`/api/businesses/${businessId}/dashboards/${d.id}/commentary`)).body.commentary.id).toBe(c1.body.commentary.id);
    });

    it("notifications are private and can be marked read", async () => {
      const mine = (await owner.get(`/api/notifications`)).body;
      expect(mine.unread).toBeGreaterThan(0);
      const other = await signup(app, "Nosy");
      expect((await other.get(`/api/notifications`)).body.items).toEqual([]);
      expect((await other.post(`/api/notifications/${mine.items[0].id}/read`, {})).status).toBe(404);
      await owner.post(`/api/notifications/read-all`, {});
      expect((await owner.get(`/api/notifications`)).body.unread).toBe(0);
    });
  });
});

describe("schedule computation", () => {
  it("keeps local wall-clock time across daylight-saving changes", async () => {
    const { nextRunAt, zonedToUtc } = await import("../src/automations/schedule.js");
    expect(zonedToUtc("2026-10-31", 8, 0, "America/New_York").toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(zonedToUtc("2026-11-02", 8, 0, "America/New_York").toISOString()).toBe("2026-11-02T13:00:00.000Z");
    const n = nextRunAt({ type: "schedule", frequency: "daily", hour: 8, minute: 0, weekday: 1 }, "America/New_York", new Date("2026-10-31T13:00:00Z"));
    expect(n!.toISOString()).toBe("2026-11-01T13:00:00.000Z");
    const w = nextRunAt({ type: "schedule", frequency: "weekly", hour: 9, minute: 15, weekday: 1 }, "Europe/London", new Date("2026-10-13T10:00:00Z"));
    expect(w!.toISOString()).toBe("2026-10-19T08:15:00.000Z");
    expect(nextRunAt({ type: "event", event: "connection_failed" }, "UTC")).toBeNull();
  });
});
