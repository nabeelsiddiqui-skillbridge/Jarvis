import { createHmac } from "node:crypto";
import type express from "express";
import { addDays, todayIn } from "@bca/shared";
import { startMock } from "./kit.js";

/**
 * Local stand-ins for the Meta Graph API (Marketing API insights, Pages, Instagram,
 * Facebook Login token exchange), the TikTok API for Business and the LinkedIn
 * Marketing API (+ LinkedIn OAuth), with deterministic raw data so tests can
 * reconcile imported figures with the source. Routes are host-prefixed, matching
 * providerUrl(): http://mock/<host>/<path>.
 */

export const META_TZ = "America/Los_Angeles";
export const META_EU_TZ = "Europe/Berlin";
export const TIKTOK_TZ = "America/Chicago";
export const GRAPH_V = "v23.0";

/** Fake tokens, assembled at runtime so nothing token-shaped is committed. */
const mk = (...p: string[]) => p.join("");
export const TOKENS = {
  meta: mk("EAA", "Btest", "0123456789", "abcdefABCDEF", "user1"),
  metaNoAds: mk("EAA", "Btest", "0123456789", "abcdefABCDEF", "noads"),
  metaUnknown: mk("EAA", "Btest", "0123456789", "abcdefABCDEF", "nobody"),
  metaShort: mk("EAA", "Bshort", "0123456789", "abcdefABCDEF"),
  metaLong: mk("EAA", "Blong", "0123456789", "abcdefABCDEF", "oauth"),
  tiktok: mk("tt", "0123456789abcdef", "0123456789abcdef", "abcd"),
  tiktokOther: mk("tt", "fedcba9876543210", "fedcba9876543210", "zzzz"),
  tiktokOauth: mk("tt", "0a0a0a0a0a0a0a0a", "0b0b0b0b0b0b0b0b", "oaut"),
  linkedin: mk("AQV", "test_", "0123456789abcdefghij", "0123456789abcdefghij"),
};
export const META_APP_SECRET = mk("meta", "-app-", "secret");
export const TIKTOK_ADVERTISER = "7000000000000000001";
export const TIKTOK_FORBIDDEN_ADVERTISER = "7000000000000000999";
export const LINKEDIN_ACCOUNT = "508001";

/** Deterministic [0,1) from a string. */
function h(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return ((x >>> 0) % 1_000_003) / 1_000_003;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const localDay = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// ------------------------------------------------------------------ data

export interface MetaRow { account: string; date: string; campaign_id: string; campaign_name: string; spend: number; impressions: number; clicks: number; actions: { action_type: string; value: string }[]; action_values: { action_type: string; value: string }[] }
export interface DayValues { reach: number; engagements: number; follows: number }
export interface TikTokRow { advertiser: string; date: string; campaign_id: string; campaign_name: string; spend: number; impressions: number; clicks: number; conversion: number }
export interface LinkedInRow { account: string; date: string; campaign: string; cost: number; impressions: number; clicks: number; conversions: number; value: number }

const DAYS = 420;

function makeMeta(account: string, tz: string): MetaRow[] {
  const camps = [["c1", "Prospecting"], ["c2", "Retargeting"], ["c3", "Catalog Sales"]] as const;
  const today = todayIn(tz);
  const out: MetaRow[] = [];
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(today, -i);
    if (i % 17 === 5) continue; // whole day without delivery → zero day
    for (const [id, name] of camps) {
      const k = `${account}|${date}|${id}`;
      if (h(k) < 0.15) continue;
      const spend = r2(5 + h(`${k}s`) * 120);
      const impressions = Math.round(500 + h(`${k}i`) * 9000);
      const clicks = Math.round(impressions * (0.005 + h(`${k}c`) * 0.03));
      const purchases = Math.floor(h(`${k}p`) * 6);
      const value = r2(purchases * (20 + h(`${k}v`) * 60));
      const style = h(`${k}t`);
      const actions: MetaRow["actions"] = [{ action_type: "link_click", value: String(clicks) }];
      const action_values: MetaRow["action_values"] = [];
      if (purchases) {
        if (style < 0.6) {
          // omni + purchase + pixel overlap: the connector must take ONE of them
          for (const t of ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]) {
            actions.push({ action_type: t, value: String(purchases) });
            action_values.push({ action_type: t, value: String(value) });
          }
        } else {
          actions.push({ action_type: "offsite_conversion.fb_pixel_purchase", value: String(purchases) });
          action_values.push({ action_type: "offsite_conversion.fb_pixel_purchase", value: String(value) });
        }
      }
      out.push({ account, date, campaign_id: `${account}${id}`, campaign_name: name, spend, impressions, clicks, actions, action_values });
    }
  }
  return out;
}

