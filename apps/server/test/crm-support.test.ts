import { addDays, todayIn } from "@bca/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, workspaceWithBusiness } from "./helpers.js";
import { bootApp, connection, connectWithToken, metric } from "./kit.js";
import { GHL_TZ, IC_TZ, SF_INSTANCE, SF_TZ, localDay, startMockCrmSupport, type CrmSupportState } from "./mock-crm-support.js";

/** Salesforce, GoHighLevel, Zendesk and Intercom end to end against local stand-ins. */

const BIZ_TZ = "America/New_York";
let mock: Awaited<ReturnType<typeof startMockCrmSupport>>;
let s: CrmSupportState;
let pool: any;
let runAll: () => Promise<number>;
let app: any;

beforeAll(async () => {
  mock = await startMockCrmSupport();
  s = mock.state;
  Object.assign(process.env, {
    SALESFORCE_CLIENT_ID: s.sf.clientId,
    SALESFORCE_CLIENT_SECRET: s.sf.clientSecret,
    SALESFORCE_BASE_URL_OVERRIDE: mock.url,
    GOHIGHLEVEL_BASE_URL_OVERRIDE: mock.url,
    ZENDESK_BASE_URL_OVERRIDE: mock.url,
    INTERCOM_BASE_URL_OVERRIDE: mock.url,
    APP_URL: "http://app.test",
    API_URL: "https://api.example.test",
  });
  ({ app, pool, runAll } = await bootApp());
});
afterAll(async () => mock?.close());

