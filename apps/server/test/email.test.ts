import { addDays, todayIn } from "@bca/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, workspaceWithBusiness } from "./helpers.js";
import { bootApp, connection, connectWithToken, localDay, metric } from "./kit.js";
import { BREVO_KEY, KLAVIYO_KEY, KLAVIYO_TZ, MAILCHIMP_KEY, MAILCHIMP_TZ, startMockEmail } from "./mock-email.js";

const BIZ_TZ = "America/New_York"; // workspaceWithBusiness; Brevo reports no timezone
let mock: Awaited<ReturnType<typeof startMockEmail>>;
let app: any, pool: any, runAll: () => Promise<number>;

beforeAll(async () => {
  mock = await startMockEmail();
  Object.assign(process.env, {
    KLAVIYO_BASE_URL_OVERRIDE: mock.url,
    MAILCHIMP_BASE_URL_OVERRIDE: mock.url,
    BREVO_BASE_URL_OVERRIDE: mock.url,
  });
  ({ app, pool, runAll } = await bootApp());
});
afterAll(async () => mock?.close());

const coveredFrom = async (connectionId: string) =>
  (await pool.query("SELECT min(sync_cursor->>'coveredFrom') AS f FROM connection_assets WHERE connection_id = $1 AND selected", [connectionId])).rows[0].f as string;
const sync = async (c: any, businessId: string, connectionId: string) => {
  expect((await c.post(`/api/businesses/${businessId}/connections/${connectionId}/sync`)).status).toBe(202);
  await runAll();
};

// ---------------------------------------------------------------- expected figures from the mocks

function klaviyoExpected(from: string, to: string, campaignsOnly = false) {
  const rows = mock.state.klaviyo.rows.filter((r) => r.date >= from && r.date <= to && (!campaignsOnly || r.campaign));
  const sum = (k: "sends" | "opens" | "clicks" | "unsubs") => rows.reduce((t, r) => t + r[k], 0);
  return { sends: sum("sends"), opens: sum("opens"), clicks: sum("clicks"), unsubs: sum("unsubs") };
}
function mailchimpExpected(from: string, to: string, lists = ["list-main", "list-vip"]) {
  const rs = mock.state.mailchimp.reports.filter((r) => lists.includes(r.list_id) && localDay(r.send_time, MAILCHIMP_TZ) >= from && localDay(r.send_time, MAILCHIMP_TZ) <= to);
  return {
    sends: rs.reduce((t, r) => t + r.emails_sent - r.bounces.hard_bounces - r.bounces.soft_bounces - r.bounces.syntax_errors, 0),
    opens: rs.reduce((t, r) => t + r.opens.unique_opens, 0),
    clicks: rs.reduce((t, r) => t + r.clicks.unique_subscriber_clicks, 0),
    unsubs: rs.reduce((t, r) => t + r.unsubscribed, 0),
    reports: rs,
  };
}
function brevoExpected(from: string, to: string) {
  const cs = mock.state.brevo.campaigns.filter((c) => localDay(c.sentDate, BIZ_TZ) >= from && localDay(c.sentDate, BIZ_TZ) <= to);
  const g = (k: "delivered" | "uniqueViews" | "uniqueClicks" | "unsubscriptions") => cs.reduce((t, c) => t + c.statistics.globalStats[k], 0);
  return { sends: g("delivered"), opens: g("uniqueViews"), clicks: g("uniqueClicks"), unsubs: g("unsubscriptions"), campaigns: cs };
}

async function totals(c: any, businessId: string, from: string, to: string, extra: Record<string, unknown> = {}) {
  const q = async (m: string) => (await metric(c, businessId, { metric: m, dateRange: { from, to }, ...extra })).total;
  return { sends: await q("email_sends"), opens: await q("email_opens"), clicks: await q("email_clicks"), unsubs: await q("email_unsubscribes") };
}

// ---------------------------------------------------------------- Klaviyo

