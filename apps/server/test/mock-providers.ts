import express from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { addDays, todayIn } from "@bca/shared";

/**
 * Local stand-ins for Google (OAuth, GA4 Data/Admin, Search Console, Google Ads)
 * and HubSpot, implementing the endpoints the connectors call, with deterministic
 * raw data so tests can reconcile imported figures with the source. Used only by
 * automated tests and local walkthroughs. URLs are host-prefixed, matching
 * providerUrl(): http://mock/<host>/<path>.
 */

const rng = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};

function listen(app: express.Express, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = app.listen(port, () => {
      const p = (server.address() as any).port;
      resolve({ url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// =================================================================== Google

export const GA4_TZ = "Europe/London";
export const ADS_TZ = "America/New_York";
export const GSC_TZ = "America/Los_Angeles";

export interface Ga4Row { date: string; channel: string; sourceMedium: string; device: string; country: string; landingPage: string; m: Record<string, number> }
export interface GscRow { date: string; query: string | null; page: string; country: string; device: string; clicks: number; impressions: number; posSum: number }
export interface AdsRow { customer: string; date: string; campaignId: string; campaign: string; channelType: string; device: string; costMicros: number; impressions: number; clicks: number; conversions: number; value: number }

export interface GoogleState {
  ga4: Ga4Row[];
  gsc: GscRow[];
  ads: AdsRow[];
  /** Days GSC hasn't finalized yet (most recent). */
  gscLagDays: number;
  accessTokens: Map<string, string[]>; // token → scopes
  refreshTokens: Map<string, string[]>;
  adsTokenApproved: boolean;
  calls: { refresh: number; revoke: number; runReport: number; gscQuery: number; adsSearch: number };
  fail: { next503: number };
}

const GA4_METRICS = ["sessions", "activeUsers", "engagedSessions", "keyEvents", "addToCarts", "checkouts", "ecommercePurchases", "purchaseRevenue"];

function makeGa4(days = 430): Ga4Row[] {
  const r = rng(7);
  const out: Ga4Row[] = [];
  const today = todayIn(GA4_TZ);
  const channels: [string, string][] = [["Organic Search", "google / organic"], ["Paid Search", "google / cpc"], ["Direct", "(direct) / (none)"], ["Email", "newsletter / email"]];
  for (let i = days; i >= 0; i--) {
    const date = addDays(today, -i);
    if (i % 41 === 9) continue; // a day with no traffic at all
    for (const [channel, sourceMedium] of channels) for (const device of ["mobile", "desktop"]) for (const country of ["United Kingdom", "France"]) for (const landingPage of ["/", "/shop"]) {
      const sessions = Math.floor(r() * 40);
      const engaged = Math.floor(sessions * (0.4 + r() * 0.4));
      const purchases = Math.floor(engaged * r() * 0.08);
      out.push({ date, channel, sourceMedium, device, country, landingPage, m: {
        sessions, activeUsers: Math.floor(sessions * 0.85), engagedSessions: engaged, keyEvents: Math.floor(engaged * 0.2),
        addToCarts: Math.floor(engaged * 0.15), checkouts: Math.floor(engaged * 0.1), ecommercePurchases: purchases, purchaseRevenue: Math.round(purchases * (30 + r() * 90) * 100) / 100,
      } });
    }
  }
  return out;
}

function makeGsc(days = 500): GscRow[] {
  const r = rng(11);
  const out: GscRow[] = [];
  const today = todayIn(GSC_TZ);
  const queries = ["rain jacket", "waterproof jacket", "hiking boots", "best daypack", "acme outdoors", "trail socks", null /* anonymized */];
  for (let i = days; i >= 0; i--) {
    const date = addDays(today, -i);
    if (i % 23 === 5) continue; // Search Console omits days with no data
    for (const query of queries) for (const page of ["https://example.com/", "https://example.com/jackets", "https://example.com/boots"]) for (const country of ["usa", "gbr"]) for (const device of ["MOBILE", "DESKTOP"]) {
      if (r() < 0.35) continue;
      const impressions = 1 + Math.floor(r() * 80);
      const clicks = Math.floor(impressions * r() * 0.2);
      const position = 1 + r() * 25;
      out.push({ date, query, page, country, device, clicks, impressions, posSum: position * impressions });
    }
  }
  return out;
}

function makeAds(days = 420): AdsRow[] {
  const r = rng(13);
  const out: AdsRow[] = [];
  const campaigns: [string, string, string][] = [["101", "Brand Search", "SEARCH"], ["102", "Performance Max — All products", "PERFORMANCE_MAX"], ["103", "Shopping — Jackets", "SHOPPING"]];
  for (const customer of ["2222222222", "3333333333"]) {
    const today = todayIn(ADS_TZ);
    for (let i = days; i >= 0; i--) {
      const date = addDays(today, -i);
      if (i % 19 === 2) continue; // campaigns paused all day → no rows (true zero spend)
      for (const [campaignId, campaign, channelType] of campaigns) for (const device of ["MOBILE", "DESKTOP", "TABLET"]) {
        if (r() < 0.2) continue;
        const impressions = 50 + Math.floor(r() * 2000);
        const clicks = Math.floor(impressions * r() * 0.06);
        const conversions = Math.round(clicks * r() * 0.1 * 100) / 100;
        out.push({ customer, date, campaignId, campaign, channelType, device, costMicros: Math.floor(clicks * (300_000 + r() * 1_500_000)), impressions, clicks, conversions, value: Math.round(conversions * (40 + r() * 60) * 100) / 100 });
      }
    }
  }
  return out;
}

const ymd = (d: string) => d.replaceAll("-", "");

export async function startMockGoogle(port = 0) {
  const state: GoogleState = {
    ga4: makeGa4(), gsc: makeGsc(), ads: makeAds(), gscLagDays: 2,
    accessTokens: new Map(), refreshTokens: new Map(), adsTokenApproved: true,
    calls: { refresh: 0, revoke: 0, runReport: 0, gscQuery: 0, adsSearch: 0 }, fail: { next503: 0 },
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const issueAccess = (scopes: string[]) => {
    const t = `ya29.${randomBytes(8).toString("hex")}`;
    state.accessTokens.set(t, scopes);
    return t;
  };
  const authed = (req: express.Request, scope: string) => {
    const t = (req.get("authorization") ?? "").replace(/^Bearer /, "");
    return state.accessTokens.get(t)?.includes(scope) ?? false;
  };
  const deny = (res: express.Response) => res.status(401).json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });

  // ---- OAuth
  app.get("/accounts.google.com/o/oauth2/v2/auth", (req, res) => {
    const code = `gcode.${Buffer.from(String(req.query.scope)).toString("base64url")}`;
    const back = `${req.query.redirect_uri}?${new URLSearchParams({ code, state: String(req.query.state), scope: String(req.query.scope) })}`;
    res.send(`<!doctype html><title>Sign in — Google (test stand-in)</title><body style="font-family:sans-serif;padding:40px"><h1>Business Command AI wants to access your Google Account</h1><p>${req.query.scope}</p><a id="allow" href="${back}">Allow</a></body>`);
  });
  app.post("/oauth2.googleapis.com/token", (req, res) => {
    const b = req.body;
    if (b.client_id !== process.env.GOOGLE_CLIENT_ID || b.client_secret !== process.env.GOOGLE_CLIENT_SECRET) return res.status(401).json({ error: "invalid_client" });
    if (b.grant_type === "refresh_token") {
      const scopes = state.refreshTokens.get(b.refresh_token);
      if (!scopes) return res.status(400).json({ error: "invalid_grant", error_description: "Token has been expired or revoked." });
      state.calls.refresh++;
      return res.json({ access_token: issueAccess(scopes), expires_in: 3599, scope: scopes.join(" "), token_type: "Bearer" });
    }
    if (!String(b.code).startsWith("gcode.")) return res.status(400).json({ error: "invalid_grant" });
    const requested = Buffer.from(String(b.code).slice(6), "base64url").toString().split(" ");
    const granted = b.code.endsWith(".partial") ? [] : requested;
    const refresh = `1//${randomBytes(8).toString("hex")}`;
    state.refreshTokens.set(refresh, granted);
    res.json({ access_token: issueAccess(granted), refresh_token: refresh, expires_in: 3599, scope: granted.join(" "), token_type: "Bearer" });
  });
  app.post("/oauth2.googleapis.com/revoke", (req, res) => {
    state.calls.revoke++;
    const scopes = state.refreshTokens.get(req.body.token);
    state.refreshTokens.delete(req.body.token);
    if (scopes) for (const [t, s] of state.accessTokens) if (s === scopes) state.accessTokens.delete(t);
    res.json({});
  });

  // Paths contain ":" (e.g. properties/1:runReport), so route manually.
  app.use((req, res, next) => {
    if (state.fail.next503 > 0) { state.fail.next503--; return res.status(503).json({ error: { code: 503, status: "UNAVAILABLE" } }); }
    next();
  });

  // ---- GA4
  const GA4 = "https://www.googleapis.com/auth/analytics.readonly";
  const properties: Record<string, { displayName: string; timeZone: string; currencyCode: string; ecommerce: boolean }> = {
    "properties/1001": { displayName: "Acme Web", timeZone: GA4_TZ, currencyCode: "GBP", ecommerce: true },
    "properties/1002": { displayName: "Acme Blog", timeZone: GA4_TZ, currencyCode: "GBP", ecommerce: false },
  };
  app.get("/analyticsadmin.googleapis.com/v1beta/accountSummaries", (req, res) => {
    if (!authed(req, GA4)) return deny(res);
    res.json({ accountSummaries: [{ account: "accounts/77", displayName: "Acme Ltd", propertySummaries: Object.entries(properties).map(([property, p]) => ({ property, displayName: p.displayName })) }] });
  });
  app.get("/analyticsadmin.googleapis.com/v1beta/properties/:id", (req, res) => {
    if (!authed(req, GA4)) return deny(res);
    const p = properties[`properties/${req.params.id}`];
    if (!p) return res.status(404).json({ error: { code: 404 } });
    res.json({ name: `properties/${req.params.id}`, displayName: p.displayName, timeZone: p.timeZone, currencyCode: p.currencyCode });
  });
  app.get(/^\/analyticsdata\.googleapis\.com\/v1beta\/(properties\/\d+)\/metadata$/, (req, res) => {
    if (!authed(req, GA4)) return deny(res);
    const p = properties[(req.params as any)[0]];
    const names = p?.ecommerce ? GA4_METRICS : GA4_METRICS.filter((m) => !["addToCarts", "checkouts", "ecommercePurchases", "purchaseRevenue"].includes(m));
    res.json({ metrics: names.map((apiName) => ({ apiName })), dimensions: [] });
  });
  app.post(/^\/analyticsdata\.googleapis\.com\/v1beta\/(properties\/\d+):runReport$/, (req, res) => {
    if (!authed(req, GA4)) return deny(res);
    state.calls.runReport++;
    const prop = (req.params as any)[0] as string;
    const b = req.body;
    const { startDate, endDate } = b.dateRanges[0];
    const dims: string[] = b.dimensions.map((d: any) => d.name);
    const mets: string[] = b.metrics.map((m: any) => m.name);
    const field: Record<string, keyof Ga4Row> = { sessionDefaultChannelGroup: "channel", sessionSourceMedium: "sourceMedium", deviceCategory: "device", country: "country", landingPage: "landingPage" };
    const rows = prop === "properties/1001" ? state.ga4 : [];
    const groups = new Map<string, { keys: string[]; v: number[] }>();
    for (const r of rows) {
      if (r.date < startDate || r.date > endDate) continue;
      const keys = dims.map((d) => (d === "date" ? ymd(r.date) : String(r[field[d]!])));
      const k = keys.join("\u0000");
      const g = groups.get(k) ?? { keys, v: mets.map(() => 0) };
      mets.forEach((m, i) => (g.v[i]! += r.m[m] ?? 0));
      groups.set(k, g);
    }
    let list = [...groups.values()];
    if (b.keepEmptyRows) list = list; // (zero rows below)
    else list = list.filter((g) => g.v.some((x) => x !== 0));
    if (b.keepEmptyRows && dims.length === 1 && dims[0] === "date") {
      for (let d = startDate; d <= endDate; d = addDays(d, 1)) if (!groups.has(ymd(d))) list.push({ keys: [ymd(d)], v: mets.map(() => 0) });
    }
    if (b.orderBys?.[0]?.metric) {
      const i = mets.indexOf(b.orderBys[0].metric.metricName);
      list.sort((a, z) => z.v[i]! - a.v[i]!);
    } else list.sort((a, z) => a.keys.join().localeCompare(z.keys.join()));
    const offset = b.offset ?? 0;
    const page = list.slice(offset, offset + Math.min(b.limit ?? 10000, 250)); // small pages exercise pagination
    res.json({
      rowCount: list.length,
      rows: page.length ? page.map((g) => ({ dimensionValues: g.keys.map((value) => ({ value })), metricValues: g.v.map((x) => ({ value: String(Math.round(x * 100) / 100) })) })) : undefined,
    });
  });

  // ---- Search Console
  const GSC = "https://www.googleapis.com/auth/webmasters.readonly";
  app.get("/www.googleapis.com/webmasters/v3/sites", (req, res) => {
    if (!authed(req, GSC)) return deny(res);
    res.json({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://unverified.example/", permissionLevel: "siteUnverifiedUser" }] });
  });
  app.get(/^\/www\.googleapis\.com\/webmasters\/v3\/sites\/([^/]+)$/, (req, res) => {
    if (!authed(req, GSC)) return deny(res);
    res.json({ siteUrl: decodeURIComponent((req.params as any)[0]), permissionLevel: "siteOwner" });
  });
  app.post(/^\/www\.googleapis\.com\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/, (req, res) => {
    if (!authed(req, GSC)) return deny(res);
    state.calls.gscQuery++;
    const b = req.body;
    if (b.rowLimit > 25000) return res.status(400).json({ error: { code: 400, message: "rowLimit too large" } });
    const site = decodeURIComponent((req.params as any)[0]);
    const lastFinal = addDays(todayIn(GSC_TZ), -state.gscLagDays);
    const dims: string[] = b.dimensions ?? [];
    const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; posSum: number }>();
    for (const r of site === "sc-domain:example.com" ? state.gsc : []) {
      if (r.date < b.startDate || r.date > b.endDate || r.date > lastFinal) continue;
      if (dims.includes("query") && r.query === null) continue; // anonymized queries are withheld
      const keys = dims.map((d) => String((r as any)[d]));
      const k = keys.join("\u0000");
      const g = groups.get(k) ?? { keys, clicks: 0, impressions: 0, posSum: 0 };
      g.clicks += r.clicks; g.impressions += r.impressions; g.posSum += r.posSum;
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((a, z) => z.clicks - a.clicks || z.impressions - a.impressions);
    const page = list.slice(b.startRow ?? 0, (b.startRow ?? 0) + (b.rowLimit ?? 1000));
    res.json({ rows: page.length ? page.map((g) => ({ keys: g.keys, clicks: g.clicks, impressions: g.impressions, ctr: g.impressions ? g.clicks / g.impressions : 0, position: g.posSum / g.impressions })) : undefined, responseAggregationType: "byProperty" });
  });

  // ---- Google Ads
  const ADS = "https://www.googleapis.com/auth/adwords";
  const customers: Record<string, { name: string; currency: string; tz: string; manager: boolean; clients?: string[] }> = {
    "1111111111": { name: "Acme MCC", currency: "USD", tz: ADS_TZ, manager: true, clients: ["3333333333"] },
    "2222222222": { name: "Acme US", currency: "USD", tz: ADS_TZ, manager: false },
    "3333333333": { name: "Acme EU", currency: "EUR", tz: ADS_TZ, manager: false },
  };
  const adsGate = (req: express.Request, res: express.Response) => {
    if (!authed(req, ADS)) { deny(res); return false; }
    if (req.get("developer-token") !== process.env.GOOGLE_ADS_DEVELOPER_TOKEN) { res.status(401).json({ error: { code: 401, status: "UNAUTHENTICATED", details: [{ errors: [{ errorCode: { authenticationError: "DEVELOPER_TOKEN_INVALID" } }] }] } }); return false; }
    if (!state.adsTokenApproved) { res.status(403).json({ error: { code: 403, status: "PERMISSION_DENIED", message: "The developer token is only approved for use with test accounts.", details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] }] } }); return false; }
    return true;
  };
  app.get(/^\/googleads\.googleapis\.com\/v\d+\/customers:listAccessibleCustomers$/, (req, res) => {
    if (!adsGate(req, res)) return;
    res.json({ resourceNames: ["customers/1111111111", "customers/2222222222"] });
  });
  app.post(/^\/googleads\.googleapis\.com\/v\d+\/customers\/(\d+)\/googleAds:searchStream$/, (req, res) => {
    if (!adsGate(req, res)) return;
    state.calls.adsSearch++;
    const id = (req.params as any)[0] as string;
    const login = req.get("login-customer-id");
    const viaManager = Object.entries(customers).find(([, c]) => c.clients?.includes(id));
    if (viaManager && login !== viaManager[0]) return res.status(403).json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }] } });
    const q: string = req.body.query;
    const c = customers[id];
    if (!c) return res.status(403).json({ error: { code: 403 } });
    if (/FROM customer_client/.test(q)) {
      const rows = [id, ...(c.clients ?? [])].map((cid, i) => ({ customerClient: { id: cid, descriptiveName: customers[cid]!.name, currencyCode: customers[cid]!.currency, timeZone: customers[cid]!.tz, manager: customers[cid]!.manager, level: i === 0 ? "0" : "1", status: "ENABLED" } }));
      return res.json([{ results: rows }]);
    }
    if (/FROM customer\b/.test(q)) return res.json([{ results: [{ customer: { resourceName: `customers/${id}`, id } }] }]);
    const m = /segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(q);
    if (!m || !/FROM campaign/.test(q)) return res.status(400).json({ error: { code: 400, message: "unsupported query" } });
    const results = state.ads.filter((r) => r.customer === id && r.date >= m[1]! && r.date <= m[2]!).map((r) => ({
      campaign: { resourceName: `customers/${id}/campaigns/${r.campaignId}`, id: r.campaignId, name: r.campaign, advertisingChannelType: r.channelType },
      metrics: { costMicros: String(r.costMicros), impressions: String(r.impressions), clicks: String(r.clicks), conversions: r.conversions, conversionsValue: r.value },
      segments: { date: r.date, device: r.device },
    }));
    // searchStream sends batches of up to 10,000 rows.
    const batches = [];
    for (let i = 0; i < results.length; i += 10000) batches.push({ results: results.slice(i, i + 10000), fieldMask: "segments.date,campaign.name", requestId: "req" });
    res.json(batches.length ? batches : [{ fieldMask: "", requestId: "req" }]);
  });

  app.use((req, res) => res.status(404).json({ error: { code: 404, message: `mock: no route ${req.method} ${req.path}` } }));
  const srv = await listen(app, port);
  return { ...srv, state };
}