const inRange = (d: string | null | undefined, from: string, to: string) => d != null && d >= from && d <= to;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const coveredFrom = async (connectionId: string) => (await pool.query("SELECT sync_cursor->>'coveredFrom' AS f FROM connection_assets WHERE connection_id = $1", [connectionId])).rows[0].f as string;
const expire = (connectionId: string) => pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [connectionId]);
const syncNow = async (c: any, businessId: string, connectionId: string) => {
  const r = await c.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`);
  expect(r.status).toBe(202);
  await runAll();
  const conn = await connection(c, businessId, connectionId);
  expect(conn.latestJob.status).toBe("succeeded");
};

function sfExpected(from: string, to: string) {
  const won = s.sf.opps.filter((o) => o.IsWon && inRange(o.CloseDate, from, to));
  const open = s.sf.opps.filter((o) => !o.IsClosed);
  const usd = (o: { Amount: number | null; CurrencyIsoCode: string }) => (o.CurrencyIsoCode === "USD" ? o.Amount ?? 0 : 0);
  return {
    leads: s.sf.leads.filter((l) => inRange(localDay(l.CreatedDate, SF_TZ), from, to)).length,
    qualified: s.sf.leads.filter((l) => l.IsConverted && inRange(l.ConvertedDate, from, to)).length,
    created: s.sf.opps.filter((o) => inRange(localDay(o.CreatedDate, SF_TZ), from, to)).length,
    won: won.length,
    lost: s.sf.opps.filter((o) => o.IsClosed && !o.IsWon && inRange(o.CloseDate, from, to)).length,
    wonValue: sum(won.map(usd)),
    open: open.length,
    openValue: sum(open.map(usd)),
  };
}

function ghlExpected(from: string, to: string) {
  const closedDay = (o: CrmSupportState["ghl"]["opps"][number]) => (o.lastStatusChangeAt ? localDay(o.lastStatusChangeAt, GHL_TZ) : null);
  const won = s.ghl.opps.filter((o) => o.status === "won" && inRange(closedDay(o), from, to));
  const open = s.ghl.opps.filter((o) => o.status === "open");
  return {
    contacts: s.ghl.contacts.filter((c) => inRange(localDay(c.dateAdded, GHL_TZ), from, to)).length,
    customers: s.ghl.contacts.filter((c) => c.type === "customer" && inRange(localDay(c.dateAdded, GHL_TZ), from, to)).length,
    created: s.ghl.opps.filter((o) => inRange(localDay(o.createdAt, GHL_TZ), from, to)).length,
    won: won.length,
    lost: s.ghl.opps.filter((o) => (o.status === "lost" || o.status === "abandoned") && inRange(closedDay(o), from, to)).length,
    wonValue: sum(won.map((o) => o.monetaryValue ?? 0)),
    open: open.length,
    openValue: sum(open.map((o) => o.monetaryValue ?? 0)),
  };
}

function zdExpected(from: string, to: string) {
  const live = s.zd.tickets.filter((t) => t.status !== "deleted");
  const created = live.filter((t) => inRange(localDay(t.created_at, BIZ_TZ), from, to));
  const replied = created.filter((t) => t.metric.reply != null);
  const rated = created.filter((t) => t.satisfaction_rating && ["good", "bad"].includes(t.satisfaction_rating.score));
  return {
    created: created.length,
    solved: live.filter((t) => ["solved", "closed"].includes(t.status) && inRange(t.metric.solved_at && localDay(t.metric.solved_at, BIZ_TZ), from, to)).length,
    replies: replied.length,
    minutes: sum(replied.map((t) => t.metric.reply!)),
    rated: rated.length,
    good: rated.filter((t) => t.satisfaction_rating!.score === "good").length,
    email: created.filter((t) => t.via.channel === "email").length,
    open: live.filter((t) => ["new", "open", "pending", "hold"].includes(t.status)).length,
  };
}

function icExpected(from: string, to: string) {
  const inbound = s.ic.conversations.filter((c) => c.source.delivered_as === "customer_initiated");
  const created = inbound.filter((c) => inRange(localDay(c.created_at * 1000, IC_TZ), from, to));
  const reply = (c: (typeof created)[number]) => (c.statistics.time_to_admin_reply != null ? c.statistics.time_to_admin_reply / 60 : c.statistics.first_admin_reply_at != null ? (c.statistics.first_admin_reply_at - c.created_at) / 60 : null);
  const replied = created.filter((c) => reply(c) != null);
  const rated = created.filter((c) => c.conversation_rating);
  return {
    created: created.length,
    solved: inbound.filter((c) => c.state === "closed" && inRange(localDay(c.statistics.last_close_at! * 1000, IC_TZ), from, to)).length,
    replies: replied.length,
    minutes: sum(replied.map((c) => Math.round(reply(c)! * 100) / 100)),
    rated: rated.length,
    good: rated.filter((c) => c.conversation_rating!.rating >= 4).length,
    email: created.filter((c) => c.source.type === "email").length,
    open: s.ic.conversations.filter((c) => c.open).length,
  };
}

// ====================================================================== Salesforce + GoHighLevel

describe("Salesforce (OAuth web server flow)", () => {
  let owner: any, businessId: string, connectionId: string;

  it("builds the authorize URL (login host, scopes, PKCE) and discovers the org on callback", async () => {
    owner = await signup(app, "SfOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme CRM"));
    const bad = await owner.post(`/api/businesses/${businessId}/connections/salesforce/authorize`, { input: { loginUrl: "https://evil.example.com" } });
    expect(bad.status).toBe(400);
    const auth = await owner.post(`/api/businesses/${businessId}/connections/salesforce/authorize`, { input: { loginUrl: `${SF_INSTANCE}/` } });
    expect(auth.status).toBe(200);
    const url = new URL(auth.body.url);
    expect(url.pathname).toBe(`/${SF_INSTANCE}/services/oauth2/authorize`);
    expect(url.searchParams.get("scope")).toBe("api refresh_token");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    s.sf.challenge = url.searchParams.get("code_challenge");
    expect(s.sf.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cb = await owner.get(`/api/oauth/salesforce/callback?${new URLSearchParams({ code: "sf-good-code", state: url.searchParams.get("state")! })}`);
    const loc = new URL(cb.headers.location);
    expect(loc.searchParams.get("oauth_error")).toBeNull();
    connectionId = loc.searchParams.get("connection")!;
    const conn = await connection(owner, businessId, connectionId);
    expect(conn.accountName).toBe("Acme Corp");
    expect(conn.assets[0]).toMatchObject({ timezone: SF_TZ, currency: "USD" });
    expect(JSON.stringify(conn)).not.toMatch(/00D!AT|5Aep/);
    const sel = await owner.put(`/api/businesses/${businessId}/connections/${connectionId}/assets`, { assetIds: [conn.assets[0].id] });
    expect(sel.status).toBe(200);
  });

  it("imports leads and opportunities; CRM metrics reconcile with the source", async () => {
    await runAll();
    const conn = await connection(owner, businessId, connectionId);
    expect(conn.latestJob.status).toBe("succeeded");
    const today = todayIn(SF_TZ);
    const from = await coveredFrom(connectionId);
    expect(from).toBe(addDays(today, -399));
    const e = sfExpected(from, today);
    const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, businessId, { metric: m, dateRange: { from, to: today }, ...extra });
    expect((await q("crm_new_contacts")).total).toBe(e.leads);
    expect((await q("crm_qualified_leads")).total).toBe(e.qualified);
    expect((await q("crm_deals_created")).total).toBe(e.created);
    expect((await q("crm_deals_won")).total).toBe(e.won);
    expect((await q("crm_deals_lost")).total).toBe(e.lost);
    expect((await q("crm_won_value")).total).toBeCloseTo(e.wonValue, 2); // EUR opportunities left out
    expect((await q("win_rate")).total).toBeCloseTo((e.won / (e.won + e.lost)) * 100, 6);

    const byPipeline = await q("crm_deals_won", { dimension: "pipeline" });
    expect(byPipeline.rows.map((r: any) => r.label).sort()).toEqual(["New Business", "Renewal"]);
    expect(sum(byPipeline.rows.map((r: any) => r.value))).toBe(e.won);
    const bySource = await q("crm_new_contacts", { dimension: "source_medium", limit: 20 });
    expect(sum(bySource.rows.map((r: any) => r.value))).toBe(e.leads);
    expect(bySource.rows.map((r: any) => r.label)).toContain("Partner Referral");
    const byStage = await q("crm_new_contacts", { dimension: "lifecycle_stage", limit: 20 });
    expect(byStage.rows.find((r: any) => r.label === "Closed - Converted")).toBeTruthy();

    const snap = (m: string, extra: Record<string, unknown> = {}) => metric(owner, businessId, { metric: m, dateRange: { from: today, to: today }, ...extra });
    expect((await snap("crm_open_deals")).total).toBe(e.open);
    expect((await snap("crm_open_pipeline")).total).toBeCloseTo(e.openValue, 2);
    const stages = await snap("crm_open_deals", { dimension: "deal_stage" });
    expect(sum(stages.rows.map((r: any) => r.value))).toBe(e.open);
    expect(stages.rows.map((r: any) => r.label)).toContain("Negotiation/Review");
    // Only ids, dates and categories are stored.
    const sample = (await pool.query("SELECT payload FROM source_records WHERE connection_id = $1 AND record_type = 'lead' LIMIT 1", [connectionId])).rows[0].payload;
    expect(Object.keys(sample).sort()).toEqual(["created", "qualified", "source", "stage"]);
  });

  it("incremental sync picks up a won deal, a new lead and a deletion", async () => {
    const today = todayIn(SF_TZ);
    const now = Date.now();
    const stamp = new Date(now).toISOString().replace("Z", "+0000");
    const deal = s.sf.opps.find((o) => !o.IsClosed && o.Amount != null && o.CurrencyIsoCode === "USD")!;
    Object.assign(deal, { IsClosed: true, IsWon: true, StageName: "Closed Won", CloseDate: today, SystemModstamp: stamp });
    s.sf.leads.push({ Id: "00QNEWLEAD000001", CreatedDate: stamp, LeadSource: "Web", Status: "Open - Not Contacted", IsConverted: false, ConvertedDate: null, SystemModstamp: stamp });
    const gone = s.sf.leads.find((l) => localDay(l.CreatedDate, SF_TZ) > addDays(today, -100))!;
    s.sf.leads = s.sf.leads.filter((l) => l !== gone);
    s.sf.deleted.Lead.push({ id: gone.Id, deletedDate: stamp });
    const queries = s.sf.calls.query;

    await syncNow(owner, businessId, connectionId);
    expect(s.sf.calls.query - queries).toBe(2); // one page of changed leads, one of changed opportunities
    const from = await coveredFrom(connectionId);
    const e = sfExpected(from, today);
    const t = sfExpected(today, today);
    const q = (m: string, f = from) => metric(owner, businessId, { metric: m, dateRange: { from: f, to: today } });
    expect((await q("crm_deals_won", today)).total).toBe(t.won);
    expect((await q("crm_won_value", today)).total).toBeCloseTo(t.wonValue, 2);
    expect((await q("crm_new_contacts")).total).toBe(e.leads);
    expect((await q("crm_open_deals", today)).total).toBe(e.open);
    expect((await q("crm_open_pipeline", today)).total).toBeCloseTo(e.openValue, 2);
  });

  describe("with GoHighLevel in the same business", () => {
    let ghlId: string;
    /** GoHighLevel's share of a figure (the business also has Salesforce). */
    const ghl = async (m: string, from: string, to: string) => {
      const rows = (await metric(owner, businessId, { metric: m, dateRange: { from, to }, dimension: "platform" })).rows;
      return rows.find((r: any) => r.label === "GoHighLevel")?.value ?? null;
    };

    it("validates the token and location before connecting", async () => {
      const post = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/gohighlevel/token`, { input });
      const badFormat = await post({ token: "not-a-token", locationId: s.ghl.locationId });
      expect(badFormat.status).toBe(400);
      expect(badFormat.body.error.message ?? badFormat.body.message ?? JSON.stringify(badFormat.body)).toMatch(/Private Integration token/);
      const wrong = await post({ token: ["pit", "-", "00000000-0000-4000-8000-000000000000"].join(""), locationId: s.ghl.locationId });
      expect(wrong.status).toBe(400);
      expect(JSON.stringify(wrong.body)).toMatch(/rejected the token/);
      const otherLoc = await post({ token: s.ghl.token, locationId: "SomeOtherLocation1" });
      expect(otherLoc.status).toBe(400);
      expect(JSON.stringify(otherLoc.body)).toMatch(/can't read that location/);
      expect(JSON.stringify([badFormat.body, wrong.body, otherLoc.body])).not.toContain(s.ghl.token);
    });

    it("connects, discovers the location and reconciles contacts and opportunities", async () => {
      const r = await connectWithToken(owner, businessId, "gohighlevel", { token: s.ghl.token, locationId: s.ghl.locationId }, runAll);
      ghlId = r.id;
      expect(r.conn.accountName).toBe("Acme Plumbing");
      expect(r.conn.assets[0]).toMatchObject({ timezone: GHL_TZ, currency: null });
      expect(r.conn.latestJob.status).toBe("succeeded");
      const today = todayIn(GHL_TZ);
      const from = await coveredFrom(ghlId);
      const e = ghlExpected(from, today);
      const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, businessId, { metric: m, dateRange: { from, to: today }, ...extra });
      expect(await ghl("crm_new_contacts", from, today)).toBe(e.contacts);
      expect(await ghl("crm_deals_created", from, today)).toBe(e.created);
      expect(await ghl("crm_deals_won", from, today)).toBe(e.won);
      expect(await ghl("crm_deals_lost", from, today)).toBe(e.lost);
      expect(await ghl("crm_won_value", from, today)).toBeCloseTo(e.wonValue, 2);
      expect((await q("crm_won_value")).currency).toBe("USD"); // business currency (GoHighLevel doesn't report one)
      const types = await q("crm_new_contacts", { dimension: "lifecycle_stage", limit: 20 });
      expect(types.rows.find((x: any) => x.label === "Customer").value).toBe(e.customers); // only GoHighLevel has this type
      const pipes = await q("crm_deals_created", { dimension: "pipeline" });
      expect(pipes.rows.map((x: any) => x.label)).toEqual(expect.arrayContaining(["Sales", "Upsell"]));
      expect(await ghl("crm_open_deals", today, today)).toBe(e.open);
      expect(await ghl("crm_open_pipeline", today, today)).toBeCloseTo(e.openValue, 2);
    });

    it("incremental sync: a won opportunity, a new contact and a deleted opportunity", async () => {
      const now = new Date().toISOString();
      const deal = s.ghl.opps.find((o) => o.status === "open" && o.monetaryValue != null)!;
      Object.assign(deal, { status: "won", lastStatusChangeAt: now, updatedAt: now });
      s.ghl.contacts.push({ id: "cNEW0001", dateAdded: now, dateUpdated: now, source: "Website Form", type: "lead" });
      const gone = s.ghl.opps.find((o) => o.status === "open" && o !== deal)!;
      s.ghl.opps = s.ghl.opps.filter((o) => o !== gone);
      const searches = s.ghl.calls.contactSearch;
      await syncNow(owner, businessId, ghlId);
      expect(s.ghl.calls.contactSearch - searches).toBe(1); // only recently updated contacts
      const today = todayIn(GHL_TZ);
      const t = ghlExpected(today, today);
      expect(await ghl("crm_deals_won", today, today)).toBe(t.won);
      expect(await ghl("crm_new_contacts", today, today)).toBe(t.contacts);
      expect(await ghl("crm_open_deals", today, today)).toBe(t.open);
      expect(await ghl("crm_open_pipeline", today, today)).toBeCloseTo(t.openValue, 2);
    });

    it("combines both CRMs: deals won sum, win rate from combined counts, platform rows", async () => {
      const today = todayIn(BIZ_TZ);
      const from = addDays(today, -300);
      const to = addDays(today, -2);
      const a = sfExpected(from, to);
      const b = ghlExpected(from, to);
      const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, businessId, { metric: m, dateRange: { from, to }, ...extra });
      expect((await q("crm_deals_won")).total).toBe(a.won + b.won);
      expect((await q("win_rate")).total).toBeCloseTo(((a.won + b.won) / (a.won + b.won + a.lost + b.lost)) * 100, 6);
      const rows = (await q("crm_deals_won", { dimension: "platform" })).rows;
      expect(Object.fromEntries(rows.map((r: any) => [r.label, r.value]))).toEqual({ Salesforce: a.won, GoHighLevel: b.won });
    });
  });

  it("refreshes the access token when it expires and revokes on disconnect", async () => {
    await expire(connectionId);
    const before = s.sf.calls.token.refresh_token ?? 0;
    await syncNow(owner, businessId, connectionId);
    expect(s.sf.calls.token.refresh_token).toBe(before + 1);
    const r = await owner.del(`/api/businesses/${businessId}/connections/${connectionId}`, { deleteData: true });
    expect(r.body.revoked).toBe(true);
    expect(s.sf.calls.revoke).toBe(1);
    expect(s.sf.refreshTokens.size).toBe(0);
  });
});