describe("Klaviyo connector", () => {
  let owner: any, businessId: string, connectionId: string;

  it("rejects malformed keys and keys Klaviyo refuses", async () => {
    owner = await signup(app, "KlaviyoOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Klav"));
    const bad = await owner.post(`/api/businesses/${businessId}/connections/klaviyo/token`, { input: { apiKey: "AbC123" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message ?? JSON.stringify(bad.body)).toMatch(/pk_/);
    const refused = await owner.post(`/api/businesses/${businessId}/connections/klaviyo/token`, { input: { apiKey: ["pk", "ffffffffffffffffffffffffffffffffff"].join("_") } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/rejected the token/);
  });

  it("connects, discovers the account and imports daily totals that reconcile with Klaviyo", async () => {
    const r = await connectWithToken(owner, businessId, "klaviyo", { apiKey: KLAVIYO_KEY }, runAll);
    connectionId = r.id;
    expect(r.conn.assets).toHaveLength(1);
    expect(r.conn.assets[0]).toMatchObject({ name: "Acme Klaviyo", timezone: KLAVIYO_TZ, currency: "USD" });
    expect(r.conn.latestJob.status).toBe("succeeded");
    expect(JSON.stringify(r.conn)).not.toContain(KLAVIYO_KEY);
    expect(mock.state.klaviyo.calls.throttled).toBe(1); // a 429 was retried

    const from = await coveredFrom(connectionId);
    const today = todayIn(KLAVIYO_TZ);
    expect(from).toBe(addDays(today, -364));
    const e = klaviyoExpected(from, today);
    expect(await totals(owner, businessId, from, today)).toEqual(e);
    const rate = await metric(owner, businessId, { metric: "email_open_rate", dateRange: { from, to: today } });
    expect(rate.total).toBeCloseTo((e.opens / e.sends) * 100, 6);
    expect(rate.availability).toBe("available");

    // Campaign breakdown: campaigns only (flows count in totals), by Campaign Name.
    const byCampaign = await metric(owner, businessId, { metric: "email_sends", dimension: "campaign", dateRange: { from, to: today }, limit: 100 });
    expect(byCampaign.rows.reduce((t: number, x: any) => t + x.value, 0)).toBe(klaviyoExpected(from, today, true).sends);
    expect(byCampaign.rows.map((x: any) => x.label)).toContain("Monthly sale");

    // No de-duplicated subscriber count from Klaviyo.
    const size = await metric(owner, businessId, { metric: "email_list_size", dateRange: { from: today, to: today } });
    expect(size.availability).toBe("unavailable");
  });

  it("incremental syncs pick up new and late events and are idempotent", async () => {
    const today = todayIn(KLAVIYO_TZ);
    const yesterday = addDays(today, -1);
    mock.state.klaviyo.rows.push({ date: today, campaign: "Flash sale", sends: 500, opens: 120, clicks: 30, unsubs: 2 });
    mock.state.klaviyo.rows.find((x) => x.date === yesterday && !x.campaign)!.opens += 7; // late opens
    await sync(owner, businessId, connectionId);
    expect(await totals(owner, businessId, yesterday, today)).toEqual(klaviyoExpected(yesterday, today));
    const from = await coveredFrom(connectionId);
    const snap = async () => (await pool.query("SELECT count(*)::int AS n, sum(value)::float8 AS v FROM metric_facts WHERE connection_id = $1", [connectionId])).rows[0];
    const before = await snap();
    await sync(owner, businessId, connectionId);
    expect(await snap()).toEqual(before);
    expect(await totals(owner, businessId, from, today)).toEqual(klaviyoExpected(from, today));
  });
});

// ---------------------------------------------------------------- Mailchimp

describe("Mailchimp connector", () => {
  let owner: any, businessId: string, connectionId: string;

  it("rejects malformed keys and keys Mailchimp refuses", async () => {
    owner = await signup(app, "MailchimpOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Chimp"));
    const bad = await owner.post(`/api/businesses/${businessId}/connections/mailchimp/token`, { input: { apiKey: "0123456789abcdef0123456789abcdef" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/data center/);
    const refused = await owner.post(`/api/businesses/${businessId}/connections/mailchimp/token`, { input: { apiKey: ["ffffffffffffffffffffffffffffffff", "us21"].join("-") } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/rejected the token/);
  });

  it("discovers audiences and imports campaign reports by local send day", async () => {
    const r = await connectWithToken(owner, businessId, "mailchimp", { apiKey: MAILCHIMP_KEY }, runAll);
    connectionId = r.id;
    expect(r.conn.assets.map((a: any) => a.name).sort()).toEqual(["Newsletter", "VIP"]);
    expect(r.conn.assets.every((a: any) => a.timezone === MAILCHIMP_TZ)).toBe(true);
    expect(r.conn.latestJob.status).toBe("succeeded");

    const today = todayIn(MAILCHIMP_TZ);
    const from = await coveredFrom(connectionId);
    expect(from).toBe(addDays(today, -364));
    const e = mailchimpExpected(from, today);
    expect(e.reports.length).toBeGreaterThan(50); // more than one page from the mock
    const { reports: _r, ...sums } = e;
    expect(await totals(owner, businessId, from, today)).toEqual(sums);

    const byCampaign = await metric(owner, businessId, { metric: "email_opens", dimension: "campaign", dateRange: { from: addDays(today, -60), to: today }, limit: 100 });
    const recent = mailchimpExpected(addDays(today, -60), today);
    expect(byCampaign.rows.reduce((t: number, x: any) => t + x.value, 0)).toBe(recent.opens);
    expect(byCampaign.rows.map((x: any) => x.label)).toContain(recent.reports[0]!.campaign_title);

    // Audience size is a snapshot for today only (both audiences selected).
    const size = await metric(owner, businessId, { metric: "email_list_size", dateRange: { from: today, to: today } });
    expect(size.total).toBe(4200 + 350);
    const sizeMonth = await metric(owner, businessId, { metric: "email_list_size", dateRange: { from: addDays(today, -30), to: addDays(today, -1) } });
    expect(sizeMonth.availability).toBe("unavailable");
  });

  it("incremental syncs pick up newly sent campaigns, late opens and deletions", async () => {
    const today = todayIn(MAILCHIMP_TZ);
    const s = mock.state.mailchimp;
    const recent = s.reports.filter((x) => Date.parse(x.send_time) > Date.now() - 25 * 86_400_000);
    recent[0]!.opens.unique_opens += 111; // opens keep accruing
    const removed = recent[1]!;
    s.reports.splice(s.reports.indexOf(removed), 1);
    s.reports.push({
      id: "mc-new", list_id: "list-main", campaign_title: "Breaking news", subject_line: "News", type: "regular",
      send_time: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"), emails_sent: 4000, unsubscribed: 3,
      bounces: { hard_bounces: 2, soft_bounces: 3, syntax_errors: 0 }, opens: { unique_opens: 900 }, clicks: { unique_subscriber_clicks: 120 },
    });
    s.lists[0]!.member_count = 4260;
    await sync(owner, businessId, connectionId);

    const from = await coveredFrom(connectionId);
    const { reports: _r, ...sums } = mailchimpExpected(from, today);
    expect(await totals(owner, businessId, from, today)).toEqual(sums);
    const byCampaign = await metric(owner, businessId, { metric: "email_sends", dimension: "campaign", dateRange: { from: today, to: today }, limit: 100 });
    expect(byCampaign.rows.find((x: any) => x.label === "Breaking news")?.value).toBe(3995);
    expect((await metric(owner, businessId, { metric: "email_list_size", dateRange: { from: today, to: today } })).total).toBe(4260 + 350);
  });
});

// ---------------------------------------------------------------- Brevo

describe("Brevo connector", () => {
  let owner: any, businessId: string, connectionId: string;

  it("rejects malformed keys and keys Brevo refuses", async () => {
    owner = await signup(app, "BrevoOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Brev"));
    const bad = await owner.post(`/api/businesses/${businessId}/connections/brevo/token`, { input: { apiKey: ["xsmtpsib", "abc"].join("-") } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/xkeysib-/);
    const refused = await owner.post(`/api/businesses/${businessId}/connections/brevo/token`, { input: { apiKey: ["xkeysib", "f".repeat(64), "ZZZZZZZZZZZZZZZZ"].join("-") } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/rejected the token/);
  });

  it("connects the account and imports sent campaigns in the business timezone", async () => {
    const r = await connectWithToken(owner, businessId, "brevo", { apiKey: BREVO_KEY }, runAll);
    connectionId = r.id;
    expect(r.conn.assets).toHaveLength(1);
    expect(r.conn.assets[0]).toMatchObject({ name: "Acme Brevo", timezone: null });
    expect(r.conn.latestJob.status).toBe("succeeded");
    expect(r.conn.latestJob.result ? JSON.stringify(r.conn.latestJob.result) : "").toMatch(/blocklisted/);

    const today = todayIn(BIZ_TZ);
    const from = await coveredFrom(connectionId);
    expect(from).toBe(addDays(today, -364));
    const { campaigns, ...sums } = brevoExpected(from, today);
    expect(campaigns.length).toBeGreaterThan(25); // paginated
    expect(await totals(owner, businessId, from, today)).toEqual(sums);
    const byCampaign = await metric(owner, businessId, { metric: "email_clicks", dimension: "campaign", dateRange: { from: addDays(today, -90), to: today }, limit: 100 });
    expect(byCampaign.rows.reduce((t: number, x: any) => t + x.value, 0)).toBe(brevoExpected(addDays(today, -90), today).clicks);
    expect((await metric(owner, businessId, { metric: "email_list_size", dateRange: { from: today, to: today } })).total).toBe(1800);
  });

  it("incremental syncs pick up a newly sent campaign and updated open counts", async () => {
    const today = todayIn(BIZ_TZ);
    const s = mock.state.brevo;
    const recent = s.campaigns.filter((c) => Date.parse(c.sentDate) > Date.now() - 20 * 86_400_000);
    recent[0]!.statistics.globalStats.uniqueViews += 55;
    s.campaigns.push({ id: 9999, name: "Launch", subject: "New!", type: "classic", status: "sent", sentDate: new Date(Date.now() - 60_000).toISOString(),
      statistics: { globalStats: { sent: 2010, delivered: 2000, uniqueViews: 640, uniqueClicks: 77, unsubscriptions: 4 } } });
    s.contacts = 1850;
    await sync(owner, businessId, connectionId);
    const from = await coveredFrom(connectionId);
    const { campaigns: _c, ...sums } = brevoExpected(from, today);
    expect(await totals(owner, businessId, from, today)).toEqual(sums);
    const launch = await metric(owner, businessId, { metric: "email_sends", dimension: "campaign", dateRange: { from: today, to: today } });
    expect(launch.rows.find((x: any) => x.label === "Launch")?.value).toBe(2000);
    expect((await metric(owner, businessId, { metric: "email_list_size", dateRange: { from: today, to: today } })).total).toBe(1850);
  });
});

// ---------------------------------------------------------------- combined

describe("Mailchimp + Brevo on one business", () => {
  it("sums deliveries across platforms and computes the open rate on combined figures", async () => {
    const owner = await signup(app, "ComboOwner");
    const { businessId } = await workspaceWithBusiness(owner, "Combo");
    const mc = await connectWithToken(owner, businessId, "mailchimp", { apiKey: MAILCHIMP_KEY }, runAll, (a) => a.name === "Newsletter");
    const br = await connectWithToken(owner, businessId, "brevo", { apiKey: BREVO_KEY }, runAll);
    expect((await connection(owner, businessId, mc.id)).latestJob.status).toBe("succeeded");
    expect(br.conn.latestJob.status).toBe("succeeded");

    // A range both platforms fully cover (dates are each platform's local days).
    const to = addDays(todayIn(BIZ_TZ), -1);
    const from = addDays(to, -29);
    const m = mailchimpExpected(from, to, ["list-main"]);
    const b = brevoExpected(from, to);
    const sends = await metric(owner, businessId, { metric: "email_sends", dateRange: { from, to } });
    expect(sends.total).toBe(m.sends + b.sends);
    expect(sends.limitations.join(" ")).toMatch(/combines/);
    const rate = await metric(owner, businessId, { metric: "email_open_rate", dateRange: { from, to } });
    expect(rate.total).toBeCloseTo(((m.opens + b.opens) / (m.sends + b.sends)) * 100, 6);
    const byPlatform = await metric(owner, businessId, { metric: "email_sends", dimension: "platform", dateRange: { from, to } });
    expect(byPlatform.rows.reduce((t: number, x: any) => t + x.value, 0)).toBe(m.sends + b.sends);
    // Snapshots are dated in each platform's own timezone (Mailchimp: the account's, Brevo: the business's).
    const size = async (provider: string, tz: string) => (await metric(owner, businessId, { metric: "email_list_size", sources: [provider], dateRange: { from: todayIn(tz), to: todayIn(tz) } })).total;
    expect(await size("mailchimp", MAILCHIMP_TZ)).toBe(mock.state.mailchimp.lists[0]!.member_count);
    expect(await size("brevo", BIZ_TZ)).toBe(mock.state.brevo.contacts);
  });
});
