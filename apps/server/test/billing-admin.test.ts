import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup, workspaceWithBusiness } from "./helpers.js";
import { startMockStripe } from "./mock-stripe.js";

let app: any;
let pool: any;
let stripe: Awaited<ReturnType<typeof startMockStripe>>;
let sign: (payload: string, secret: string, t?: number) => string;

const WEBHOOK_SECRET = "whsec_test_secret";
const SECRET_KEY = "sk_test_supersecretvalue123";

beforeAll(async () => {
  stripe = await startMockStripe();
  Object.assign(process.env, { APP_URL: "http://app.test", API_URL: "https://api.example.test", ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  delete process.env.DEEPGRAM_API_KEY;
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
  sign = (await import("../src/billing/stripe.js")).signStripePayload;
});
afterAll(async () => { await stripe?.close(); });

const configureStripe = () => Object.assign(process.env, {
  STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_BASE_URL_OVERRIDE: stripe.url,
  STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_GROWTH: "price_growth", STRIPE_PRICE_AGENCY: "price_agency",
});

async function webhook(event: Record<string, unknown>, opts: { secret?: string; t?: number } = {}) {
  const payload = JSON.stringify(event);
  const request = (await import("supertest")).default;
  return request(app).post("/api/webhooks/stripe").set("Content-Type", "application/json").set("Stripe-Signature", sign(payload, opts.secret ?? WEBHOOK_SECRET, opts.t)).send(payload);
}

async function makeAdmin() {
  const admin = await signup(app, "Admin");
  await pool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [admin.userId]);
  return admin;
}

const endTrial = (ws: string) => pool.query(`UPDATE workspace_subscriptions SET trial_ends_at = now() - interval '1 day' WHERE workspace_id = $1`, [ws]);

describe("billing and plan limits", () => {
  let owner: any, ws: string, businessId: string;

  it("starts every workspace on a 14-day Growth trial; members can see the plan, only owners manage it", async () => {
    owner = await signup(app, "Owner");
    ({ workspaceId: ws, businessId } = await workspaceWithBusiness(owner, "Acme"));
    const b = (await owner.get(`/api/workspaces/${ws}/billing`)).body;
    expect(b).toMatchObject({ effectivePlan: "growth", plan: "growth", status: "trialing", managedByStripe: false, stripeConfigured: false, purchasable: [], canManage: true });
    expect(new Date(b.trialEndsAt).getTime() - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(b.usage).toMatchObject({ businesses: 1, connections: 0, members: 1, aiMessages: 0, voiceSessions: 0 });
    expect(b.limits.businesses).toBe(10);
    const me = (await owner.get("/api/auth/me")).body;
    expect(me.workspaces[0]).toMatchObject({ plan: "growth", features: { assistant: true, voice: true, external_actions: true } });

    const member = await signup(app, "Member");
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [ws, member.userId]);
    expect((await member.get(`/api/workspaces/${ws}/billing`)).body.canManage).toBe(false);
    expect((await member.post(`/api/workspaces/${ws}/billing/checkout`, { plan: "starter" })).status).toBe(403);
    await pool.query(`DELETE FROM workspace_memberships WHERE user_id = $1`, [member.userId]);
    expect((await (await signup(app, "Stranger")).get(`/api/workspaces/${ws}/billing`)).status).toBe(404);
  });

  it("falls back to Free limits after the trial and enforces them on the server (demo businesses don't count)", async () => {
    await endTrial(ws);
    const b = (await owner.get(`/api/workspaces/${ws}/billing`)).body;
    expect(b.effectivePlan).toBe("free");
    expect(b.notice).toMatch(/trial has ended/);
    const second = await owner.post(`/api/workspaces/${ws}/businesses`, { name: "Second", industry: "ecommerce", timezone: "UTC", currency: "USD" });
    expect(second.status).toBe(402);
    expect(second.body.error).toMatchObject({ code: "plan_limit", details: { limit: "businesses", used: 1, allowed: 1, plan: "free" } });
    expect(second.body.error.message).toMatch(/Free plan includes 1 business/);
    expect((await owner.post(`/api/workspaces/${ws}/demo-business`, {})).status).toBeLessThan(300);

    // Members: owner + one invitation fit the Free plan's 2; a third person doesn't.
    expect((await owner.post(`/api/workspaces/${ws}/invitations`, { email: "first@example.com" })).status).toBe(201);
    const third = await owner.post(`/api/workspaces/${ws}/invitations`, { email: "second@example.com" });
    expect(third.status).toBe(402);
    expect(third.body.error.details.limit).toBe("members");
  });

  it("enforces the monthly assistant and voice quotas, and meters voice sessions", async () => {
    // Voice without Deepgram falls back to browser speech, but still counts as a conversation.
    const v = await owner.post(`/api/businesses/${businessId}/voice/session`, {});
    expect(v.status).toBe(200);
    expect(v.body.stt.provider).toBe("browser");
    const used = await pool.query(`SELECT kind, quantity::int AS q, business_id FROM usage_events WHERE workspace_id = $1`, [ws]);
    expect(used.rows).toEqual([{ kind: "voice_session", q: 1, business_id: businessId }]);
    await pool.query(`INSERT INTO usage_events (workspace_id, kind, quantity) VALUES ($1, 'voice_session', 9), ($1, 'ai_message', 100)`, [ws]);
    const voice = await owner.post(`/api/businesses/${businessId}/voice/session`, {});
    expect(voice.status).toBe(402);
    expect(voice.body.error.message).toMatch(/voice conversations/);
    const conv = (await owner.post(`/api/businesses/${businessId}/assistant/conversations`, {})).body;
    const ask = await owner.post(`/api/businesses/${businessId}/assistant/conversations/${conv.id}/messages`, { text: "How are sales?" });
    expect(ask.status).toBe(402);
    expect(ask.body.error.message).toMatch(/100 assistant questions/);
    // Last month's usage doesn't count.
    await pool.query(`UPDATE usage_events SET created_at = date_trunc('month', now()) - interval '1 day' WHERE workspace_id = $1`, [ws]);
    expect((await owner.get(`/api/workspaces/${ws}/billing`)).body.usage.aiMessages).toBe(0);
  });

  it("explains that checkout needs Stripe until it is configured", async () => {
    const r = await owner.post(`/api/workspaces/${ws}/billing/checkout`, { plan: "starter" });
    expect(r.status).toBe(412);
    expect(r.body.error.message).toMatch(/STRIPE_SECRET_KEY/);
  });

  it("starts Stripe Checkout with one customer per workspace, server-side price and workspace reference", async () => {
    configureStripe();
    const r1 = await owner.post(`/api/workspaces/${ws}/billing/checkout`, { plan: "starter" });
    expect(r1.status).toBe(200);
    expect(r1.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const r2 = await owner.post(`/api/workspaces/${ws}/billing/checkout`, { plan: "growth" });
    expect(r2.status).toBe(200);
    const customers = stripe.calls.filter((c) => c.path === "customers");
    expect(customers).toHaveLength(1);
    expect(customers[0]!.idempotencyKey).toBe(`customer:${ws}`);
    expect(customers[0]!.auth).toBe(`Bearer ${SECRET_KEY}`);
    const sessions = stripe.calls.filter((c) => c.path === "checkout/sessions");
    expect(sessions[0]!.form).toMatchObject({ mode: "subscription", "line_items[0][price]": "price_starter", client_reference_id: ws, "subscription_data[metadata][workspace_id]": ws, success_url: `http://app.test/app/w/${ws}/billing?checkout=success` });
    expect(sessions[1]!.form["line_items[0][price]"]).toBe("price_growth");
    expect(sessions[0]!.form.customer).toBe(sessions[1]!.form.customer);
    expect((await owner.post(`/api/workspaces/${ws}/billing/checkout`, { plan: "enterprise" })).status).toBe(400);
  });

  it("applies verified webhooks exactly once, in order, and ignores bad signatures", async () => {
    const customer = stripe.calls.find((c) => c.path === "customers")!.idempotencyKey!.replace(/[^a-zA-Z0-9_]/g, "");
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    const sub = { id: "sub_1", object: "subscription", status: "active", customer: `cus_${customer}`, cancel_at_period_end: false, metadata: { workspace_id: ws }, items: { data: [{ price: { id: "price_starter" }, current_period_end: periodEnd }] } };
    stripe.subscriptions.set("sub_1", sub);
    const now = Math.floor(Date.now() / 1000);
    const completed = { id: "evt_1", type: "checkout.session.completed", created: now - 10, data: { object: { id: "cs_1", mode: "subscription", client_reference_id: ws, customer: sub.customer, subscription: "sub_1", metadata: { workspace_id: ws } } } };

    expect((await webhook(completed, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await webhook(completed, { t: now - 3600 })).status).toBe(400); // replayed outside the tolerance window
    const first = await webhook(completed);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ duplicate: false, applied: true, workspaceId: ws });
    const again = await webhook(completed);
    expect(again.body.duplicate).toBe(true);
    let b = (await owner.get(`/api/workspaces/${ws}/billing`)).body;
    expect(b).toMatchObject({ effectivePlan: "starter", status: "active", managedByStripe: true, trialEndsAt: null });
    expect(new Date(b.currentPeriodEnd).getTime()).toBe(periodEnd * 1000);
    const audits = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'billing.subscription_updated'`, [ws]);
    expect(audits.rows[0].n).toBe(1);
    // Limits follow the new plan immediately.
    expect((await owner.post(`/api/workspaces/${ws}/businesses`, { name: "Second", industry: "ecommerce", timezone: "UTC", currency: "USD" })).status).toBe(201);
    // A second checkout is refused while subscribed; the portal is offered instead.
    expect((await owner.post(`/api/workspaces/${ws}/billing/checkout`, { plan: "agency" })).status).toBe(409);
    expect((await owner.post(`/api/workspaces/${ws}/billing/portal`, {})).body.url).toBe("https://billing.stripe.test/p/1");

    // Out-of-order delivery: an older "updated" event must not overwrite newer state.
    const stale = { id: "evt_0", type: "customer.subscription.updated", created: now - 100, data: { object: { ...sub, status: "incomplete" } } };
    expect((await webhook(stale)).body.applied).toBe(false);
    expect((await owner.get(`/api/workspaces/${ws}/billing`)).body.status).toBe("active");

    const upgraded = { id: "evt_2", type: "customer.subscription.updated", created: now, data: { object: { ...sub, cancel_at_period_end: true, items: { data: [{ price: { id: "price_growth" }, current_period_end: periodEnd }] } } } };
    expect((await webhook(upgraded)).body.applied).toBe(true);
    b = (await owner.get(`/api/workspaces/${ws}/billing`)).body;
    expect(b).toMatchObject({ effectivePlan: "growth", cancelAtPeriodEnd: true });
    expect(b.notice).toMatch(/set to end/);

    const failed = { id: "evt_3", type: "invoice.payment_failed", created: now + 1, data: { object: { id: "in_1", customer: sub.customer } } };
    expect((await webhook(failed)).body.applied).toBe(true);
    const notes = (await owner.get("/api/notifications")).body.items;
    expect(notes.find((x: any) => x.title === "Payment failed")).toMatchObject({ businessId: null, businessName: "Acme WS", link: `/app/w/${ws}/billing` });

    const deleted = { id: "evt_4", type: "customer.subscription.deleted", created: now + 2, data: { object: { ...sub, status: "canceled" } } };
    expect((await webhook(deleted)).body.applied).toBe(true);
    b = (await owner.get(`/api/workspaces/${ws}/billing`)).body;
    expect(b).toMatchObject({ effectivePlan: "free", status: "canceled" });
    expect(b.notice).toMatch(/subscription has ended/);
    // Existing data is kept; only new additions are blocked.
    expect((await owner.get(`/api/businesses/${businessId}`)).status).toBe(200);
  });
});

describe("platform administration", () => {
  let admin: any, owner: any, ws: string, businessId: string;

  it("is restricted to platform administrators", async () => {
    owner = await signup(app, "Customer");
    ({ workspaceId: ws, businessId } = await workspaceWithBusiness(owner, "Northwind"));
    for (const path of ["overview", "workspaces", "connectors", "jobs", "usage", "flags", "config", "audit", "support-access"]) {
      expect((await owner.get(`/api/admin/${path}`)).status).toBe(403);
    }
    admin = await makeAdmin();
    expect((await admin.get("/api/admin/overview")).status).toBe(200);
  });

  it("shows customers, subscriptions, usage, connector health and jobs without customer business data", async () => {
    await pool.query(`INSERT INTO usage_events (workspace_id, business_id, kind, quantity, meta) VALUES ($1, $2, 'ai_message', 1, '{"input_tokens": 1200, "output_tokens": 300}')`, [ws, businessId]);
    const o = (await admin.get("/api/admin/overview")).body;
    expect(o.counts.workspaces).toBeGreaterThanOrEqual(2);
    expect(o.subscriptions.byPlan.growth).toBeGreaterThanOrEqual(1);
    expect(o.usage30d.find((u: any) => u.kind === "ai_message").input_tokens).toBeGreaterThanOrEqual(1200);
    const list = (await admin.get(`/api/admin/workspaces?q=northwind`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: ws, owner_email: owner.email, businesses: 1, effectivePlan: "growth", ai_messages_month: 1 });
    const detail = (await admin.get(`/api/admin/workspaces/${ws}`)).body;
    expect(detail.businesses[0].name).toBe("Northwind");
    expect(detail.usage.aiMessages).toBe(1);
    const usage = (await admin.get("/api/admin/usage?days=7")).body;
    expect(usage.byWorkspace.find((w: any) => w.id === ws)).toMatchObject({ ai_messages: 1, input_tokens: 1200 });
    const conn = (await admin.get("/api/admin/connectors")).body;
    const { IMPLEMENTED } = await import("../src/connectors/registry.js");
    expect(conn.providers.map((p: any) => p.id)).toEqual(IMPLEMENTED.map((d) => d.id));
    expect(conn.providers.length).toBe(23);
    await pool.query(`INSERT INTO jobs (type, workspace_id, status, last_error, finished_at) VALUES ('report.generate', $1, 'failed', 'boom', now())`, [ws]);
    const jobs = (await admin.get("/api/admin/jobs?status=failed")).body;
    const failed = jobs.jobs.find((j: any) => j.last_error === "boom");
    expect(failed).toBeTruthy();
    expect((await admin.post(`/api/admin/jobs/${failed.id}/retry`, {})).status).toBe(200);
    expect((await pool.query(`SELECT status FROM jobs WHERE id = $1`, [failed.id])).rows[0].status).toBe("queued");
    expect((await admin.post(`/api/admin/jobs/${failed.id}/retry`, {})).status).toBe(409);
  });

  it("reports configuration status without exposing any secret value", async () => {
    const r = await admin.get("/api/admin/config");
    const text = JSON.stringify(r.body);
    expect(r.body.secrets.find((s: any) => s.key === "STRIPE_SECRET_KEY").configured).toBe(true);
    expect(r.body.billing).toMatchObject({ stripeConfigured: true, webhookConfigured: true, webhookUrl: "https://api.example.test/api/webhooks/stripe" });
    for (const secret of [SECRET_KEY, WEBHOOK_SECRET, "test-anthropic-key"]) expect(text).not.toContain(secret);
    expect(r.body.connectors.find((c: any) => c.id === "shopify").redirectUri).toBe("https://api.example.test/api/oauth/shopify/callback");
  });

  it("feature flags switch features off per workspace, enforced on the server and audited", async () => {
    const flags = (await admin.get("/api/admin/flags")).body;
    expect(flags.map((f: any) => f.key)).toEqual(["assistant", "external_actions", "voice"]);
    expect((await admin.put("/api/admin/flags/voice", { enabled: true, overrides: { [ws]: false } })).status).toBe(200);
    expect((await admin.put("/api/admin/flags/unknown", { enabled: true })).status).toBe(404);
    expect((await admin.put("/api/admin/flags/voice", { enabled: true, overrides: { "00000000-0000-4000-8000-000000000000": false } })).status).toBe(400);
    const voice = await owner.post(`/api/businesses/${businessId}/voice/session`, {});
    expect(voice.status).toBe(412);
    expect(voice.body.error.message).toMatch(/Voice conversations is turned off/);
    expect((await owner.get("/api/auth/me")).body.workspaces[0].features.voice).toBe(false);
    // Other workspaces keep the global value.
    const other = await signup(app, "OtherCo");
    const o = await workspaceWithBusiness(other, "OtherCo");
    expect((await other.post(`/api/businesses/${o.businessId}/voice/session`, {})).status).toBe(200);

    await admin.put("/api/admin/flags/assistant", { enabled: false, overrides: {} });
    const conv = (await owner.post(`/api/businesses/${businessId}/assistant/conversations`, {})).body;
    const ask = await owner.post(`/api/businesses/${businessId}/assistant/conversations/${conv.id}/messages`, { text: "hi" });
    expect(ask.status).toBe(412);
    await admin.put("/api/admin/flags/assistant", { enabled: true, overrides: {} });
    await admin.put("/api/admin/flags/voice", { enabled: true, overrides: {} });
    const audit = (await admin.get("/api/admin/audit?action=admin.flag_changed")).body;
    expect(audit.length).toBe(4);
    expect(audit[0]).toMatchObject({ actor_email: admin.email, actor_type: "support", target_id: "voice" });
  });

  it("grants plans without Stripe (audited) and can disable accounts", async () => {
    expect((await admin.post(`/api/admin/workspaces/${ws}/subscription`, { plan: "agency", status: "active", reason: "Pilot customer" })).status).toBe(200);
    expect((await owner.get(`/api/workspaces/${ws}/billing`)).body).toMatchObject({ effectivePlan: "agency", managedByStripe: false });
    const victim = await signup(app, "Victim");
    expect((await admin.post(`/api/admin/users/${victim.userId}/disabled`, { disabled: true, reason: "Abuse report" })).status).toBe(200);
    expect((await victim.get("/api/auth/me")).status).toBe(401);
    expect((await admin.post(`/api/admin/users/${admin.userId}/disabled`, { disabled: true, reason: "oops self" })).status).toBe(400);
  });

  it("support access is reasoned, time-limited, read-only, audited in the customer's log and revocable by the owner", async () => {
    expect((await admin.get(`/api/businesses/${businessId}`)).status).toBe(404);
    expect((await admin.post("/api/admin/support-access", { workspaceId: ws, reason: "short", minutes: 30 })).status).toBe(400);
    expect((await admin.post("/api/admin/support-access", { workspaceId: ws, reason: "Customer asked why the dashboard is empty", minutes: 600 })).status).toBe(400);
    const g = await admin.post("/api/admin/support-access", { workspaceId: ws, reason: "Customer asked why the dashboard is empty", minutes: 30 });
    expect(g.status).toBe(201);

    const b = await admin.get(`/api/businesses/${businessId}`);
    expect(b.status).toBe(200);
    expect(b.body.role).toBe("viewer");
    expect((await admin.get(`/api/businesses/${businessId}/dashboards`)).status).toBe(200);
    expect((await admin.patch(`/api/businesses/${businessId}`, { name: "Hacked" })).status).toBe(403);
    const ask = await admin.get(`/api/businesses/${businessId}/assistant/conversations`);
    expect(ask.status).toBe(403);
    expect(ask.body.error.message).toBe("Support access is read-only.");

    const views = await pool.query(`SELECT actor_type, metadata FROM audit_logs WHERE workspace_id = $1 AND action = 'support.data_viewed' ORDER BY id`, [ws]);
    expect(views.rows.length).toBe(2);
    expect(views.rows[0]).toMatchObject({ actor_type: "support", metadata: { request: `GET /api/businesses/${businessId}` } });
    // Refused attempts are recorded as well, even though their transaction rolled back.
    const denied = await pool.query(`SELECT metadata->>'request' AS request FROM audit_logs WHERE workspace_id = $1 AND action = 'support.access_denied' ORDER BY id`, [ws]);
    expect(denied.rows.map((r: any) => r.request)).toEqual([`PATCH /api/businesses/${businessId}`, `GET /api/businesses/${businessId}/assistant/conversations`]);
    // The owner was told, can see the grant (with a view count) and the audit trail, and can end it.
    const notes = (await owner.get("/api/notifications")).body.items;
    expect(notes.find((x: any) => x.title === "Support access opened").body).toContain("Customer asked why the dashboard is empty");
    const grants = (await owner.get(`/api/workspaces/${ws}/support-access`)).body;
    expect(grants[0]).toMatchObject({ active: true, adminEmail: admin.email });
    expect(grants[0].views).toBe(2);
    expect((await owner.post(`/api/workspaces/${ws}/support-access/${grants[0].id}/revoke`, {})).status).toBe(200);
    expect((await admin.get(`/api/businesses/${businessId}`)).status).toBe(404);

    // Expired grants give no access either.
    await admin.post("/api/admin/support-access", { workspaceId: ws, reason: "Second look at sync errors", minutes: 15 });
    expect((await admin.get(`/api/businesses/${businessId}`)).status).toBe(200);
    await pool.query(`UPDATE support_access_grants SET expires_at = now() - interval '1 second' WHERE workspace_id = $1`, [ws]);
    expect((await admin.get(`/api/businesses/${businessId}`)).status).toBe(404);
    // A demoted administrator's grant stops working at once.
    await admin.post("/api/admin/support-access", { workspaceId: ws, reason: "Third look at sync errors", minutes: 15 });
    await pool.query(`UPDATE users SET is_platform_admin = false WHERE id = $1`, [admin.userId]);
    expect((await admin.get(`/api/businesses/${businessId}`)).status).toBe(404);
    await pool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [admin.userId]);
  });
});

describe("data retention", () => {
  it("purges expired records, keeps current state and aggregated metrics, and freezes purged days", async () => {
    const owner = await signup(app, "Retainer");
    const { workspaceId: ws, businessId } = await workspaceWithBusiness(owner, "Keeper");
    await pool.query(`UPDATE workspaces SET data_retention_days = 90 WHERE id = $1`, [ws]);
    const conn = (await pool.query(`INSERT INTO connections (workspace_id, business_id, provider, display_name, status) VALUES ($1, $2, 'shopify', 'Shop', 'active') RETURNING id`, [ws, businessId])).rows[0].id;
    const asset = (await pool.query(`INSERT INTO connection_assets (workspace_id, business_id, connection_id, provider_asset_id, name, kind, selected) VALUES ($1, $2, $3, 'shop', 'Shop', 'store', true) RETURNING id`, [ws, businessId, conn])).rows[0].id;
    const rec = (id: string, type: string, daysAgo: number, payload: object, provider = "shopify", updatedDaysAgo?: number) => pool.query(
      `INSERT INTO source_records (workspace_id, business_id, connection_id, asset_id, provider, record_type, provider_id, local_date, occurred_at, source_updated_at, payload)
       VALUES ($1, $2, $3, $4, $9, $5, $6, (now() - make_interval(days => $7))::date, now() - make_interval(days => $7), now() - make_interval(days => $10), $8)`,
      [ws, businessId, conn, asset, type, id, daysAgo, JSON.stringify(payload), provider, updatedDaysAgo ?? daysAgo]);
    await rec("old-1", "order", 400, { customerId: "c1", test: false, cancelled: false });
    await rec("old-2", "order", 200, { customerId: "c1", test: false, cancelled: false });
    await rec("refunded-recently", "order", 300, { customerId: "c2", test: false, cancelled: false }, "shopify", 5);
    await rec("new-1", "order", 10, { customerId: "c1", test: false, cancelled: false });
    await rec("open-deal", "deal", 500, { status: "open" }, "hubspot");
    await rec("lost-deal", "deal", 500, { status: "lost" }, "hubspot");
    await pool.query(`INSERT INTO metric_facts (workspace_id, business_id, connection_id, asset_id, provider, metric_key, date, value) VALUES ($1, $2, $3, $4, 'shopify', 'store_orders', (now() - interval '400 days')::date, 1)`, [ws, businessId, conn, asset]);
    const convOld = "11111111-1111-4111-8111-111111111111";
    await pool.query(`INSERT INTO conversations (id, workspace_id, business_id, user_id, updated_at) VALUES ($1, $2, $3, $4, now() - interval '200 days'), (gen_random_uuid(), $2, $3, $4, now())`, [convOld, ws, businessId, owner.userId]);

    const { purgeExpiredData } = await import("../src/lib/retention.js");
    const out = await purgeExpiredData();
    expect(out.find((r) => r.workspaceId === ws)!.deleted).toMatchObject({ sourceRecords: 3, conversations: 1 });
    const left = (await pool.query(`SELECT provider_id FROM source_records WHERE asset_id = $1 ORDER BY 1`, [asset])).rows.map((r: any) => r.provider_id);
    expect(left).toEqual(["new-1", "open-deal", "refunded-recently"]);
    // Aggregates are kept; the customer's first order is remembered; purged days won't be recomputed.
    expect((await pool.query(`SELECT count(*)::int AS n FROM metric_facts WHERE asset_id = $1`, [asset])).rows[0].n).toBe(1);
    const first = (await pool.query(`SELECT first_at < now() - interval '399 days' AS old FROM customer_first_orders WHERE asset_id = $1 AND customer_id = 'c1'`, [asset])).rows[0];
    expect(first.old).toBe(true);
    const frozen = (await pool.query(`SELECT purged_before FROM connection_assets WHERE id = $1`, [asset])).rows[0].purged_before;
    expect(frozen).toBeTruthy();
    const { replaceFacts } = await import("../src/connectors/normalize.js");
    const client = await pool.connect();
    try {
      const oldDay = (await client.query(`SELECT (now() - interval '400 days')::date AS d`)).rows[0].d;
      const ctx: any = { db: client, connection: { id: conn, workspace_id: ws, business_id: businessId, provider: "shopify" }, asset: { id: asset }, jobId: null };
      expect(await replaceFacts(ctx, [oldDay], () => [{ metric: "store_orders", value: 0 }], ["store_orders"])).toBe(0);
    } finally {
      client.release();
    }
    expect((await pool.query(`SELECT value FROM metric_facts WHERE asset_id = $1`, [asset])).rows[0].value).toBe(1);
    const audit = await pool.query(`SELECT metadata FROM audit_logs WHERE workspace_id = $1 AND action = 'retention.purged'`, [ws]);
    expect(audit.rows[0].metadata.retentionDays).toBe(90);
    // Idempotent: a second run finds nothing more.
    expect((await purgeExpiredData()).find((r) => r.workspaceId === ws)).toBeUndefined();
  });
});