describe("Salesforce (client credentials flow)", () => {
  it("validates input, connects with the customer's connected app and re-requests expired tokens", async () => {
    const owner = await signup(app, "SfCc");
    const { businessId } = await workspaceWithBusiness(owner, "Acme CC");
    const post = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/salesforce/token`, { input });
    const good = { domain: `https://${SF_INSTANCE}`, clientId: s.sf.ccClientId, clientSecret: s.sf.ccClientSecret };
    const noMyDomain = await post({ ...good, domain: "https://login.salesforce.com" });
    expect(noMyDomain.status).toBe(400);
    expect(JSON.stringify(noMyDomain.body)).toMatch(/My Domain/);
    const badKey = await post({ ...good, clientId: "abc" });
    expect(badKey.status).toBe(400);
    expect(JSON.stringify(badKey.body)).toMatch(/consumer key/);
    const wrongSecret = await post({ ...good, clientSecret: "WRONGSECRET123456" });
    expect(wrongSecret.status).toBe(400);
    expect(JSON.stringify(wrongSecret.body)).toMatch(/rejected the consumer key or secret/);
    expect(JSON.stringify(wrongSecret.body)).not.toContain(s.sf.ccClientSecret);

    const r = await connectWithToken(owner, businessId, "salesforce", good, runAll);
    expect(r.conn.latestJob.status).toBe("succeeded");
    expect(r.conn.assets[0]).toMatchObject({ timezone: SF_TZ, currency: "USD" });
    const today = todayIn(SF_TZ);
    expect((await metric(owner, businessId, { metric: "crm_open_deals", dateRange: { from: today, to: today } })).total).toBe(sfExpected(today, today).open);

    await expire(r.id);
    const before = s.sf.calls.token.client_credentials ?? 0;
    await syncNow(owner, businessId, r.id);
    expect(s.sf.calls.token.client_credentials).toBe(before + 1);
    // The customer manages their own connected app: nothing to revoke.
    const revokes = s.sf.calls.revoke;
    await owner.del(`/api/businesses/${businessId}/connections/${r.id}`, { deleteData: true });
    expect(s.sf.calls.revoke).toBe(revokes);
  });
});

