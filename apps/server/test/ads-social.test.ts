import { addDays, todayIn } from "@bca/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, workspaceWithBusiness } from "./helpers.js";
import { bootApp, connection, connectWithToken, metric } from "./kit.js";
import {
  GRAPH_V, LINKEDIN_ACCOUNT, META_TZ, startMockAdsSocial, TIKTOK_ADVERTISER, TIKTOK_FORBIDDEN_ADVERTISER, TIKTOK_TZ, TOKENS, type AdsSocialState, type MetaRow,
} from "./mock-ads-social.js";

let mock: Awaited<ReturnType<typeof startMockAdsSocial>>;
let s: AdsSocialState;
let app: any;
let pool: any;
let runAll: () => Promise<number>;

beforeAll(async () => {
  mock = await startMockAdsSocial();
  s = mock.state;
  Object.assign(process.env, {
    META_BASE_URL_OVERRIDE: mock.url,
    TIKTOK_BASE_URL_OVERRIDE: mock.url,
    LINKEDIN_BASE_URL_OVERRIDE: mock.url,
    META_APP_ID: "test-meta-app",
    META_APP_SECRET: ["meta", "-app-", "secret"].join(""),
    TIKTOK_APP_ID: "test-tiktok-app",
    TIKTOK_APP_SECRET: "test-tiktok-secret",
    LINKEDIN_CLIENT_ID: "test-li-client",
    LINKEDIN_CLIENT_SECRET: "test-li-secret",
    APP_URL: "http://app.test",
    API_URL: "https://api.example.test",
  });
  ({ app, pool, runAll } = await bootApp());
}, 60_000);
afterAll(async () => mock?.close());

const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
function metaExpected(account: string, from: string, to: string, filter: (r: MetaRow) => boolean = () => true) {
  const rows = s.meta.rows.filter((r) => r.account === account && r.date >= from && r.date <= to && filter(r));
  const one = (list: { action_type: string; value: string }[]) => {
    const t = PURCHASE.find((x) => list.some((a) => a.action_type === x));
    return t ? Number(list.find((a) => a.action_type === t)!.value) : 0;
  };
  return {
    spend: rows.reduce((t, r) => t + r.spend, 0),
    impressions: rows.reduce((t, r) => t + r.impressions, 0),
    clicks: rows.reduce((t, r) => t + r.clicks, 0),
    conversions: rows.reduce((t, r) => t + one(r.actions), 0),
    value: rows.reduce((t, r) => t + one(r.action_values), 0),
  };
}
const coveredFrom = async (connectionId: string) => (await pool.query("SELECT sync_cursor->>'coveredFrom' AS f FROM connection_assets WHERE connection_id = $1 AND selected", [connectionId])).rows[0].f as string;
const tokenConnect = (c: any, businessId: string, provider: string, input: Record<string, string>) => c.post(`/api/businesses/${businessId}/connections/${provider}/token`, { input });

/** Start OAuth and complete the callback as the provider would. */
async function oauth(c: any, businessId: string, provider: string, params: Record<string, string>) {
  const auth = await c.post(`/api/businesses/${businessId}/connections/${provider}/authorize`, { input: {} });
  expect(auth.status).toBe(200);
  const url = new URL(auth.body.url);
  const cb = await c.get(`/api/oauth/${provider}/callback?${new URLSearchParams({ ...params, state: url.searchParams.get("state")! })}`);
  expect(cb.status).toBe(302);
  const loc = new URL(cb.headers.location);
  return { url, connectionId: loc.searchParams.get("connection"), error: loc.searchParams.get("oauth_error") };
}