function makeSocial(seed: string): Map<string, DayValues> {
  const today = todayIn(META_TZ);
  const out = new Map<string, DayValues>();
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(today, -i);
    out.set(date, { reach: Math.round(200 + h(`${seed}${date}r`) * 4000), engagements: Math.round(h(`${seed}${date}e`) * 300), follows: Math.round(h(`${seed}${date}f`) * 25) });
  }
  return out;
}

function makeTikTok(): TikTokRow[] {
  const today = todayIn(TIKTOK_TZ);
  const out: TikTokRow[] = [];
  const camps = [["1801", "Spark Ads"], ["1802", "TopView Launch"]] as const;
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(today, -i);
    for (const [id, name] of camps) {
      const k = `tt|${date}|${id}`;
      if (h(k) < 0.25) continue;
      const impressions = Math.round(1000 + h(`${k}i`) * 20000);
      out.push({ advertiser: TIKTOK_ADVERTISER, date, campaign_id: id, campaign_name: name, spend: r2(3 + h(`${k}s`) * 80), impressions, clicks: Math.round(impressions * h(`${k}c`) * 0.02), conversion: Math.floor(h(`${k}v`) * 5) });
    }
  }
  return out;
}

function makeLinkedIn(): LinkedInRow[] {
  const today = todayIn("UTC");
  const out: LinkedInRow[] = [];
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(today, -i);
    for (const c of ["7001", "7002", "7003"]) {
      const k = `li|${date}|${c}`;
      if (h(k) < 0.3) continue;
      const conversions = Math.floor(h(`${k}v`) * 3);
      out.push({ account: LINKEDIN_ACCOUNT, date, campaign: c, cost: r2(10 + h(`${k}s`) * 200), impressions: Math.round(300 + h(`${k}i`) * 5000), clicks: Math.round(h(`${k}c`) * 60), conversions, value: r2(conversions * 150) });
    }
  }
  return out;
}