// ====================================================================== Zendesk

describe("Zendesk", () => {
  let owner: any, businessId: string, connectionId: string;

  it("validates the subdomain, email and token", async () => {
    owner = await signup(app, "ZdOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme Support"));
    const post = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/zendesk/token`, { input });
    const good = { subdomain: "https://acme.zendesk.com/agent", email: s.zd.email, apiToken: s.zd.token };
    expect(JSON.stringify((await post({ ...good, subdomain: "bad domain!" })).body)).toMatch(/subdomain/);
    expect(JSON.stringify((await post({ ...good, apiToken: "short" })).body)).toMatch(/API token/);
    const wrong = await post({ ...good, apiToken: ["X", "y".repeat(39)].join("") });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toMatch(/rejected the token/);

    const r = await connectWithToken(owner, businessId, "zendesk", good, runAll);
    connectionId = r.id;
    expect(r.conn.accountName).toBe("acme.zendesk.com");
    expect(r.conn.latestJob.status).toBe("succeeded");
  });

  it("imports tickets: volumes, channel breakdown, first reply time, CSAT and open backlog reconcile", async () => {
    const today = todayIn(BIZ_TZ);
    const from = await coveredFrom(connectionId);
    expect(from).toBe(addDays(today, -364));
    const e = zdExpected(from, today);
    const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, businessId, { metric: m, dateRange: { from, to: today }, ...extra });
    expect((await q("support_tickets_created")).total).toBe(e.created);
    expect((await q("support_tickets_solved")).total).toBe(e.solved);
    expect((await q("support_first_replies")).total).toBe(e.replies);
    expect((await q("support_avg_first_reply")).total).toBeCloseTo(e.minutes / e.replies, 6);
    expect((await q("support_csat")).total).toBeCloseTo((e.good / e.rated) * 100, 6);
    const byChannel = await q("support_tickets_created", { dimension: "channel" });
    expect(byChannel.rows.find((r: any) => r.label === "Email").value).toBe(e.email);
    expect(sum(byChannel.rows.map((r: any) => r.value))).toBe(e.created);
    expect((await metric(owner, businessId, { metric: "support_open_tickets", dateRange: { from: today, to: today } })).total).toBe(e.open);
  });

  it("incremental export: a solved ticket and a deleted ticket change the right days and the backlog", async () => {
    const now = new Date(Date.now() - 5_000).toISOString();
    const t = s.zd.tickets.find((x) => x.status === "open")!;
    Object.assign(t, { status: "solved", updated_at: now, metric: { ...t.metric, solved_at: now } });
    const today = todayIn(BIZ_TZ);
    const del = s.zd.tickets.find((x) => x.status === "new" && localDay(x.created_at, BIZ_TZ) > addDays(today, -200))!;
    Object.assign(del, { status: "deleted", updated_at: now });
    const exports = s.zd.calls.export;
    await syncNow(owner, businessId, connectionId);
    expect(s.zd.calls.export - exports).toBe(1); // resumed from the stored cursor
    const from = await coveredFrom(connectionId);
    const e = zdExpected(from, today);
    const q = async (m: string, f: string) => (await metric(owner, businessId, { metric: m, dateRange: { from: f, to: today } })).total;
    expect(await q("support_tickets_solved", today)).toBe(zdExpected(today, today).solved);
    expect(await q("support_tickets_created", from)).toBe(e.created);
    expect(await q("support_open_tickets", today)).toBe(e.open);
    expect((await pool.query("SELECT 1 FROM source_records WHERE connection_id = $1 AND provider_id = $2", [connectionId, String(del.id)])).rowCount).toBe(0);
  });

  it("re-running a sync with no changes leaves the facts identical", async () => {
    const snap = async () => (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
    const before = await snap();
    await syncNow(owner, businessId, connectionId);
    expect(await snap()).toEqual(before);
  });
});

// ====================================================================== Intercom

describe("Intercom", () => {
  let owner: any, businessId: string, connectionId: string;

  it("validates the token and region, then connects with the workspace timezone", async () => {
    owner = await signup(app, "IcOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme Chat"));
    const post = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/intercom/token`, { input });
    expect(JSON.stringify((await post({ accessToken: "short" })).body)).toMatch(/Intercom access token/);
    expect(JSON.stringify((await post({ accessToken: s.ic.token, region: "mars" })).body)).toMatch(/US, EU or AU/);
    const wrong = await post({ accessToken: ["dG9r", "x".repeat(40)].join("") });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toMatch(/rejected the token/);
    const r = await connectWithToken(owner, businessId, "intercom", { accessToken: s.ic.token, region: "US" }, runAll);
    connectionId = r.id;
    expect(r.conn.accountName).toBe("Acme Support");
    expect(r.conn.assets[0]).toMatchObject({ timezone: IC_TZ });
    expect(r.conn.latestJob.status).toBe("succeeded");
  });

  it("imports inbound conversations: volumes, replies, ratings and open backlog reconcile", async () => {
    const today = todayIn(IC_TZ);
    const from = await coveredFrom(connectionId);
    const e = icExpected(from, today);
    const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, businessId, { metric: m, dateRange: { from, to: today }, ...extra });
    expect((await q("support_tickets_created")).total).toBe(e.created);
    expect((await q("support_tickets_solved")).total).toBe(e.solved);
    expect((await q("support_first_replies")).total).toBe(e.replies);
    expect((await q("support_avg_first_reply")).total).toBeCloseTo(e.minutes / e.replies, 4);
    expect((await q("support_csat")).total).toBeCloseTo((e.good / e.rated) * 100, 6);
    const byChannel = await q("support_tickets_created", { dimension: "channel" });
    expect(byChannel.rows.find((r: any) => r.label === "Email").value).toBe(e.email);
    expect((await metric(owner, businessId, { metric: "support_open_tickets", dateRange: { from: today, to: today } })).total).toBe(e.open);
  });

  it("incremental sync: a closed and rated conversation updates solved, CSAT and the backlog", async () => {
    const now = Math.floor(Date.now() / 1000);
    const c = s.ic.conversations.find((x) => x.state === "open" && x.source.delivered_as === "customer_initiated")!;
    Object.assign(c, { state: "closed", open: false, updated_at: now, statistics: { ...c.statistics, last_close_at: now }, conversation_rating: { rating: 5 } });
    const searches = s.ic.calls.search;
    await syncNow(owner, businessId, connectionId);
    expect(s.ic.calls.search - searches).toBe(2); // changed conversations + open count
    const today = todayIn(IC_TZ);
    const from = await coveredFrom(connectionId);
    const q = async (m: string, f: string) => (await metric(owner, businessId, { metric: m, dateRange: { from: f, to: today } })).total;
    const e = icExpected(from, today);
    expect(await q("support_tickets_solved", today)).toBe(icExpected(today, today).solved);
    expect(await q("support_csat_rated", from)).toBe(e.rated);
    expect(await q("support_open_tickets", today)).toBe(e.open);
  });
});