// =================================================================== HubSpot

export const HUBSPOT_TZ = "America/Chicago";
export interface HsContact { id: string; createdate: string; lastmodifieddate: string; lifecyclestage: string; source: string; mql: string | null; sql: string | null }
export interface HsDeal { id: string; createdate: string; lastmodifieddate: string; closedate: string | null; pipeline: string; dealstage: string; amount: number | null; status: "open" | "won" | "lost" }

export interface HubSpotState {
  contacts: HsContact[];
  deals: HsDeal[];
  accessTokens: Set<string>;
  refreshTokens: Set<string>;
  searchCap: number;
  calls: { refresh: number; revoke: number; search: number; batchRead: number };
}

const PIPELINES = [
  { id: "default", label: "Sales Pipeline", stages: [["appointmentscheduled", "Appointment scheduled", false, false], ["qualifiedtobuy", "Qualified to buy", false, false], ["closedwon", "Closed won", true, true], ["closedlost", "Closed lost", true, false]] },
  { id: "p2", label: "Wholesale", stages: [["w1", "Inquiry", false, false], ["w2", "Negotiation", false, false], ["wwon", "Won", true, true], ["wlost", "Lost", true, false]] },
] as const;

function makeHubSpot(): { contacts: HsContact[]; deals: HsDeal[] } {
  const r = rng(17);
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString();
  const contacts: HsContact[] = [];
  for (let i = 0; i < 700; i++) {
    const created = now - Math.floor(r() * 90 * 86400_000) - 3600_000;
    const q = r() < 0.3 ? created + Math.floor(r() * 5 * 86400_000) : null;
    const qualified = q && q < now ? q : null;
    contacts.push({
      id: String(5000 + i),
      createdate: iso(created),
      lastmodifieddate: iso(Math.min(now - 1000, (qualified ?? created) + 60_000 + i)), // distinct timestamps
      lifecyclestage: qualified ? (r() < 0.5 ? "marketingqualifiedlead" : "salesqualifiedlead") : ["subscriber", "lead", "customer"][Math.floor(r() * 3)]!,
      source: ["ORGANIC_SEARCH", "PAID_SEARCH", "DIRECT_TRAFFIC", "EMAIL_MARKETING", "SOCIAL_MEDIA"][Math.floor(r() * 5)]!,
      mql: qualified ? iso(qualified) : null,
      sql: qualified && r() < 0.4 ? iso(qualified + 86400_000) : null,
    });
  }
  const deals: HsDeal[] = [];
  for (let i = 0; i < 160; i++) {
    const old = i < 20; // old open deals created long before the import window
    const created = old ? now - (450 + Math.floor(r() * 200)) * 86400_000 : now - Math.floor(r() * 80 * 86400_000) - 3600_000;
    const p = PIPELINES[r() < 0.75 ? 0 : 1];
    const roll = r();
    const status: HsDeal["status"] = old ? "open" : roll < 0.35 ? "won" : roll < 0.55 ? "lost" : "open";
    const closed = status === "open" ? null : Math.min(now - 1000, created + Math.floor(r() * 20 * 86400_000));
    const stage = status === "won" ? p.stages[2][0] : status === "lost" ? p.stages[3][0] : p.stages[Math.floor(r() * 2)]![0];
    deals.push({
      id: String(9000 + i), createdate: new Date(created).toISOString(), lastmodifieddate: new Date(Math.min(now - 1000, (closed ?? created) + 120_000 + i)).toISOString(),
      closedate: closed ? new Date(closed).toISOString() : null, pipeline: p.id, dealstage: stage,
      amount: r() < 0.1 ? null : Math.round((500 + r() * 20000) * 100) / 100, status,
    });
  }
  return { contacts, deals };
}