export function makeState() {
  return {
    meta: {
      users: new Map<string, { id: string; name: string; perms: string[]; oauth?: boolean }>([
        [TOKENS.meta, { id: "10001", name: "Ada Admin", perms: ["ads_read", "pages_show_list", "pages_read_engagement", "read_insights", "instagram_basic", "instagram_manage_insights"] }],
        [TOKENS.metaNoAds, { id: "10002", name: "No Ads", perms: ["pages_show_list"] }],
        [TOKENS.metaLong, { id: "10003", name: "Olive OAuth", perms: ["ads_read"], oauth: true }],
      ]),
      accounts: [
        { account_id: "111", name: "Acme US", currency: "USD", timezone_name: META_TZ, account_status: 1 },
        { account_id: "222", name: "Acme EU", currency: "EUR", timezone_name: META_EU_TZ, account_status: 1 },
        { account_id: "333", name: "Old account", currency: "USD", timezone_name: META_TZ, account_status: 101 },
      ],
      rows: [...makeMeta("111", META_TZ), ...makeMeta("222", META_EU_TZ)],
      pages: [
        { id: "901", name: "Acme Page", access_token: mk("EAA", "Bpage", "901", "0123456789abcdef"), followers_count: 5321, fan_count: 5000, instagram_business_account: { id: "17841", username: "acme", followers_count: 2100 } },
        { id: "902", name: "Acme Outlet", access_token: mk("EAA", "Bpage", "902", "0123456789abcdef"), followers_count: 800, fan_count: 790 },
      ],
      pageData: new Map<string, Map<string, DayValues>>([["901", makeSocial("p901")], ["902", makeSocial("p902")]]),
      igData: new Map<string, Map<string, DayValues>>([["17841", makeSocial("ig17841")]]),
      /** Page Insights names this mock "API version" no longer accepts (code 100). */
      deprecatedMetrics: new Set(["page_total_media_view_unique"]),
      calls: { insights: 0, codeExchange: 0, longExchange: 0, proofChecked: 0, pageInsights: 0 },
    },
    tiktok: {
      tokens: new Map<string, string[]>([[TOKENS.tiktok, [TIKTOK_ADVERTISER]]]),
      rows: makeTikTok(),
      calls: { report: 0 },
    },
    linkedin: {
      accessTokens: new Set<string>([TOKENS.linkedin]),
      refreshTokens: new Set<string>(),
      rows: makeLinkedIn(),
      campaigns: [{ id: 7001, name: "Brand Awareness" }, { id: 7002, name: "Lead Gen Forms" }, { id: 7003, name: "Website Visits" }],
      calls: { refresh: 0, analytics: 0, issued: 0, badEncoding: 0 },
    },
  };
}
export type AdsSocialState = ReturnType<typeof makeState>;

// ------------------------------------------------------------------ Meta

const graphErr = (res: express.Response, status: number, code: number, message: string) =>
  res.status(status).json({ error: { message, type: code === 190 ? "OAuthException" : "GraphMethodException", code, fbtrace_id: "AbCdEf" } });