describe("Meta, TikTok and LinkedIn connectors (against local stand-ins)", () => {
  let owner: any, businessId: string, metaConn: string;

  it("lists all five as implemented", async () => {
    owner = await signup(app, "Owner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme"));
    const list = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    for (const id of ["meta_ads", "facebook_pages", "instagram", "tiktok_ads", "linkedin_ads"]) {
      const e = list.find((x: any) => x.id === id);
      expect(e.status).not.toBe("planned");
      expect(e.tokenConnect.fields.length).toBeGreaterThan(0);
    }
  });

  describe("Meta Ads", () => {
    it("validates tokens: format, Graph error 190 and missing ads_read", async () => {
      const bad = await tokenConnect(owner, businessId, "meta_ads", { accessToken: "not-a-token" });
      expect(bad.status).toBe(400);
      expect(bad.body.error.message ?? bad.body.message ?? JSON.stringify(bad.body)).toMatch(/doesn't look like a Meta access token/);
      const unknown = await tokenConnect(owner, businessId, "meta_ads", { accessToken: TOKENS.metaUnknown });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(unknown.body)).toMatch(/rejected the token/);
      const noAds = await tokenConnect(owner, businessId, "meta_ads", { accessToken: TOKENS.metaNoAds });
      expect(noAds.status).toBe(400);
      expect(JSON.stringify(noAds.body)).toMatch(/missing the permission ads_read/);
      expect(JSON.stringify([bad.body, unknown.body, noAds.body])).not.toContain(TOKENS.metaUnknown);
    });

    it("discovers ad accounts and imports campaign insights that reconcile with the source", async () => {
      const before = s.meta.calls.insights;
      const { id, conn } = await connectWithToken(owner, businessId, "meta_ads", { accessToken: TOKENS.meta }, runAll, (a) => a.name.startsWith("Acme US"));
      metaConn = id;
      expect(conn.assets.map((a: any) => [a.name, a.currency, a.timezone]).sort()).toEqual([
        ["Acme EU (222)", "EUR", "Europe/Berlin"],
        ["Acme US (111)", "USD", META_TZ],
      ]); // the closed account is skipped
      expect(conn.latestJob.status).toBe("succeeded");
      expect(JSON.stringify(conn)).not.toContain(TOKENS.meta);
      // 12 windows of 31 days, each paged (40 rows per page).
      expect(s.meta.calls.insights - before).toBeGreaterThanOrEqual(24);

      const today = todayIn(META_TZ);
      const from = await coveredFrom(id);
      expect(from).toBe(addDays(today, -364));
      const e = metaExpected("111", from, today);
      const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, businessId, { metric: m, dateRange: { from, to: today }, ...extra });
      expect((await q("ad_spend")).total).toBeCloseTo(e.spend, 2);
      expect((await q("ad_impressions")).total).toBe(e.impressions);
      expect((await q("ad_clicks")).total).toBe(e.clicks);
      expect((await q("ad_conversions")).total).toBe(e.conversions); // one purchase type per row, never summed
      expect((await q("ad_conversion_value")).total).toBeCloseTo(e.value, 2);

      // A day without delivery is a real zero, not missing data.
      const zeroDay = addDays(today, -5);
      expect(s.meta.rows.some((r) => r.account === "111" && r.date === zeroDay)).toBe(false);
      const z = await metric(owner, businessId, { metric: "ad_spend", dateRange: { from: zeroDay, to: zeroDay } });
      expect(z.total).toBe(0);
      expect(z.availability).toBe("available");

      const byCampaign = await q("ad_spend", { dimension: "campaign", limit: 10 });
      expect(byCampaign.rows.map((r: any) => r.label).sort()).toEqual(["Catalog Sales", "Prospecting", "Retargeting"]);
      expect(byCampaign.rows.reduce((t: number, r: any) => t + r.value, 0)).toBeCloseTo(e.spend, 2);
      const pros = metaExpected("111", from, today, (r) => r.campaign_name === "Prospecting");
      expect(byCampaign.rows.find((r: any) => r.label === "Prospecting").value).toBeCloseTo(pros.spend, 2);
    });

    it("picks up restated conversions within the attribution window on the next sync", async () => {
      const today = todayIn(META_TZ);
      const day = addDays(today, -12);
      const row = s.meta.rows.find((r) => r.account === "111" && r.date === day)!;
      row.spend += 50;
      row.actions = [{ action_type: "omni_purchase", value: "9" }, { action_type: "purchase", value: "9" }];
      row.action_values = [{ action_type: "omni_purchase", value: "999.5" }, { action_type: "purchase", value: "999.5" }];
      await owner.post(`/api/businesses/${businessId}/connections/${metaConn}/sync`);
      await runAll();
      const e = metaExpected("111", day, day);
      const q = (m: string) => metric(owner, businessId, { metric: m, dateRange: { from: day, to: day } });
      expect((await q("ad_spend")).total).toBeCloseTo(e.spend, 2);
      expect((await q("ad_conversions")).total).toBe(e.conversions);
      expect((await q("ad_conversion_value")).total).toBeCloseTo(e.value, 2);
    });

    it("signs in with Facebook and exchanges for a long-lived token (with appsecret_proof)", async () => {
      const { businessId: b2 } = await workspaceWithBusiness(owner, "Acme OAuth");
      const r = await oauth(owner, b2, "meta_ads", { code: "fb-good-code" });
      expect(r.url.pathname).toBe(`/www.facebook.com/${GRAPH_V}/dialog/oauth`);
      expect(r.url.searchParams.get("scope")).toBe("ads_read");
      expect(r.url.searchParams.get("client_id")).toBe("test-meta-app");
      expect(r.error).toBeNull();
      expect(s.meta.calls.codeExchange).toBe(1);
      expect(s.meta.calls.longExchange).toBe(1);
      expect(s.meta.calls.proofChecked).toBeGreaterThan(0);
      const exp = (await pool.query("SELECT token_expires_at FROM connections WHERE id = $1", [r.connectionId])).rows[0].token_expires_at;
      const days = (new Date(exp).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(59);
      expect(days).toBeLessThan(61);
      const conn = await connection(owner, b2, r.connectionId!);
      expect(conn.assets.length).toBe(2);
      // A sync with the OAuth token sends appsecret_proof on every request (the stand-in enforces it).
      await owner.put(`/api/businesses/${b2}/connections/${r.connectionId}/assets`, { assetIds: [conn.assets.find((a: any) => a.name.startsWith("Acme US")).id] });
      await runAll();
      expect((await connection(owner, b2, r.connectionId!)).latestJob.status).toBe("succeeded");
    });
  });

  describe("Facebook Pages and Instagram", () => {
    it("imports Page insights (falling back from deprecated metric names) and a follower snapshot", async () => {
      const { id, conn } = await connectWithToken(owner, businessId, "facebook_pages", { accessToken: TOKENS.meta }, runAll, (a) => a.name === "Acme Page");
      expect(conn.assets.map((a: any) => a.name).sort()).toEqual(["Acme Outlet", "Acme Page"]);
      expect(conn.latestJob.status).toBe("succeeded");
      expect(JSON.stringify(conn)).not.toMatch(/EAABpage/); // page tokens are never stored on assets
      const today = todayIn(META_TZ);
      const from = await coveredFrom(id);
      const data = s.meta.pageData.get("901")!;
      const sum = (k: "reach" | "engagements" | "follows") => [...data].filter(([d]) => d >= from && d <= today).reduce((t, [, v]) => t + v[k], 0);
      const q = (m: string, f = from, t = today) => metric(owner, businessId, { metric: m, dateRange: { from: f, to: t } });
      expect((await q("social_reach")).total).toBe(sum("reach"));
      expect((await q("social_engagements")).total).toBe(sum("engagements"));
      expect((await q("social_new_followers")).total).toBe(sum("follows"));
      expect((await q("social_followers", today, today)).total).toBe(5321);
      // Followers history isn't invented.
      const old = await q("social_followers", addDays(today, -40), addDays(today, -35));
      expect(old.availability).not.toBe("available");
    });

    it("discovers Page-linked Instagram accounts and imports reach, interactions and follows", async () => {
      const { id, conn } = await connectWithToken(owner, businessId, "instagram", { accessToken: TOKENS.meta }, runAll);
      expect(conn.assets.map((a: any) => a.name)).toEqual(["@acme"]);
      expect(conn.latestJob.status).toBe("succeeded");
      const today = todayIn(META_TZ);
      const from = await coveredFrom(id);
      const data = s.meta.igData.get("17841")!;
      const sum = (k: "reach" | "engagements" | "follows", f: string, t: string) => [...data].filter(([d]) => d >= f && d <= t).reduce((x, [, v]) => x + v[k], 0);
      // Both Facebook and Instagram report reach: query the Instagram platform only.
      const q = (m: string, f: string, t: string) => metric(owner, businessId, { metric: m, dateRange: { from: f, to: t }, dimension: "platform" });
      const val = (r: any) => r.rows.find((x: any) => /instagram/i.test(x.label))?.value;
      expect(val(await q("social_reach", from, today))).toBe(sum("reach", from, today));
      const recent = addDays(today, -30);
      expect(val(await q("social_engagements", recent, today))).toBe(sum("engagements", recent, today));
      expect(val(await q("social_new_followers", recent, addDays(today, -1)))).toBe(sum("follows", recent, addDays(today, -1)));
      expect(val(await q("social_followers", today, today))).toBe(2100);
    });
  });

  describe("TikTok Ads", () => {
    let ttConn: string;

    let tto: any, ttBiz: string;
    it("validates tokens and maps non-zero response codes", async () => {
      // Token connects are rate limited per user: each section uses its own user.
      tto = await signup(app, "TikToker");
      ({ businessId: ttBiz } = await workspaceWithBusiness(tto, "Acme Mixed"));
      const owner = tto, businessId = ttBiz;
      const bad = await tokenConnect(owner, businessId, "tiktok_ads", { accessToken: "short", advertiserIds: "" });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toMatch(/doesn't look like a TikTok/);
      const ids = await tokenConnect(owner, businessId, "tiktok_ads", { accessToken: TOKENS.tiktok, advertiserIds: "abc" });
      expect(JSON.stringify(ids.body)).toMatch(/Advertiser IDs are numbers/);
      const revoked = await tokenConnect(owner, businessId, "tiktok_ads", { accessToken: TOKENS.tiktokOther, advertiserIds: TIKTOK_ADVERTISER }); // code 40105
      expect(revoked.status).toBe(400);
      expect(JSON.stringify(revoked.body)).toMatch(/rejected the token/);
      const forbidden = await tokenConnect(owner, businessId, "tiktok_ads", { accessToken: TOKENS.tiktok, advertiserIds: TIKTOK_FORBIDDEN_ADVERTISER }); // code 40001
      expect(forbidden.status).toBe(400);
      expect(JSON.stringify(forbidden.body)).toMatch(/permission/);
    });

    it("connects (listing authorized advertisers when no IDs are given) and imports daily campaign reports", async () => {
      const owner = tto, b3 = ttBiz;
      const meta = await connectWithToken(owner, b3, "meta_ads", { accessToken: TOKENS.meta }, runAll, (a) => a.name.startsWith("Acme US"));
      const before = s.tiktok.calls.report;
      const { id, conn } = await connectWithToken(owner, b3, "tiktok_ads", { accessToken: TOKENS.tiktok, advertiserIds: "" }, runAll);
      ttConn = id;
      expect(conn.assets.map((a: any) => [a.name, a.currency, a.timezone])).toEqual([[`Acme TikTok (${TIKTOK_ADVERTISER})`, "USD", TIKTOK_TZ]]);
      expect(conn.latestJob.status).toBe("succeeded");
      expect(s.tiktok.calls.report - before).toBeGreaterThan(13); // ≤30-day windows, paged

      const today = todayIn(TIKTOK_TZ);
      const from = await coveredFrom(id);
      const rows = s.tiktok.rows.filter((r) => r.date >= from && r.date <= today);
      const spend = rows.reduce((t, r) => t + r.spend, 0);
      const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, b3, { metric: m, dateRange: { from, to: today }, dimension: "platform", ...extra });
      const tt = (r: any) => r.rows.find((x: any) => /tiktok/i.test(x.label)).value;
      expect(tt(await q("ad_spend"))).toBeCloseTo(spend, 2);
      expect(tt(await q("ad_impressions"))).toBe(rows.reduce((t, r) => t + r.impressions, 0));
      expect(tt(await q("ad_clicks"))).toBe(rows.reduce((t, r) => t + r.clicks, 0));
      expect(tt(await q("ad_conversions"))).toBe(rows.reduce((t, r) => t + r.conversion, 0));

      // Meta + TikTok in one business: ad spend is the sum of both platforms, labelled as combined.
      const range = { from: addDays(todayIn(META_TZ), -30), to: addDays(todayIn(META_TZ), -1) };
      const both = await metric(owner, b3, { metric: "ad_spend", dateRange: range });
      const metaSpend = metaExpected("111", range.from, range.to).spend;
      const ttSpend = s.tiktok.rows.filter((r) => r.date >= range.from && r.date <= range.to).reduce((t, r) => t + r.spend, 0);
      expect(both.total).toBeCloseTo(metaSpend + ttSpend, 2);
      expect(both.limitations.join(" ")).toMatch(/combines/);
      const byPlatform = await metric(owner, b3, { metric: "ad_spend", dateRange: range, dimension: "platform" });
      expect(byPlatform.rows.length).toBe(2);
      expect(byPlatform.rows.find((r: any) => /meta/i.test(r.label)).value).toBeCloseTo(metaSpend, 2);
      expect(byPlatform.rows.find((r: any) => /tiktok/i.test(r.label)).value).toBeCloseTo(ttSpend, 2);
      expect(meta.conn.latestJob.status).toBe("succeeded");

      // Campaign breakdown.
      const byCampaign = await metric(owner, b3, { metric: "ad_clicks", dateRange: { from, to: today }, dimension: "campaign", limit: 20 });
      expect(byCampaign.rows.map((r: any) => r.label)).toEqual(expect.arrayContaining(["Spark Ads", "TopView Launch", "Prospecting"]));
      expect(byCampaign.rows.find((r: any) => r.label === "Spark Ads").value).toBe(rows.filter((r) => r.campaign_name === "Spark Ads").reduce((t, r) => t + r.clicks, 0));

      // A restated day is picked up; a revoked token flags the connection for reconnection.
      const day = addDays(today, -3);
      const row = s.tiktok.rows.find((r) => r.date === day) ?? (s.tiktok.rows.push({ advertiser: TIKTOK_ADVERTISER, date: day, campaign_id: "1801", campaign_name: "Spark Ads", spend: 0, impressions: 10, clicks: 1, conversion: 0 }), s.tiktok.rows.at(-1)!);
      row.spend += 25;
      row.conversion += 4;
      await owner.post(`/api/businesses/${b3}/connections/${ttConn}/sync`);
      await runAll();
      const dayRows = s.tiktok.rows.filter((r) => r.date === day);
      const d = await metric(owner, b3, { metric: "ad_conversions", dateRange: { from: day, to: day }, dimension: "platform" });
      expect(tt(d)).toBe(dayRows.reduce((t, r) => t + r.conversion, 0));

      s.tiktok.tokens.delete(TOKENS.tiktok);
      await owner.post(`/api/businesses/${b3}/connections/${ttConn}/sync`);
      await runAll();
      const after = await connection(owner, b3, ttConn);
      expect(after.status).toBe("reauth_required");
      expect(after.lastError).toMatch(/Reconnect/);
    });
  });

  describe("TikTok Ads sign-in", () => {
    it("authorizes through the TikTok portal and exchanges the auth_code", async () => {
      const u = await signup(app, "TikTokOAuth");
      const { businessId: b } = await workspaceWithBusiness(u, "Acme TT OAuth");
      const r = await oauth(u, b, "tiktok_ads", { auth_code: "tt-good-code", code: "tt-good-code" });
      expect(r.url.pathname).toBe("/business-api.tiktok.com/portal/auth");
      expect(r.url.searchParams.get("app_id")).toBe("test-tiktok-app");
      expect(r.url.searchParams.get("redirect_uri")).toBe("https://api.example.test/api/oauth/tiktok_ads/callback");
      expect(r.error).toBeNull();
      const conn = await connection(u, b, r.connectionId!);
      expect(conn.assets.map((a: any) => a.providerAssetId ?? a.name)).toHaveLength(1);
      const bad = await oauth(u, b, "tiktok_ads", { auth_code: "wrong" }); // code 40002
      expect(bad.error).toMatch(/TikTok request failed/);
    });
  });

  describe("LinkedIn Ads", () => {
    let lio: any;
    it("rejects an invalid pasted token", async () => {
      lio = await signup(app, "Linker");
      const owner = lio;
      const { businessId } = await workspaceWithBusiness(owner, "Acme LI");
      const r = await tokenConnect(owner, businessId, "linkedin_ads", { accessToken: ["AQV", "x".repeat(60)].join("") });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/rejected the token/);
    });

    it("authorizes with OAuth, imports campaign analytics (Rest.li encoded) and refreshes tokens", async () => {
      const owner = lio;
      const { businessId: b4 } = await workspaceWithBusiness(owner, "Acme B2B");
      const r = await oauth(owner, b4, "linkedin_ads", { code: "li-good-code" });
      expect(r.url.pathname).toBe("/www.linkedin.com/oauth/v2/authorization");
      expect(r.url.searchParams.get("scope")).toBe("r_ads r_ads_reporting");
      expect(r.url.searchParams.get("redirect_uri")).toBe("https://api.example.test/api/oauth/linkedin_ads/callback");
      expect(r.error).toBeNull();
      const conn = await connection(owner, b4, r.connectionId!);
      expect(conn.assets.map((a: any) => [a.name, a.currency, a.timezone])).toEqual([[`Acme LinkedIn (${LINKEDIN_ACCOUNT})`, "USD", null]]);
      await owner.put(`/api/businesses/${b4}/connections/${r.connectionId}/assets`, { assetIds: [conn.assets[0].id] });
      await runAll();
      expect((await connection(owner, b4, r.connectionId!)).latestJob.status).toBe("succeeded");
      expect(s.linkedin.calls.badEncoding).toBe(0);

      // LinkedIn days are UTC days.
      const today = todayIn("UTC");
      const from = await coveredFrom(r.connectionId!);
      const to = addDays(today, -1);
      const rows = s.linkedin.rows.filter((x) => x.date >= from && x.date <= to);
      const q = (m: string, extra: Record<string, unknown> = {}) => metric(owner, b4, { metric: m, dateRange: { from, to }, ...extra });
      expect((await q("ad_spend")).total).toBeCloseTo(rows.reduce((t, x) => t + x.cost, 0), 2);
      expect((await q("ad_impressions")).total).toBe(rows.reduce((t, x) => t + x.impressions, 0));
      expect((await q("ad_conversions")).total).toBe(rows.reduce((t, x) => t + x.conversions, 0));
      expect((await q("ad_conversion_value")).total).toBeCloseTo(rows.reduce((t, x) => t + x.value, 0), 2);
      const byCampaign = await q("ad_clicks", { dimension: "campaign" });
      expect(byCampaign.rows.map((x: any) => x.label).sort()).toEqual(["Brand Awareness", "Lead Gen Forms", "Website Visits"]);
      expect(byCampaign.rows.find((x: any) => x.label === "Lead Gen Forms").value).toBe(rows.filter((x) => x.campaign === "7002").reduce((t, x) => t + x.clicks, 0));

      // Expired access token → refreshed with the refresh token before syncing.
      await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [r.connectionId]);
      const before = s.linkedin.calls.refresh;
      await owner.post(`/api/businesses/${b4}/connections/${r.connectionId}/sync`);
      await runAll();
      expect(s.linkedin.calls.refresh).toBe(before + 1);
      const after = await connection(owner, b4, r.connectionId!);
      expect(after.latestJob.status).toBe("succeeded");
      const exp = (await pool.query("SELECT token_expires_at FROM connections WHERE id = $1", [r.connectionId])).rows[0].token_expires_at;
      expect(new Date(exp).getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);

      // Revoked refresh token → reconnect.
      s.linkedin.refreshTokens.clear();
      await pool.query("UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [r.connectionId]);
      await owner.post(`/api/businesses/${b4}/connections/${r.connectionId}/sync`);
      await runAll();
      expect((await connection(owner, b4, r.connectionId!)).status).toBe("reauth_required");
    });

    it("connects with a pasted developer-portal token", async () => {
      const owner = lio;
      const { businessId: b5 } = await workspaceWithBusiness(owner, "Acme Token");
      const { conn } = await connectWithToken(owner, b5, "linkedin_ads", { accessToken: TOKENS.linkedin }, runAll);
      expect(conn.latestJob.status).toBe("succeeded");
      expect(conn.assets.length).toBe(1);
    });
  });
});