export function contactProps(c: HsContact) {
  return { createdate: c.createdate, lastmodifieddate: c.lastmodifieddate, lifecyclestage: c.lifecyclestage, hs_analytics_source: c.source, hs_lifecyclestage_marketingqualifiedlead_date: c.mql, hs_lifecyclestage_salesqualifiedlead_date: c.sql, hs_object_id: c.id };
}
export function dealProps(d: HsDeal) {
  return {
    createdate: d.createdate, hs_lastmodifieddate: d.lastmodifieddate, closedate: d.closedate, pipeline: d.pipeline, dealstage: d.dealstage,
    amount_in_home_currency: d.amount == null ? null : String(d.amount), hs_is_closed: String(d.status !== "open"), hs_is_closed_won: String(d.status === "won"), hs_object_id: d.id,
  };
}

export async function startMockHubSpot(port = 0) {
  const state: HubSpotState = { ...makeHubSpot(), accessTokens: new Set(), refreshTokens: new Set(), searchCap: 10_000, calls: { refresh: 0, revoke: 0, search: 0, batchRead: 0 } };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const issue = (refresh?: string) => {
    const access = `hs-at-${randomBytes(8).toString("hex")}`;
    state.accessTokens.add(access);
    const rt = refresh ?? `hs-rt-${randomBytes(8).toString("hex")}`;
    state.refreshTokens.add(rt);
    return { access_token: access, refresh_token: rt, expires_in: 1800, token_type: "bearer" };
  };
  const authed = (req: express.Request, res: express.Response) => {
    if (state.accessTokens.has((req.get("authorization") ?? "").replace(/^Bearer /, ""))) return true;
    res.status(401).json({ status: "error", message: "Authentication credentials not found.", category: "INVALID_AUTHENTICATION" });
    return false;
  };

  app.get("/app.hubspot.com/oauth/authorize", (req, res) => {
    const back = `${req.query.redirect_uri}?${new URLSearchParams({ code: "hs-good-code", state: String(req.query.state) })}`;
    res.send(`<!doctype html><title>Connect app — HubSpot (test stand-in)</title><body style="font-family:sans-serif;padding:40px"><h1>Connect Business Command AI to HubSpot</h1><p>${req.query.scope}</p><a id="connect" href="${back}">Connect app</a></body>`);
  });
  app.post("/api.hubapi.com/oauth/v3/token", (req, res) => {
    const b = req.body;
    if (b.client_id !== process.env.HUBSPOT_CLIENT_ID || b.client_secret !== process.env.HUBSPOT_CLIENT_SECRET) return res.status(400).json({ status: "BAD_CLIENT_ID" });
    if (b.grant_type === "refresh_token") {
      if (!state.refreshTokens.has(b.refresh_token)) return res.status(400).json({ status: "BAD_REFRESH_TOKEN" });
      state.calls.refresh++;
      return res.json(issue(b.refresh_token)); // HubSpot refresh tokens are long-lived (not rotated)
    }
    if (b.code !== "hs-good-code") return res.status(400).json({ status: "BAD_AUTH_CODE" });
    res.json(issue());
  });
  app.delete("/api.hubapi.com/oauth/v1/refresh-tokens/:token", (req, res) => {
    state.calls.revoke++;
    state.refreshTokens.delete(req.params.token);
    state.accessTokens.clear();
    res.status(204).end();
  });
  app.get("/api.hubapi.com/account-info/v3/details", (req, res) => {
    if (!authed(req, res)) return;
    res.json({ portalId: 4455667, accountType: "STANDARD", timeZone: HUBSPOT_TZ, companyCurrency: "USD", uiDomain: "app.hubspot.com", dataHostingLocation: "na1" });
  });
  app.get("/api.hubapi.com/crm/v3/pipelines/deals", (req, res) => {
    if (!authed(req, res)) return;
    res.json({ results: PIPELINES.map((p) => ({ id: p.id, label: p.label, stages: p.stages.map(([id, label, isClosed]) => ({ id, label, metadata: { isClosed: String(isClosed) } })) })) });
  });
  for (const object of ["contacts", "deals"] as const) {
    app.post(`/api.hubapi.com/crm/v3/objects/${object}/search`, (req, res) => {
      if (!authed(req, res)) return;
      state.calls.search++;
      const b = req.body;
      const f = b.filterGroups?.[0]?.filters?.[0];
      const after = Number(b.after ?? 0);
      const limit = Math.min(b.limit ?? 10, 200);
      if (after + limit > state.searchCap) return res.status(400).json({ status: "error", message: `Paging beyond ${state.searchCap} results is not supported`, category: "VALIDATION_ERROR" });
      const modProp = object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";
      const all = (object === "contacts" ? state.contacts.map((c) => ({ id: c.id, properties: contactProps(c) })) : state.deals.map((d) => ({ id: d.id, properties: dealProps(d) })))
        .filter((o: any) => !f || (f.propertyName === modProp && f.operator === "GTE" && Date.parse(o.properties[modProp]) >= Number(f.value)))
        .sort((a: any, z: any) => Date.parse(a.properties[modProp]) - Date.parse(z.properties[modProp]));
      const page = all.slice(after, after + limit);
      res.json({ total: all.length, results: page, ...(after + limit < all.length ? { paging: { next: { after: String(after + limit) } } } : {}) });
    });
    app.post(`/api.hubapi.com/crm/v3/objects/${object}/batch/read`, (req, res) => {
      if (!authed(req, res)) return;
      state.calls.batchRead++;
      const ids = new Set((req.body.inputs ?? []).map((i: any) => String(i.id)));
      const results = object === "contacts"
        ? state.contacts.filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, properties: contactProps(c) }))
        : state.deals.filter((d) => ids.has(d.id)).map((d) => ({ id: d.id, properties: dealProps(d) }));
      res.json({ status: "COMPLETE", results });
    });
  }
  app.use((req, res) => res.status(404).json({ status: "error", message: `mock: no route ${req.method} ${req.path}` }));
  const srv = await listen(app, port);
  return { ...srv, state };
}