function metaRoutes(s: AdsSocialState, req: express.Request, res: express.Response, segs: string[]) {
  const q = req.query as Record<string, string>;
  const m = s.meta;
  const v = segs[0];
  if (v !== GRAPH_V) return graphErr(res, 400, 2635, "Unsupported version");
  const path = segs.slice(1);

  // OAuth token exchanges (no bearer).
  if (path[0] === "oauth" && path[1] === "access_token") {
    if (q.client_id !== "test-meta-app" || q.client_secret !== META_APP_SECRET) return graphErr(res, 400, 101, "Error validating client secret.");
    if (q.grant_type === "fb_exchange_token") {
      m.calls.longExchange++;
      if (q.fb_exchange_token !== TOKENS.metaShort) return graphErr(res, 400, 190, "Invalid OAuth access token.");
      return res.json({ access_token: TOKENS.metaLong, token_type: "bearer", expires_in: 5_183_944 });
    }
    m.calls.codeExchange++;
    if (q.code !== "fb-good-code" || !q.redirect_uri) return graphErr(res, 400, 100, "Invalid verification code format.");
    return res.json({ access_token: TOKENS.metaShort, token_type: "bearer", expires_in: 5400 });
  }

  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const user = m.users.get(token);
  const page = m.pages.find((p) => p.access_token === token);
  if (!user && !page) return graphErr(res, 400, 190, "Invalid OAuth access token - Cannot parse access token");
  if (user?.oauth) {
    // Tokens issued to our app must carry appsecret_proof.
    const expected = createHmac("sha256", META_APP_SECRET).update(token).digest("hex");
    if (q.appsecret_proof !== expected) return graphErr(res, 400, 100, "Invalid appsecret_proof provided in the API argument");
    m.calls.proofChecked++;
  } else if (q.appsecret_proof) return graphErr(res, 400, 100, "Unexpected appsecret_proof");

  const paged = <T,>(items: T[], limitDefault = 25, cap = 25) => {
    const limit = Math.min(Number(q.limit ?? limitDefault) || limitDefault, cap);
    const after = Number(q.after ?? 0);
    const data = items.slice(after, after + limit);
    const nextQ = new URLSearchParams({ ...q, after: String(after + limit) });
    nextQ.delete("appsecret_proof");
    return { data, paging: after + limit < items.length ? { cursors: { after: String(after + limit) }, next: `https://graph.facebook.com/${v}/${path.join("/")}?${nextQ}` } : { cursors: {} } };
  };

  if (path[0] === "me") {
    if (!user) return graphErr(res, 400, 100, "Page tokens can't call /me here");
    if (path.length === 1) return res.json({ id: user.id, name: user.name });
    if (path[1] === "permissions") return res.json({ data: user.perms.map((p) => ({ permission: p, status: "granted" })) });
    if (path[1] === "adaccounts") {
      if (!user.perms.includes("ads_read")) return graphErr(res, 403, 200, "Requires ads_read permission");
      return res.json(paged(m.accounts.map((a) => ({ id: `act_${a.account_id}`, ...a })), 25, 2));
    }
    if (path[1] === "accounts") {
      if (!user.perms.includes("pages_show_list")) return graphErr(res, 403, 200, "Requires pages_show_list");
      const fields = q.fields ?? "";
      return res.json(paged(m.pages.map((p) => ({
        id: p.id, name: p.name,
        ...(fields.includes("followers_count") ? { followers_count: p.followers_count, fan_count: p.fan_count } : {}),
        ...(fields.includes("instagram_business_account") && p.instagram_business_account ? { instagram_business_account: p.instagram_business_account } : {}),
      })), 25, 1));
    }
  }

  // Ad account insights.
  const act = /^act_(\d+)$/.exec(path[0] ?? "");
  if (act) {
    const acct = m.accounts.find((a) => a.account_id === act[1]);
    if (!acct || !user?.perms.includes("ads_read")) return graphErr(res, 400, 100, "Unsupported get request.");
    if (path.length === 1) return res.json({ id: `act_${acct.account_id}`, account_id: acct.account_id, account_status: acct.account_status });
    if (path[1] !== "insights") return graphErr(res, 400, 100, "Unknown edge");
    m.calls.insights++;
    if (q.level !== "campaign" || q.time_increment !== "1") return graphErr(res, 400, 100, "Expected level=campaign&time_increment=1");
    const tr = JSON.parse(q.time_range ?? "{}");
    const rows = m.rows
      .filter((r) => r.account === acct.account_id && r.date >= tr.since && r.date <= tr.until)
      .sort((a, b) => (a.date + a.campaign_id).localeCompare(b.date + b.campaign_id))
      .map((r) => ({
        account_currency: acct.currency, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
        spend: r.spend.toFixed(2), impressions: String(r.impressions), clicks: String(r.clicks),
        actions: r.actions, action_values: r.action_values.length ? r.action_values : undefined,
        date_start: r.date, date_stop: r.date,
      }));
    return res.json(paged(rows, 25, 40));
  }

  // Pages and Instagram nodes.
  const pg = m.pages.find((p) => p.id === path[0]);
  if (pg) {
    if (path.length === 1) {
      const fields = (q.fields ?? "").split(",");
      if (fields.includes("access_token")) {
        if (!user?.perms.includes("pages_show_list")) return graphErr(res, 403, 10, "Permission denied");
        return res.json({ id: pg.id, access_token: pg.access_token });
      }
      return res.json({ id: pg.id, ...(fields.includes("followers_count") ? { followers_count: pg.followers_count, fan_count: pg.fan_count } : {}) });
    }
    if (path[1] === "insights") {
      m.calls.pageInsights++;
      if (page?.id !== pg.id) return graphErr(res, 400, 190, "This method must be called with a Page Access Token");
      const metric = q.metric!;
      const key = ({ page_total_media_view_unique: "reach", page_impressions_unique: "reach", page_post_engagements: "engagements", page_daily_follows_unique: "follows" } as Record<string, keyof DayValues>)[metric];
      if (!key || m.deprecatedMetrics.has(metric)) return graphErr(res, 400, 100, "(#100) The value must be a valid insights metric");
      return res.json({ data: [{ name: metric, period: q.period, values: seriesValues(m.pageData.get(pg.id)!, key, q) }], paging: {} });
    }
  }
  const ig = m.pages.find((p) => p.instagram_business_account?.id === path[0])?.instagram_business_account;
  if (ig) {
    if (!user?.perms.includes("instagram_basic")) return graphErr(res, 403, 10, "Permission denied");
    if (path.length === 1) return res.json({ id: ig.id, followers_count: ig.followers_count });
    if (path[1] === "insights") {
      if (!user.perms.includes("instagram_manage_insights")) return graphErr(res, 403, 10, "Permission denied");
      const data = m.igData.get(ig.id)!;
      if (q.metric === "reach") return res.json({ data: [{ name: "reach", period: "day", values: seriesValues(data, "reach", q) }] });
      if (q.metric === "follower_count") {
        // Only the last 30 days, excluding today.
        const today = todayIn(META_TZ);
        const values = seriesValues(data, "follows", q).filter((x) => x._day >= addDays(today, -30) && x._day < today);
        return res.json({ data: [{ name: "follower_count", period: "day", values }] });
      }
      if (q.metric === "total_interactions") {
        if (q.metric_type !== "total_value") return graphErr(res, 400, 100, "metric_type=total_value is required");
        const total = seriesValues(data, "engagements", q).reduce((t, x) => t + x.value, 0);
        return res.json({ data: [{ name: "total_interactions", period: "day", total_value: { value: total } }] });
      }
      return graphErr(res, 400, 100, "(#100) metric must be one of the following values: reach, follower_count, …");
    }
  }
  return graphErr(res, 400, 803, "Some of the aliases you requested do not exist");
}

