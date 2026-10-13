import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup } from "./helpers.js";
import { startMockGoogle, startMockHubSpot, type GoogleState, type HubSpotState } from "./mock-providers.js";

let app: any;
let pool: any;
let google: { url: string; state: GoogleState; close: () => Promise<void> };
let hubspot: { url: string; state: HubSpotState; close: () => Promise<void> };
let runAll: () => Promise<number>;

beforeAll(async () => {
  google = await startMockGoogle();
  hubspot = await startMockHubSpot();
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "test-google-client", GOOGLE_CLIENT_SECRET: "test-google-secret", GOOGLE_ADS_DEVELOPER_TOKEN: "test-dev-token", GOOGLE_BASE_URL_OVERRIDE: google.url,
    HUBSPOT_CLIENT_ID: "test-hubspot-client", HUBSPOT_CLIENT_SECRET: "test-hubspot-secret", HUBSPOT_BASE_URL_OVERRIDE: hubspot.url, HUBSPOT_ENABLE_ACTIONS: "true",
    APP_URL: "http://app.test", API_URL: "https://api.example.test",
  });
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
afterAll(async () => { await google?.close(); await hubspot?.close(); });

const ADS = "https://www.googleapis.com/auth/adwords";
const dueNow = () => pool.query(`UPDATE jobs SET run_at = now() WHERE status = 'queued'`);

async function connectAds(c: any, businessId: string) {
  const url = new URL((await c.post(`/api/businesses/${businessId}/connections/google_ads/authorize`, { input: {} })).body.url);
  const code = `gcode.${Buffer.from(ADS).toString("base64url")}`;
  const cb = await c.get(`/api/oauth/google_ads/callback?${new URLSearchParams({ code, state: url.searchParams.get("state")!, scope: ADS })}`);
  const id = new URL(cb.headers.location).searchParams.get("connection")!;
  const conn = (await c.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === id);
  await c.put(`/api/businesses/${businessId}/connections/${id}/assets`, { assetIds: [conn.assets.find((a: any) => a.name.startsWith("Acme US")).id] });
  return id;
}

async function connectHubSpot(c: any, businessId: string) {
  const url = new URL((await c.post(`/api/businesses/${businessId}/connections/hubspot/authorize`, { input: {} })).body.url);
  expect(url.searchParams.get("scope")).toContain("crm.objects.deals.write");
  const cb = await c.get(`/api/oauth/hubspot/callback?${new URLSearchParams({ code: "hs-good-code", state: url.searchParams.get("state")! })}`);
  const id = new URL(cb.headers.location).searchParams.get("connection")!;
  const conn = (await c.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === id);
  await c.put(`/api/businesses/${businessId}/connections/${id}/assets`, { assetIds: [conn.assets[0].id] });
  return id;
}

async function member(ws: string, businessId: string, role: "admin" | "analyst" | "viewer") {
  const u = await signup(app, `${role}-user`);
  await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [ws, u.userId]);
  await pool.query(`INSERT INTO business_memberships (workspace_id, business_id, user_id, role) VALUES ($1, $2, $3, $4)`, [ws, businessId, u.userId, role]);
  return u;
}

const campaign = (name: string) => google.state.campaigns["2222222222"]!.find((c) => c.name === name)!;

