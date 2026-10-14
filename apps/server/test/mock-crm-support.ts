import { createHash } from "node:crypto";
import { startMock } from "./kit.js";

/**
 * Local stand-ins for Salesforce, GoHighLevel, Zendesk and Intercom (host-prefixed routes, see
 * test/kit.ts) with deterministic generated data. Each provider keeps its raw records in `state`
 * so tests can compute expected figures and mutate records between syncs.
 */

export const SF_TZ = "America/Los_Angeles";
export const GHL_TZ = "America/Chicago";
export const IC_TZ = "Europe/London";
export const SF_INSTANCE = "acme.my.salesforce.com";
export const SF_API = "v62.0";

const DAY = 86_400_000;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;
export const localDay = (ms: number | string | Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
/** Salesforce datetime format. */
const sfTime = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");

// ------------------------------------------------------------------ state

export interface SfLead { Id: string; CreatedDate: string; LeadSource: string | null; Status: string; IsConverted: boolean; ConvertedDate: string | null; SystemModstamp: string }
export interface SfOpp { Id: string; CreatedDate: string; CloseDate: string; IsClosed: boolean; IsWon: boolean; Amount: number | null; StageName: string; SystemModstamp: string; RecordType: { Name: string }; CurrencyIsoCode: string }
export interface GhlContact { id: string; dateAdded: string; dateUpdated: string; source: string | null; type: string }
export interface GhlOpp { id: string; createdAt: string; updatedAt: string; status: "open" | "won" | "lost" | "abandoned"; monetaryValue: number | null; pipelineId: string; pipelineStageId: string; lastStatusChangeAt: string | null }
export interface ZdTicket { id: number; created_at: string; updated_at: string; status: string; via: { channel: string }; satisfaction_rating: { score: string } | null; metric: { solved_at: string | null; reply: number | null } }
export interface IcConv { id: string; created_at: number; updated_at: number; state: "open" | "closed" | "snoozed"; open: boolean; source: { type: string; delivered_as: string }; statistics: { time_to_admin_reply: number | null; first_admin_reply_at: number | null; last_close_at: number | null }; conversation_rating: { rating: number } | null }

export interface CrmSupportState {
  sf: {
    clientId: string; clientSecret: string; ccClientId: string; ccClientSecret: string;
    challenge: string | null; codes: Set<string>; accessTokens: Set<string>; refreshTokens: Set<string>;
    leads: SfLead[]; opps: SfOpp[]; deleted: { Lead: { id: string; deletedDate: string }[]; Opportunity: { id: string; deletedDate: string }[] };
    calls: { token: Record<string, number>; query: number; revoke: number };
  };
  ghl: { token: string; locationId: string; contacts: GhlContact[]; opps: GhlOpp[]; pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[]; calls: { contactSearch: number; oppSearch: number } };
  zd: { subdomain: string; email: string; token: string; tickets: ZdTicket[]; calls: { export: number } };
  ic: { token: string; conversations: IcConv[]; calls: { search: number } };
}

let seq = 0;
const id = (p: string) => `${p}${String(++seq).padStart(6, "0")}`;

function build(now: number): CrmSupportState {
  const r = rng(20240611);
  // Salesforce
  const leads: SfLead[] = [];
  for (let i = 0; i < 320; i++) {
    const created = now - Math.floor(r() * 420 * DAY) - 3_600_000;
    const converted = r() < 0.3;
    const convAt = Math.min(now - 60_000, created + Math.floor(r() * 20 * DAY));
    leads.push({
      Id: id("00Q"), CreatedDate: sfTime(created), LeadSource: pick(r, ["Web", "Phone Inquiry", "Partner Referral", "Purchased List", null]),
      Status: converted ? "Closed - Converted" : pick(r, ["Open - Not Contacted", "Working - Contacted", "Closed - Not Converted"]),
      IsConverted: converted, ConvertedDate: converted ? localDay(convAt, SF_TZ) : null, SystemModstamp: sfTime(Math.max(created, converted ? convAt : created)),
    });
  }
  const opps: SfOpp[] = [];
  for (let i = 0; i < 180; i++) {
    const created = now - Math.floor(r() * 520 * DAY) - 3_600_000;
    const roll = r();
    const status = roll < 0.35 ? "open" : roll < 0.7 ? "won" : "lost";
    const closeAt = Math.min(now - 60_000, created + Math.floor(r() * 60 * DAY));
    opps.push({
      Id: id("006"), CreatedDate: sfTime(created),
      CloseDate: status === "open" ? localDay(now + Math.floor(r() * 60 * DAY), SF_TZ) : localDay(closeAt, SF_TZ),
      IsClosed: status !== "open", IsWon: status === "won", Amount: r() < 0.1 ? null : Math.round(r() * 50_000 * 100) / 100,
      StageName: status === "open" ? pick(r, ["Prospecting", "Qualification", "Proposal/Price Quote", "Negotiation/Review"]) : status === "won" ? "Closed Won" : "Closed Lost",
      SystemModstamp: sfTime(status === "open" ? created : closeAt), RecordType: { Name: r() < 0.6 ? "New Business" : "Renewal" }, CurrencyIsoCode: i % 25 === 3 ? "EUR" : "USD",
    });
  }
  // GoHighLevel
  const pipelines = [
    { id: "pipeA", name: "Sales", stages: [{ id: "a1", name: "New Lead" }, { id: "a2", name: "Booked" }, { id: "a3", name: "Closed" }] },
    { id: "pipeB", name: "Upsell", stages: [{ id: "b1", name: "Contacted" }, { id: "b2", name: "Proposal" }] },
  ];
  const contacts: GhlContact[] = [];
  for (let i = 0; i < 260; i++) {
    const added = now - Math.floor(r() * 430 * DAY) - 3_600_000;
    contacts.push({ id: id("c"), dateAdded: new Date(added).toISOString(), dateUpdated: new Date(Math.min(now - 60_000, added + Math.floor(r() * 5 * DAY))).toISOString(), source: pick(r, ["Facebook Ads", "Website Form", "Referral", null]), type: pick(r, ["lead", "lead", "customer"]) });
  }
  const gopps: GhlOpp[] = [];
  for (let i = 0; i < 140; i++) {
    const created = now - Math.floor(r() * 450 * DAY) - 3_600_000;
    const status = pick(r, ["open", "open", "won", "won", "lost", "abandoned"] as const);
    const changed = Math.min(now - 60_000, created + Math.floor(r() * 30 * DAY));
    const p = pick(r, pipelines);
    gopps.push({
      id: id("o"), createdAt: new Date(created).toISOString(), updatedAt: new Date(status === "open" ? created : changed).toISOString(), status,
      monetaryValue: r() < 0.1 ? null : Math.round(r() * 8000), pipelineId: p.id, pipelineStageId: pick(r, p.stages).id, lastStatusChangeAt: status === "open" ? null : new Date(changed).toISOString(),
    });
  }
  // Zendesk
  const tickets: ZdTicket[] = [];
  for (let i = 0; i < 320; i++) {
    const created = now - Math.floor(r() * 400 * DAY) - 3_600_000;
    const status = pick(r, ["new", "open", "pending", "hold", "solved", "solved", "closed", "closed"]);
    const solved = status === "solved" || status === "closed" ? Math.min(now - 60_000, created + Math.floor(r() * 5 * DAY)) : null;
    const reply = r() < 0.8 ? Math.floor(r() * 600) : null;
    const rated = solved && r() < 0.5 ? { score: r() < 0.8 ? "good" : "bad" } : solved && r() < 0.3 ? { score: "offered" } : null;
    tickets.push({
      id: 1000 + i, created_at: new Date(created).toISOString(), updated_at: new Date(solved ?? created).toISOString(), status,
      via: { channel: pick(r, ["email", "web", "chat", "api"]) }, satisfaction_rating: rated, metric: { solved_at: solved ? new Date(solved).toISOString() : null, reply },
    });
  }
  // Intercom
  const convs: IcConv[] = [];
  for (let i = 0; i < 300; i++) {
    const created = Math.floor((now - Math.floor(r() * 400 * DAY) - 3_600_000) / 1000);
    const state = pick(r, ["open", "closed", "closed", "closed", "snoozed"] as const);
    const closeAt = state === "closed" ? Math.min(Math.floor(now / 1000) - 60, created + Math.floor(r() * 3 * 86_400)) : null;
    const ttr = r() < 0.75 ? Math.floor(r() * 7200) : null;
    convs.push({
      id: String(5_000_000 + i), created_at: created, updated_at: closeAt ?? created, state, open: state !== "closed",
      source: { type: pick(r, ["conversation", "conversation", "email", "whatsapp"]), delivered_as: r() < 0.85 ? "customer_initiated" : "admin_initiated" },
      statistics: { time_to_admin_reply: i % 7 === 0 ? null : ttr, first_admin_reply_at: ttr == null ? null : created + ttr, last_close_at: closeAt },
      conversation_rating: state === "closed" && r() < 0.4 ? { rating: 1 + Math.floor(r() * 5) } : null,
    });
  }
  return {
    sf: {
      clientId: "test-sf-platform-client", clientSecret: "test-sf-platform-secret",
      ccClientId: ["3MVG", "9TestConsumerKey", "0123456789abcdef"].join(""), ccClientSecret: ["CCSECRET", "0123456789ABCDEF"].join(""),
      challenge: null, codes: new Set(["sf-good-code"]), accessTokens: new Set(), refreshTokens: new Set(),
      leads, opps, deleted: { Lead: [], Opportunity: [] }, calls: { token: {}, query: 0, revoke: 0 },
    },
    ghl: { token: ["pit", "-", "0f2d4c6e-1a2b-4c3d-8e9f-a0b1c2d3e4f5"].join(""), locationId: "Loc8TestAbc123", contacts, opps: gopps, pipelines, calls: { contactSearch: 0, oppSearch: 0 } },
    zd: { subdomain: "acme", email: "agent@acme.test", token: ["Zd", "Tok", "0123456789abcdefghijABCDEFGHIJ01234"].join(""), tickets, calls: { export: 0 } },
    ic: { token: ["dG9r", "OmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OQ", "=="].join(""), conversations: convs, calls: { search: 0 } },
  };
}

// ------------------------------------------------------------------ SOQL (just enough)

function selectFields(q: string) {
  return /^SELECT (.+?) FROM/i.exec(q)![1]!.split(",").map((s) => s.trim());
}

function project(rec: any, fields: string[]) {
  const out: any = { attributes: { type: "x" } };
  for (const f of fields) {
    if (f.includes(".")) {
      const [a, b] = f.split(".") as [string, string];
      out[a] = rec[a] ? { [b]: rec[a][b] } : null;
    } else out[f] = rec[f];
  }
  return out;
}

export async function startMockCrmSupport() {
  const state = build(Date.now());
  const pages = new Map<string, any[]>();
  const PAGE = 70;

  const mock = await startMock((app) => {
    // ---------------- Salesforce OAuth
    app.post("/:host/services/oauth2/token", (req, res) => {
      const s = state.sf;
      const b = req.body;
      s.calls.token[b.grant_type] = (s.calls.token[b.grant_type] ?? 0) + 1;
      const issue = (withRefresh: boolean) => {
        const at = `00D!AT${Math.random().toString(36).slice(2)}`;
        s.accessTokens.add(at);
        const rt = withRefresh ? `5Aep${Math.random().toString(36).slice(2)}` : undefined;
        if (rt) s.refreshTokens.add(rt);
        return res.json({ access_token: at, ...(rt ? { refresh_token: rt } : {}), instance_url: `https://${SF_INSTANCE}`, id: `https://login.salesforce.com/id/00DTESTORG0000001/005TESTUSER00001`, token_type: "Bearer", issued_at: String(Date.now()), scope: "api refresh_token" });
      };
      if (b.grant_type === "authorization_code") {
        if (b.client_id !== s.clientId || b.client_secret !== s.clientSecret || !s.codes.has(b.code)) return res.status(400).json({ error: "invalid_grant" });
        if (s.challenge && createHash("sha256").update(b.code_verifier ?? "").digest("base64url") !== s.challenge) return res.status(400).json({ error: "invalid_grant", error_description: "invalid code verifier" });
        s.codes.delete(b.code);
        return issue(true);
      }
      if (b.grant_type === "refresh_token") {
        if (b.client_id !== s.clientId || !s.refreshTokens.has(b.refresh_token)) return res.status(400).json({ error: "invalid_grant" });
        return issue(false);
      }
      if (b.grant_type === "client_credentials") {
        if (req.params.host !== SF_INSTANCE) return res.status(400).json({ error: "unsupported_grant_type" });
        if (b.client_id !== s.ccClientId || b.client_secret !== s.ccClientSecret) return res.status(400).json({ error: "invalid_client", error_description: "invalid client credentials" });
        return issue(false);
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    });
    app.post("/:host/services/oauth2/revoke", (req, res) => {
      state.sf.calls.revoke++;
      state.sf.refreshTokens.delete(req.body.token);
      res.status(200).end();
    });
    // ---------------- Salesforce REST
    const sfAuth = (req: any, res: any, next: any) => {
      if (req.params.host !== SF_INSTANCE) return res.status(404).json([{ errorCode: "NOT_FOUND" }]);
      const t = String(req.get("authorization") ?? "").replace(/^Bearer /, "");
      if (!state.sf.accessTokens.has(t)) return res.status(401).json([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]);
      next();
    };
    const sfPage = (res: any, key: string, all: any[], offset: number) => {
      const recs = all.slice(offset, offset + PAGE);
      const done = offset + PAGE >= all.length;
      if (!done) pages.set(key, all);
      res.json({ totalSize: all.length, done, records: recs, ...(done ? {} : { nextRecordsUrl: `/services/data/${SF_API}/query/${key}-${offset + PAGE}` }) });
    };
    app.get(`/:host/services/data/${SF_API}/query`, sfAuth, (req, res) => {
      state.sf.calls.query++;
      const q = String(req.query.q);
      const fields = selectFields(q);
      const from = /FROM (\w+)/i.exec(q)![1];
      if (from === "Organization") return res.json({ totalSize: 1, done: true, records: [project({ Id: "00DTESTORG0000001", Name: "Acme Corp", TimeZoneSidKey: SF_TZ, DefaultCurrencyIsoCode: "USD", IsSandbox: false }, fields)] });
      const since = /SystemModstamp >= (\S+)/i.exec(q)?.[1];
      const src: any[] = from === "Lead" ? state.sf.leads : from === "Opportunity" ? state.sf.opps : [];
      const known = from === "Lead" ? ["Id", "CreatedDate", "LeadSource", "Status", "IsConverted", "ConvertedDate", "SystemModstamp"] : ["Id", "CreatedDate", "CloseDate", "IsClosed", "IsWon", "Amount", "StageName", "SystemModstamp", "RecordType.Name", "CurrencyIsoCode"];
      const bad = fields.find((f) => !known.includes(f));
      if (bad) return res.status(400).json([{ errorCode: "INVALID_FIELD", message: `No such column '${bad}'` }]);
      const rows = src.filter((x) => !since || Date.parse(x.SystemModstamp) >= Date.parse(since)).sort((a, b) => Date.parse(a.SystemModstamp) - Date.parse(b.SystemModstamp)).map((x) => project(x, fields));
      sfPage(res, `01g${Math.random().toString(36).slice(2, 8)}`, rows, 0);
    });
    app.get(`/:host/services/data/${SF_API}/query/:loc`, sfAuth, (req, res) => {
      state.sf.calls.query++;
      const m = /^(.+)-(\d+)$/.exec(String(req.params.loc));
      const all = m && pages.get(m[1]!);
      if (!all) return res.status(400).json([{ errorCode: "INVALID_QUERY_LOCATOR" }]);
      sfPage(res, m[1]!, all, Number(m[2]));
    });
    app.get(`/:host/services/data/${SF_API}/sobjects/Opportunity/describe`, sfAuth, (_req, res) => {
      res.json({ name: "Opportunity", fields: ["Id", "CreatedDate", "CloseDate", "IsClosed", "IsWon", "Amount", "StageName", "SystemModstamp", "RecordTypeId", "CurrencyIsoCode"].map((name) => ({ name })) });
    });
    app.get(`/:host/services/data/${SF_API}/sobjects/:obj/deleted`, sfAuth, (req, res) => {
      const list = (state.sf.deleted as any)[String(req.params.obj)] ?? [];
      const s = Date.parse(String(req.query.start)), e = Date.parse(String(req.query.end));
      res.json({ deletedRecords: list.filter((d: any) => Date.parse(d.deletedDate) >= s && Date.parse(d.deletedDate) <= e), earliestDateAvailable: sfTime(Date.now() - 30 * DAY), latestDateCovered: req.query.end });
    });
    app.get(`/:host/services/data/${SF_API}/limits`, sfAuth, (_req, res) => res.json({ DailyApiRequests: { Max: 15000, Remaining: 14000 } }));

    // ---------------- GoHighLevel
    const G = "/services.leadconnectorhq.com";
    const ghlAuth = (req: any, res: any, next: any) => {
      if (req.get("authorization") !== `Bearer ${state.ghl.token}`) return res.status(401).json({ statusCode: 401, message: "Invalid JWT" });
      if (req.get("version") !== "2021-07-28") return res.status(400).json({ message: "Version header missing" });
      next();
    };
    const ghlLoc = (v: unknown, res: any) => {
      if (v !== state.ghl.locationId) { res.status(403).json({ statusCode: 403, message: "The token does not have access to this location" }); return false; }
      return true;
    };
    app.get(`${G}/locations/:id`, ghlAuth, (req, res) => {
      if (!ghlLoc(req.params.id, res)) return;
      res.json({ location: { id: state.ghl.locationId, name: "Acme Plumbing", timezone: GHL_TZ, email: "x@example.test" } });
    });
    app.get(`${G}/opportunities/pipelines`, ghlAuth, (req, res) => {
      if (!ghlLoc(req.query.locationId, res)) return;
      res.json({ pipelines: state.ghl.pipelines });
    });
    app.post(`${G}/contacts/search`, ghlAuth, (req, res) => {
      state.ghl.calls.contactSearch++;
      const b = req.body;
      if (!ghlLoc(b.locationId, res)) return;
      const gte = b.filters?.find((f: any) => f.field === "dateUpdated")?.value?.gte;
      let list = state.ghl.contacts.filter((c) => !gte || Date.parse(c.dateUpdated) >= Date.parse(gte))
        .map((c) => ({ ...c, searchAfter: [Date.parse(c.dateUpdated), c.id] }))
        .sort((a, b2) => a.searchAfter[0] as number - (b2.searchAfter[0] as number) || a.id.localeCompare(b2.id));
      const total = list.length;
      if (b.searchAfter) {
        const [t, i] = b.searchAfter;
        list = list.filter((c) => (c.searchAfter[0] as number) > t || ((c.searchAfter[0] as number) === t && c.id > i));
      } else list = list.slice(((b.page ?? 1) - 1) * b.pageLimit);
      res.json({ contacts: list.slice(0, b.pageLimit), total });
    });
    app.get(`${G}/opportunities/search`, ghlAuth, (req, res) => {
      state.ghl.calls.oppSearch++;
      if (!ghlLoc(req.query.location_id, res)) return;
      const limit = Number(req.query.limit ?? 20);
      const sorted = [...state.ghl.opps].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
      let rest = sorted;
      if (req.query.startAfterId) {
        const t = Number(req.query.startAfter), i = String(req.query.startAfterId);
        rest = sorted.filter((o) => Date.parse(o.createdAt) > t || (Date.parse(o.createdAt) === t && o.id > i));
      }
      const page = rest.slice(0, limit);
      const last = page[page.length - 1];
      const more = rest.length > limit;
      res.json({ opportunities: page.map((o) => ({ ...o, name: `Opp ${o.id}`, locationId: state.ghl.locationId })), meta: { total: sorted.length, ...(last ? { startAfterId: last.id, startAfter: Date.parse(last.createdAt) } : {}), nextPageUrl: more ? "https://services.leadconnectorhq.com/opportunities/search?next" : null } });
    });

    // ---------------- Zendesk
    const Z = "/acme.zendesk.com/api/v2";
    const zdAuth = (req: any, res: any, next: any) => {
      const expected = `Basic ${Buffer.from(`${state.zd.email}/token:${state.zd.token}`).toString("base64")}`;
      if (req.get("authorization") !== expected) return res.status(401).json({ error: "Couldn't authenticate you" });
      next();
    };
    app.get(`${Z}/users/me.json`, zdAuth, (_req, res) => res.json({ user: { id: 42, name: "Agent", email: state.zd.email, role: "admin" } }));
    app.get(`${Z}/incremental/tickets/cursor.json`, zdAuth, (req, res) => {
      state.zd.calls.export++;
      const key = (t: ZdTicket) => [Math.floor(Date.parse(t.updated_at) / 1000), t.id] as const;
      const sorted = [...state.zd.tickets].sort((a, b) => key(a)[0] - key(b)[0] || a.id - b.id);
      let rest: ZdTicket[];
      if (req.query.cursor) {
        const [t, i] = Buffer.from(String(req.query.cursor), "base64url").toString().split(":").map(Number) as [number, number];
        rest = sorted.filter((x) => key(x)[0] > t || (key(x)[0] === t && x.id > i));
      } else {
        const st = Number(req.query.start_time);
        rest = sorted.filter((x) => key(x)[0] >= st);
      }
      const page = rest.slice(0, 100);
      const last = page[page.length - 1];
      const cursor = last ? Buffer.from(`${key(last)[0]}:${last.id}`).toString("base64url") : req.query.cursor ? String(req.query.cursor) : Buffer.from(`${Number(req.query.start_time) - 1}:0`).toString("base64url");
      const withMetrics = String(req.query.include ?? "").includes("metric_sets");
      res.json({
        tickets: page.map(({ metric, ...t }) => ({ ...t, subject: "redacted" })),
        ...(withMetrics ? { metric_sets: page.map((t) => ({ ticket_id: t.id, solved_at: t.metric.solved_at, reply_time_in_minutes: { calendar: t.metric.reply, business: t.metric.reply } })) } : {}),
        after_cursor: cursor, after_url: "https://acme.zendesk.com/api/v2/incremental/tickets/cursor.json?cursor=" + cursor, end_of_stream: rest.length <= 100,
      });
    });
    app.get(`${Z}/search/count.json`, zdAuth, (req, res) => {
      if (String(req.query.query) !== "type:ticket status<solved") return res.status(400).json({ error: "unsupported query in mock" });
      res.json({ count: state.zd.tickets.filter((t) => ["new", "open", "pending", "hold"].includes(t.status)).length });
    });

    // ---------------- Intercom
    const I = "/api.intercom.io";
    const icAuth = (req: any, res: any, next: any) => {
      if (req.get("authorization") !== `Bearer ${state.ic.token}`) return res.status(401).json({ type: "error.list", errors: [{ code: "unauthorized", message: "Access Token Invalid" }] });
      if (req.get("intercom-version") !== "2.13") return res.status(400).json({ type: "error.list", errors: [{ code: "intercom_version_invalid" }] });
      next();
    };
    app.get(`${I}/me`, icAuth, (_req, res) => res.json({ type: "admin", id: "991", name: "Ops", email: "ops@example.test", app: { type: "app", id_code: "abc123xy", name: "Acme Support", timezone: IC_TZ, region: "US" } }));
    app.post(`${I}/conversations/search`, icAuth, (req, res) => {
      state.ic.calls.search++;
      const q = req.body.query;
      const per = Math.min(150, Number(req.body.pagination?.per_page ?? 20));
      let list = [...state.ic.conversations].sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id));
      if (q.field === "updated_at" && q.operator === ">") list = list.filter((c) => c.updated_at > Number(q.value));
      else if (q.field === "open" && q.operator === "=") list = list.filter((c) => c.open === Boolean(q.value));
      else return res.status(400).json({ type: "error.list", errors: [{ code: "parameter_invalid" }] });
      const offset = req.body.pagination?.starting_after ? Number(Buffer.from(req.body.pagination.starting_after, "base64url").toString()) : 0;
      const page = list.slice(offset, offset + per);
      const next = offset + per < list.length ? Buffer.from(String(offset + per)).toString("base64url") : null;
      res.json({ type: "conversation.list", conversations: page.map((c) => ({ type: "conversation", ...c })), total_count: list.length, pages: { type: "pages", page: Math.floor(offset / per) + 1, per_page: per, total_pages: Math.ceil(list.length / per), ...(next ? { next: { page: Math.floor(offset / per) + 2, starting_after: next } } : {}) } });
    });
  });
  return { ...mock, state };
}