/** Pacific midnight (UTC ISO with +0000) at the end of `date`. */
function endTime(date: string) {
  const next = addDays(date, 1);
  for (const hh of ["07", "08"]) {
    const iso = `${next}T${hh}:00:00Z`;
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: META_TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    if (Number(hour) === 0) return `${next}T${hh}:00:00+0000`;
  }
  return `${next}T08:00:00+0000`;
}

/** Days in [since, until) (unix seconds at Pacific midnight) with their values. */
function seriesValues(data: Map<string, DayValues>, key: keyof DayValues, q: Record<string, string>) {
  const from = localDay(new Date(Number(q.since) * 1000), META_TZ);
  const until = localDay(new Date(Number(q.until) * 1000), META_TZ);
  const out: { value: number; end_time: string; _day: string }[] = [];
  for (let d = from; d < until; d = addDays(d, 1)) {
    const v = data.get(d);
    if (v) out.push({ value: v[key], end_time: endTime(d), _day: d });
  }
  return out;
}

// ------------------------------------------------------------------ TikTok

function tiktokRoutes(s: AdsSocialState, req: express.Request, res: express.Response, path: string) {
  const t = s.tiktok;
  const q = req.query as Record<string, string>;
  const ok = (data: unknown) => res.json({ code: 0, message: "OK", request_id: "req-1", data });
  const err = (code: number, message: string) => res.json({ code, message, request_id: "req-1", data: {} });
  if (path === "oauth2/access_token/") {
    if (req.body?.app_id !== "test-tiktok-app" || req.body?.secret !== "test-tiktok-secret") return err(40001, "App not authorized");
    if (req.body?.auth_code !== "tt-good-code") return err(40002, "auth_code invalid");
    t.tokens.set(TOKENS.tiktokOauth, [TIKTOK_ADVERTISER]);
    return ok({ access_token: TOKENS.tiktokOauth, advertiser_ids: [TIKTOK_ADVERTISER], scope: [4, 1] });
  }
  const token = String(req.headers["access-token"] ?? "");
  const allowed = t.tokens.get(token);
  if (!allowed) return err(40105, "Access token is incorrect or has been revoked.");
  if (path === "oauth2/advertiser/get/") {
    if (q.app_id !== "test-tiktok-app" || q.secret !== "test-tiktok-secret") return err(40001, "App not authorized");
    return ok({ list: allowed.map((id) => ({ advertiser_id: id, advertiser_name: "Acme TikTok" })) });
  }
  if (path === "advertiser/info/") {
    const ids: string[] = JSON.parse(q.advertiser_ids ?? "[]");
    if (ids.some((id) => !allowed.includes(id))) return err(40001, "No permission to operate advertiser");
    return ok({ list: ids.map((id) => ({ advertiser_id: id, name: "Acme TikTok", currency: "USD", timezone: "Etc/GMT+6", display_timezone: TIKTOK_TZ, status: "STATUS_ENABLE" })) });
  }
  if (path === "report/integrated/get/") {
    t.calls.report++;
    if (!allowed.includes(q.advertiser_id!)) return err(40001, "No permission to operate advertiser");
    if (q.report_type !== "BASIC" || q.data_level !== "AUCTION_CAMPAIGN") return err(40002, "report_type/data_level invalid");
    const dims: string[] = JSON.parse(q.dimensions ?? "[]");
    if (dims.join() !== "campaign_id,stat_time_day") return err(40002, "dimensions invalid");
    const span = (Date.parse(q.end_date!) - Date.parse(q.start_date!)) / 86_400_000 + 1;
    if (!(span >= 1 && span <= 30)) return err(40002, "The time range cannot exceed 30 days when stat_time_day is used");
    const pageSize = Math.min(Number(q.page_size) || 10, 1000, 20); // the stand-in pages small to exercise paging
    const page = Number(q.page) || 1;
    const rows = t.rows.filter((r) => r.advertiser === q.advertiser_id && r.date >= q.start_date! && r.date <= q.end_date!).sort((a, b) => (a.date + a.campaign_id).localeCompare(b.date + b.campaign_id));
    const list = rows.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      dimensions: { campaign_id: r.campaign_id, stat_time_day: `${r.date} 00:00:00` },
      metrics: { campaign_name: r.campaign_name, spend: r.spend.toFixed(2), impressions: String(r.impressions), clicks: String(r.clicks), conversion: String(r.conversion) },
    }));
    return ok({ list, page_info: { page, page_size: pageSize, total_number: rows.length, total_page: Math.max(1, Math.ceil(rows.length / pageSize)) } });
  }
  return err(40002, `unknown path ${path}`);
}