describe("external actions (against local Google Ads and HubSpot stand-ins)", () => {
  let owner: any, admin2: any, analyst: any, viewer: any, ws: string, businessId: string, adsId: string, hsId: string;
  const api = (path = "") => `/api/businesses/${businessId}/actions${path}`;

  it("lists only actions the connectors support, with availability", async () => {
    owner = await signup(app, "Owner");
    ws = (await owner.post("/api/workspaces", { name: "Acme WS" })).body.id;
    businessId = (await owner.post(`/api/workspaces/${ws}/businesses`, { name: "Acme", industry: "ecommerce", timezone: "America/New_York", currency: "USD" })).body.id;
    adsId = await connectAds(owner, businessId);
    hsId = await connectHubSpot(owner, businessId);
    await runAll(); // initial imports (gives the last-7-days spend shown in the expected effect)
    admin2 = await member(ws, businessId, "admin");
    analyst = await member(ws, businessId, "analyst");
    viewer = await member(ws, businessId, "viewer");
    const types = (await viewer.get(api("/types"))).body;
    expect(types.map((t: any) => t.type).sort()).toEqual(["google_ads.campaign.set_budget", "google_ads.campaign.set_status", "hubspot.deal.set_stage"]);
    expect(types.every((t: any) => t.available)).toBe(true);
  });

  it("viewers can't list targets or propose", async () => {
    expect((await viewer.get(`${api("/targets")}?connectionId=${adsId}&type=google_ads.campaign.set_status`)).status).toBe(403);
    expect((await viewer.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:101", params: { status: "PAUSED" } })).status).toBe(403);
  });

  let pause: any;
  it("proposes with live current values, a provider dry-run and the expected effect — without changing anything", async () => {
    const targets = (await analyst.get(`${api("/targets")}?connectionId=${adsId}&type=google_ads.campaign.set_status`)).body;
    expect(targets.map((t: any) => t.name)).toEqual(["Brand Search", "Performance Max — All products", "Shopping — Jackets"]);
    const budgetTargets = (await analyst.get(`${api("/targets")}?connectionId=${adsId}&type=google_ads.campaign.set_budget`)).body;
    expect(budgetTargets.map((t: any) => t.name)).not.toContain("Shopping — Jackets"); // shared budget excluded
    const before = { ...google.state.calls };
    const r = await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:101", params: { status: "PAUSED" } });
    expect(r.status).toBe(201);
    pause = r.body;
    expect(pause).toMatchObject({ status: "pending_approval", risk: "medium", businessName: "Acme", providerName: "Google Ads", assetName: expect.stringContaining("Acme US"), target: { kind: "campaign", name: "Brand Search" }, changes: [{ label: "Status", current: "Enabled", proposed: "Paused" }], source: "user" });
    expect(pause.expectedEffect).toMatch(/stop serving/);
    expect(pause.expectedEffect).toMatch(/spent \$[\d,.]+ over the last 7 days/);
    expect(pause.approvalRequirement).toMatch(/administrator must approve/);
    expect(pause.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(google.state.calls.validateOnly).toBe(before.validateOnly + 1);
    expect(google.state.calls.mutates).toBe(before.mutates);
    expect(campaign("Brand Search").status).toBe("ENABLED");
    const notes = (await owner.get("/api/notifications")).body.items;
    expect(notes.some((n: any) => n.kind === "action_approval" && n.title.includes("Brand Search"))).toBe(true);
    // Invalid proposals are explained, not stored.
    const same = await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:103", params: { status: "PAUSED" } });
    expect(same.status).toBe(412);
    expect(same.body.error.message).toMatch(/already paused/);
    expect((await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_budget", targetId: "2222222222:103", params: { dailyBudget: 40 } })).body.error.message).toMatch(/shared budget/);
    expect((await analyst.post(api(), { connectionId: adsId, type: "shopify.delete_everything", targetId: "x", params: {} })).status).toBe(404);
  });

  it("approval is bound to the exact payload and executes once", async () => {
    expect((await analyst.post(api(`/${pause.id}/approve`), { payloadHash: pause.payloadHash })).status).toBe(403);
    const wrong = await owner.post(api(`/${pause.id}/approve`), { payloadHash: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.message).toMatch(/changed since you reviewed it/);
    expect((await owner.post(api(`/${pause.id}/approve`), { payloadHash: pause.payloadHash })).body.status).toBe("approved");
    expect((await admin2.post(api(`/${pause.id}/approve`), { payloadHash: pause.payloadHash })).status).toBe(409);
    await runAll();
    const done = (await viewer.get(api(`/${pause.id}`))).body;
    expect(done.status).toBe("succeeded");
    expect(done.decidedBy).toBe("Owner");
    expect(done.attempts.map((a: any) => `${a.kind}:${a.outcome}`)).toEqual(["status_check:not_applied", "execute:succeeded"]);
    expect(done.providerResponse.results[0].resourceName).toBe("customers/2222222222/campaigns/101");
    expect(campaign("Brand Search").status).toBe("PAUSED");
    expect(google.state.calls.mutates).toBe(1);
    // A duplicate execution request is a no-op.
    const { executeProposal } = await import("../src/actions/engine.js");
    const { withSystem } = await import("../src/db/pool.js");
    expect(await withSystem((db: any) => executeProposal(db, pause.id))).toBe("skipped");
    expect(google.state.calls.mutates).toBe(1);
    const audit = (await pool.query(`SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY created_at`, [pause.id])).rows.map((r: any) => r.action);
    expect(audit).toEqual(["action.proposed", "action.approved", "action.executed"]);
    expect((await analyst.get("/api/notifications")).body.items.some((n: any) => n.kind === "action_result" && n.title === "Done: Brand Search")).toBe(true);
  });

  it("changing the payload needs a new approval", async () => {
    const v1 = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_budget", targetId: "2222222222:101", params: { dailyBudget: 60 } })).body;
    const v2 = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_budget", targetId: "2222222222:101", params: { dailyBudget: 70 } })).body;
    expect(v2.payloadHash).not.toBe(v1.payloadHash);
    expect((await owner.get(api(`/${v1.id}`))).body.status).toBe("superseded");
    expect((await owner.post(api(`/${v1.id}/approve`), { payloadHash: v1.payloadHash })).status).toBe(409);
    expect((await owner.post(api(`/${v2.id}/approve`), { payloadHash: v1.payloadHash })).status).toBe(409);
    expect((await owner.post(api(`/${v2.id}/reject`), { payloadHash: v2.payloadHash, comment: "Not this week" })).body.status).toBe("rejected");
    await runAll();
    expect(campaign("Brand Search").budgetMicros).toBe(50_000_000);
  });

  it("after an ambiguous failure it checks the provider before retrying — never applying twice", async () => {
    const a = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:101", params: { status: "ENABLED" } })).body;
    google.state.mutateFail.applyThen503 = 1; // the change lands, but the response is an error
    await owner.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash });
    const before = google.state.calls.mutates;
    await runAll();
    expect((await owner.get(api(`/${a.id}`))).body.status).toBe("needs_check");
    await dueNow();
    await runAll();
    const r = (await owner.get(api(`/${a.id}`))).body;
    expect(r.status).toBe("succeeded");
    expect(r.attempts.map((x: any) => `${x.kind}:${x.outcome}`)).toEqual(["status_check:not_applied", "execute:ambiguous", "status_check:applied"]);
    expect(google.state.calls.mutates).toBe(before + 1);
    expect(campaign("Brand Search").status).toBe("ENABLED");
  });

  it("retries a change that definitely didn't land", async () => {
    const a = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_budget", targetId: "2222222222:101", params: { dailyBudget: 55.5 } })).body;
    google.state.mutateFail.before503 = 1;
    await owner.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash });
    await runAll();
    await dueNow();
    await runAll();
    const r = (await owner.get(api(`/${a.id}`))).body;
    expect(r.status).toBe("succeeded");
    expect(r.attempts.map((x: any) => `${x.kind}:${x.outcome}`)).toEqual(["status_check:not_applied", "execute:ambiguous", "status_check:not_applied", "execute:succeeded"]);
    expect(campaign("Brand Search").budgetMicros).toBe(55_500_000);
  });

  it("stops if the value changed in the account after approval (drift)", async () => {
    const a = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_budget", targetId: "2222222222:102", params: { dailyBudget: 150 } })).body;
    await owner.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash });
    campaign("Performance Max — All products").budgetMicros = 130_000_000; // someone edited it in Google Ads
    const before = google.state.calls.mutates;
    await runAll();
    const r = (await owner.get(api(`/${a.id}`))).body;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/changed after this was approved/);
    expect(google.state.calls.mutates).toBe(before);
  });

  it("high-risk actions need a second administrator", async () => {
    const a = (await owner.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_budget", targetId: "2222222222:102", params: { dailyBudget: 400 } })).body;
    expect(a.risk).toBe("high");
    expect(a.approvalRequirement).toMatch(/other than the proposer/);
    expect((await owner.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash })).status).toBe(403);
    expect((await admin2.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash })).status).toBe(200);
    await runAll();
    expect((await owner.get(api(`/${a.id}`))).body.status).toBe("succeeded");
    expect(campaign("Performance Max — All products").budgetMicros).toBe(400_000_000);
    // Guardrail: no 10× jumps.
    expect((await owner.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_budget", targetId: "2222222222:102", params: { dailyBudget: 99999 } })).body.error.message).toMatch(/ten times/);
  });

  it("re-checks the approver's permission at execution time", async () => {
    const a = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:102", params: { status: "PAUSED" } })).body;
    await admin2.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash });
    await pool.query(`UPDATE business_memberships SET role = 'viewer' WHERE user_id = $1 AND business_id = $2`, [admin2.userId, businessId]);
    await runAll();
    const r = (await owner.get(api(`/${a.id}`))).body;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/no longer has permission/);
    expect(campaign("Performance Max — All products").status).toBe("ENABLED");
    await pool.query(`UPDATE business_memberships SET role = 'admin' WHERE user_id = $1 AND business_id = $2`, [admin2.userId, businessId]);
  });

  it("records provider rejections without retrying, and expires stale proposals", async () => {
    const a = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:102", params: { status: "PAUSED" } })).body;
    google.state.mutateFail.reject400 = 1;
    await owner.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash });
    await runAll();
    const r = (await owner.get(api(`/${a.id}`))).body;
    expect(r.status).toBe("failed");
    expect(r.attempts.at(-1)).toMatchObject({ kind: "execute", outcome: "failed" });
    const b = (await analyst.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:102", params: { status: "PAUSED" } })).body;
    await pool.query(`UPDATE action_proposals SET expires_at = now() - interval '1 minute' WHERE id = $1`, [b.id]);
    expect((await owner.post(api(`/${b.id}/approve`), { payloadHash: b.payloadHash })).body.error.message).toMatch(/expired/);
  });

  it("HubSpot: moves a deal to another stage after approval", async () => {
    const targets = (await analyst.get(`${api("/targets")}?connectionId=${hsId}&type=hubspot.deal.set_stage`)).body;
    const t = targets.find((x: any) => x.state.pipeline === "default");
    const won = t.fields[0].options.find((o: any) => o.label === "Closed won");
    const a = (await analyst.post(api(), { connectionId: hsId, type: "hubspot.deal.set_stage", targetId: t.id, params: { stage: won.value } })).body;
    expect(a.changes[0]).toMatchObject({ label: "Deal stage", proposed: "Closed won (Sales Pipeline)" });
    expect(a.expectedEffect).toMatch(/won value and win rate/);
    expect(hubspot.state.calls.patches).toBe(0);
    await owner.post(api(`/${a.id}/approve`), { payloadHash: a.payloadHash });
    await runAll();
    expect((await owner.get(api(`/${a.id}`))).body.status).toBe("succeeded");
    expect(hubspot.state.calls.patches).toBe(1);
    expect(hubspot.state.deals.find((d) => d.id === t.id)!.status).toBe("won");
  });

  it("explains when a connection was authorized read-only", async () => {
    process.env.HUBSPOT_ENABLE_ACTIONS = "false";
    const { businessId: b2 } = { businessId: (await owner.post(`/api/workspaces/${ws}/businesses`, { name: "Read only", industry: "b2b", timezone: "UTC", currency: "USD" })).body.id };
    const url = new URL((await owner.post(`/api/businesses/${b2}/connections/hubspot/authorize`, { input: {} })).body.url);
    expect(url.searchParams.get("scope")).not.toContain("write");
    await owner.get(`/api/oauth/hubspot/callback?${new URLSearchParams({ code: "hs-good-code", state: url.searchParams.get("state")! })}`);
    const types = (await owner.get(`/api/businesses/${b2}/actions/types`)).body;
    expect(types[0]).toMatchObject({ type: "hubspot.deal.set_stage", available: false });
    expect(types[0].unavailableReason).toMatch(/HUBSPOT_ENABLE_ACTIONS/);
    process.env.HUBSPOT_ENABLE_ACTIONS = "true";
  });

  it("keeps actions inside the business", async () => {
    const other = await signup(app, "Other");
    expect((await other.get(api())).status).toBe(404);
    expect((await other.post(api(`/${pause.id}/approve`), { payloadHash: pause.payloadHash })).status).toBe(404);
    const ows = (await other.post("/api/workspaces", { name: "Other WS" })).body.id;
    const ob = (await other.post(`/api/workspaces/${ows}/businesses`, { name: "Other", industry: "b2b", timezone: "UTC", currency: "USD" })).body.id;
    // Another business can't use this business's connection.
    expect((await other.post(`/api/businesses/${ob}/actions`, { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:101", params: { status: "PAUSED" } })).status).toBe(404);
  });

  it("the assistant can propose, but never execute", async () => {
    const { runTool } = await import("../src/assistant/tools.js");
    const conv = (await analyst.post(`/api/businesses/${businessId}/assistant/conversations`, {})).body.id;
    const env = { userId: analyst.userId, businessId, conversationId: conv, nextEvidenceId: () => "E1" };
    const list: any = await runTool(env, "list_available_actions", {});
    expect(list.result.user_can_propose).toBe(true);
    const before = google.state.calls.mutates;
    const out: any = await runTool(env, "propose_action", { action_type: "google_ads.campaign.set_status", connection_id: adsId, target_id: "2222222222:101", params: { status: "PAUSED" } });
    expect(out.result.status).toBe("waiting_for_approval");
    expect(out.action).toMatchObject({ source: "assistant", status: "pending_approval" });
    await runAll();
    expect(google.state.calls.mutates).toBe(before);
    const venv = { userId: viewer.userId, businessId, conversationId: conv, nextEvidenceId: () => "E2" };
    expect(((await runTool(venv, "propose_action", { action_type: "google_ads.campaign.set_status", connection_id: adsId, target_id: "2222222222:101", params: { status: "PAUSED" } })) as any).isError).toBe(true);
  });

  it("a platform flag switches actions off — including ones approved but not yet executed", async () => {
    const pending = (await owner.get(api("?status=pending"))).body[0];
    expect(pending).toBeTruthy();
    expect((await owner.post(api(`/${pending.id}/approve`), { payloadHash: pending.payloadHash })).status).toBe(200);
    await pool.query(`UPDATE feature_flags SET overrides = jsonb_build_object($1::text, false) WHERE key = 'external_actions'`, [ws]);
    const before = google.state.calls.mutates;
    await dueNow();
    await runAll();
    const after = (await owner.get(api(`/${pending.id}`))).body;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/turned off .* Nothing was changed/);
    expect(google.state.calls.mutates).toBe(before);
    const types = (await owner.get(api("/types"))).body;
    expect(types.every((t: any) => !t.available && /turned off/.test(t.unavailableReason))).toBe(true);
    const r = await owner.post(api(), { connectionId: adsId, type: "google_ads.campaign.set_status", targetId: "2222222222:102", params: { status: "PAUSED" } });
    expect(r.status).toBe(412);
    await pool.query(`UPDATE feature_flags SET overrides = '{}' WHERE key = 'external_actions'`);
  });
});