// ------------------------------------------------------------------ LinkedIn

function linkedinRoutes(s: AdsSocialState, req: express.Request, res: express.Response, path: string) {
  const l = s.linkedin;
  const q = req.query as Record<string, string>;
  if (path === "oauth/v2/accessToken") {
    const b = req.body ?? {};
    if (b.client_id !== "test-li-client" || b.client_secret !== "test-li-secret") return res.status(401).json({ error: "invalid_client" });
    const issue = () => {
      l.calls.issued++;
      const at = `li-at-${l.calls.issued}`;
      const rt = `li-rt-${l.calls.issued}`;
      l.accessTokens.add(at);
      l.refreshTokens.add(rt);
      return { access_token: at, expires_in: 5_184_000, refresh_token: rt, refresh_token_expires_in: 31_536_000, scope: "r_ads,r_ads_reporting" };
    };
    if (b.grant_type === "authorization_code") {
      if (b.code !== "li-good-code" || !b.redirect_uri) return res.status(400).json({ error: "invalid_request" });
      return res.json(issue());
    }
    if (b.grant_type === "refresh_token") {
      l.calls.refresh++;
      if (!l.refreshTokens.has(b.refresh_token)) return res.status(400).json({ error: "invalid_grant" });
      l.refreshTokens.delete(b.refresh_token);
      return res.json(issue());
    }
    return res.status(400).json({ error: "unsupported_grant_type" });
  }
  if (path === "oauth/v2/revoke") return res.json({});

  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!l.accessTokens.has(token)) return res.status(401).json({ status: 401, serviceErrorCode: 65601, code: "REVOKED_ACCESS_TOKEN", message: "The token used in the request has been revoked by the user" });
  if (!/^\d{6}$/.test(String(req.headers["linkedin-version"] ?? "")) || req.headers["x-restli-protocol-version"] !== "2.0.0") return res.status(400).json({ status: 400, message: "Missing version headers" });

  const paged = <T,>(items: T[]) => {
    const size = Math.min(Number(q.pageSize) || 10, 1); // one per page to exercise cursors
    const start = Number(q.pageToken ?? 0);
    const next = start + size < items.length ? String(start + size) : undefined;
    return { elements: items.slice(start, start + size), metadata: next ? { nextPageToken: next } : {} };
  };
  if (path === "rest/adAccounts" && q.q === "search") {
    return res.json(paged([
      { id: Number(LINKEDIN_ACCOUNT), name: "Acme LinkedIn", currency: "USD", status: "ACTIVE", type: "BUSINESS" },
      { id: 508002, name: "Closed account", currency: "USD", status: "CANCELED", type: "BUSINESS" },
    ]));
  }
  if (path === `rest/adAccounts/${LINKEDIN_ACCOUNT}`) return res.json({ id: Number(LINKEDIN_ACCOUNT), name: "Acme LinkedIn" });
  if (path === `rest/adAccounts/${LINKEDIN_ACCOUNT}/adCampaigns` && q.q === "search") return res.json(paged(l.campaigns));
  if (path === "rest/adAnalytics" && q.q === "analytics") {
    l.calls.analytics++;
    const raw = req.originalUrl;
    // Rest.li values must be sent literally, with only the URN encoded (never double-encoded).
    if (/%25/.test(raw) || !raw.includes(`accounts=List(urn%3Ali%3AsponsoredAccount%3A${LINKEDIN_ACCOUNT})`)) {
      l.calls.badEncoding++;
      return res.status(400).json({ status: 400, message: "Invalid query parameters" });
    }
    const dr = /dateRange=\(start:\(year:(\d+),month:(\d+),day:(\d+)\),end:\(year:(\d+),month:(\d+),day:(\d+)\)\)/.exec(raw);
    if (!dr || q.pivot !== "CAMPAIGN" || q.timeGranularity !== "DAILY" || !String(q.fields ?? "").includes("costInLocalCurrency")) return res.status(400).json({ status: 400, message: "bad analytics query" });
    const p = (y: string, m: string, d: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const from = p(dr[1]!, dr[2]!, dr[3]!);
    const to = p(dr[4]!, dr[5]!, dr[6]!);
    const ymd = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return { year: y, month: m, day: dd }; };
    return res.json({
      elements: l.rows.filter((r) => r.date >= from && r.date <= to).map((r) => ({
        dateRange: { start: ymd(r.date), end: ymd(r.date) },
        pivotValues: [`urn:li:sponsoredCampaign:${r.campaign}`],
        costInLocalCurrency: r.cost.toFixed(2), impressions: r.impressions, clicks: r.clicks,
        externalWebsiteConversions: r.conversions, conversionValueInLocalCurrency: r.value.toFixed(2),
      })),
      paging: { count: 10, start: 0, links: [] },
    });
  }
  return res.status(404).json({ status: 404, message: `mock: ${path}` });
}

// ------------------------------------------------------------------ server

export async function startMockAdsSocial() {
  const state = makeState();
  const mock = await startMock((app) => {
    app.use((req, res, next) => {
      const segs = req.path.split("/").filter(Boolean);
      const host = segs.shift();
      if (host === "graph.facebook.com") return metaRoutes(state, req, res, segs);
      if (host === "business-api.tiktok.com" && segs[0] === "open_api" && segs[1] === "v1.3") return tiktokRoutes(state, req, res, `${segs.slice(2).join("/")}/`);
      if (host === "api.linkedin.com" || host === "www.linkedin.com") return linkedinRoutes(state, req, res, segs.join("/"));
      next();
    });
  });
  return { ...mock, state };
}
