import express from "express";
import { addDays, todayIn } from "@bca/shared";
import { startMock } from "./kit.js";

/**
 * Local stand-ins for Klaviyo (a.klaviyo.com/api), Mailchimp (us21.api.mailchimp.com/3.0)
 * and Brevo (api.brevo.com/v3) with deterministic generated data. Routes are host-prefixed
 * (see providerUrl). Keys are assembled at runtime so they never look like committed secrets.
 */

export const KLAVIYO_TZ = "America/Chicago";
export const MAILCHIMP_TZ = "America/Los_Angeles";
export const KLAVIYO_KEY = ["pk", "0123456789abcdef0123456789abcdef01"].join("_");
export const MAILCHIMP_KEY = ["0123456789abcdef0123456789abcdef", "us21"].join("-");
export const BREVO_KEY = ["xkeysib", "0123456789abcdef".repeat(4), "AbCdEfGhIjKlMnOp"].join("-");

export interface KlaviyoRow { date: string; campaign: string; sends: number; opens: number; clicks: number; unsubs: number }
export interface MailchimpReport {
  id: string; list_id: string; campaign_title: string; subject_line: string; type: string; send_time: string;
  emails_sent: number; unsubscribed: number;
  bounces: { hard_bounces: number; soft_bounces: number; syntax_errors: number };
  opens: { unique_opens: number }; clicks: { unique_subscriber_clicks: number };
}
export interface BrevoCampaign {
  id: number; name: string; subject: string; type: string; status: string; sentDate: string;
  statistics: { globalStats: { sent: number; delivered: number; uniqueViews: number; uniqueClicks: number; unsubscriptions: number } };
}

export interface EmailMockState {
  klaviyo: { rows: KlaviyoRow[]; throttleOnce: boolean; calls: { aggregates: number; throttled: number } };
  mailchimp: { reports: MailchimpReport[]; lists: { id: string; name: string; member_count: number }[]; calls: { reports: number } };
  brevo: { campaigns: BrevoCampaign[]; contacts: number; calls: { campaigns: number } };
}

/** Deterministic pseudo-random integers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (lo: number, hi: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return lo + (s % (hi - lo + 1));
  };
}

function generate(): EmailMockState {
  const r = rng(42);
  const now = Date.now();
  const kToday = todayIn(KLAVIYO_TZ);
  const rows: KlaviyoRow[] = [];
  for (let i = 400; i >= 1; i--) {
    const date = addDays(kToday, -i);
    rows.push({ date, campaign: "", sends: r(20, 60), opens: r(5, 20), clicks: r(0, 5), unsubs: r(0, 1) }); // flows
    if (i % 7 === 0) rows.push({ date, campaign: `Weekly #${i / 7}`, sends: r(800, 1200), opens: r(200, 400), clicks: r(20, 60), unsubs: r(0, 6) });
    if (i % 30 === 0) rows.push({ date, campaign: "Monthly sale", sends: r(1500, 2000), opens: r(400, 600), clicks: r(50, 90), unsubs: r(2, 9) });
  }

  const lists = [{ id: "list-main", name: "Newsletter", member_count: 4200 }, { id: "list-vip", name: "VIP", member_count: 350 }];
  const reports: MailchimpReport[] = [];
  let n = 0;
  for (let i = 420; i >= 2; i -= 5) {
    const vip = i % 20 === 0;
    const sent = vip ? r(300, 340) : r(3800, 4100);
    n++;
    reports.push({
      id: `mc${n}`, list_id: vip ? "list-vip" : "list-main", campaign_title: vip ? `VIP drop ${n}` : `Newsletter ${n}`, subject_line: `Subject ${n}`, type: "regular",
      // Some sends land near local midnight (03:00–07:00 UTC) to exercise timezone attribution.
      send_time: new Date(now - i * 86_400_000 - r(0, 23) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
      emails_sent: sent, unsubscribed: r(0, 8),
      bounces: { hard_bounces: r(0, 5), soft_bounces: r(0, 10), syntax_errors: r(0, 1) },
      opens: { unique_opens: Math.round(sent * r(20, 40) / 100) }, clicks: { unique_subscriber_clicks: Math.round(sent * r(1, 5) / 100) },
    });
  }

  const campaigns: BrevoCampaign[] = [];
  for (let i = 410, id = 1; i >= 3; i -= 4, id++) {
    const delivered = r(1500, 1800);
    campaigns.push({
      id, name: `Promo ${id}`, subject: `Deals ${id}`, type: "classic", status: "sent",
      sentDate: new Date(now - i * 86_400_000 - r(0, 23) * 3_600_000).toISOString(),
      statistics: { globalStats: { sent: delivered + r(0, 20), delivered, uniqueViews: Math.round(delivered * r(15, 35) / 100), uniqueClicks: r(10, 80), unsubscriptions: r(0, 5) } },
    });
  }
  return {
    klaviyo: { rows, throttleOnce: true, calls: { aggregates: 0, throttled: 0 } },
    mailchimp: { reports, lists, calls: { reports: 0 } },
    brevo: { campaigns, contacts: 1800, calls: { campaigns: 0 } },
  };
}

const KLAVIYO_METRICS = [
  { id: "RcvA1", name: "Received Email", field: "sends" },
  { id: "OpnB2", name: "Opened Email", field: "opens" },
  { id: "ClkC3", name: "Clicked Email", field: "clicks" },
  { id: "UnsD4", name: "Unsubscribed from Email Marketing", field: "unsubs" },
] as const;

export async function startMockEmail() {
  const state = generate();
  const mock = await startMock((app) => {
    app.use(express.json({ type: "application/vnd.api+json" })); // Klaviyo's JSON:API bodies
    // ---------------------------------------------------------------- Klaviyo
    const K = "/a.klaviyo.com/api";
    app.use(K, (req, res, next) => {
      if (req.headers.authorization !== `Klaviyo-API-Key ${KLAVIYO_KEY}`) return res.status(401).json({ errors: [{ status: 401, code: "not_authenticated" }] });
      if (!req.headers.revision) return res.status(400).json({ errors: [{ status: 400, detail: "revision header missing" }] });
      next();
    });
    app.get(`${K}/accounts/`, (_req, res) => res.json({
      data: [{ type: "account", id: "AbC123", attributes: { contact_information: { organization_name: "Acme Klaviyo", default_sender_email: "hi@acme.test" }, timezone: KLAVIYO_TZ, preferred_currency: "USD", industry: "Retail" } }],
    }));
    app.get(`${K}/metrics/`, (req, res) => {
      const p2 = req.query["page[cursor]"] === "p2";
      const all = [...KLAVIYO_METRICS.map((m) => ({ type: "metric", id: m.id, attributes: { name: m.name, integration: { name: "Klaviyo" } } })), { type: "metric", id: "PlcE5", attributes: { name: "Placed Order", integration: { name: "Klaviyo" } } }];
      res.json({ data: p2 ? all.slice(3) : all.slice(0, 3), links: { next: p2 ? null : "https://a.klaviyo.com/api/metrics/?page%5Bcursor%5D=p2" } });
    });
    app.post(`${K}/metric-aggregates/`, (req, res) => {
      state.klaviyo.calls.aggregates++;
      if (state.klaviyo.throttleOnce) {
        state.klaviyo.throttleOnce = false;
        state.klaviyo.calls.throttled++;
        return res.status(429).set("Retry-After", "0").json({ errors: [{ status: 429, code: "throttled" }] });
      }
      const a = req.body?.data?.attributes ?? {};
      const m = KLAVIYO_METRICS.find((x) => x.id === a.metric_id);
      if (!m || a.interval !== "day" || a.timezone !== KLAVIYO_TZ) return res.status(400).json({ errors: [{ status: 400, detail: "bad aggregate query" }] });
      const measure = a.measurements?.[0];
      const filters: string[] = a.filter ?? [];
      const from = /greater-or-equal\(datetime,(\d{4}-\d{2}-\d{2})/.exec(filters.join(" "))?.[1];
      const toEx = /less-than\(datetime,(\d{4}-\d{2}-\d{2})/.exec(filters.join(" "))?.[1];
      if (!from || !toEx) return res.status(400).json({ errors: [{ status: 400, detail: "datetime filter required" }] });
      const dates: string[] = [];
      for (let d = from; d < toEx; d = addDays(d, 1)) dates.push(d);
      const by = a.by?.[0];
      const groups = new Map<string, number[]>();
      for (const row of state.klaviyo.rows) {
        const i = dates.indexOf(row.date);
        if (i < 0) continue;
        const key = by === "Campaign Name" ? row.campaign : "__all";
        const arr = groups.get(key) ?? dates.map(() => 0);
        arr[i]! += row[m.field];
        groups.set(key, arr);
      }
      if (!groups.size && !by) groups.set("__all", dates.map(() => 0));
      res.json({
        data: {
          type: "metric-aggregate", id: "agg",
          attributes: {
            dates: dates.map((d) => `${d}T00:00:00-06:00`),
            data: [...groups].map(([k, values]) => ({ dimensions: k === "__all" ? [] : [k], measurements: { [measure]: values } })),
          },
        },
        links: { self: "https://a.klaviyo.com/api/metric-aggregates/" },
      });
    });

    // ---------------------------------------------------------------- Mailchimp
    const M = "/us21.api.mailchimp.com/3.0";
    app.use(M, (req, res, next) => {
      const auth = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      if (auth.split(":")[1] !== MAILCHIMP_KEY) return res.status(401).json({ type: "about:blank", title: "API Key Invalid", status: 401 });
      next();
    });
    app.get(`${M}/`, (_req, res) => res.json({ account_id: "8d3a3db4d97663a9074efcc16", account_name: "Acme Mail", email: "owner@acme.test", account_timezone: MAILCHIMP_TZ }));
    const page = <T>(items: T[], q: any, max: number) => {
      const count = Math.min(Number(q.count ?? 10), max);
      const offset = Number(q.offset ?? 0);
      return items.slice(offset, offset + count);
    };
    app.get(`${M}/lists`, (req, res) => res.json({ lists: page(state.mailchimp.lists, req.query, 1).map((l) => ({ id: l.id, name: l.name, stats: { member_count: l.member_count } })), total_items: state.mailchimp.lists.length }));
    app.get(`${M}/lists/:id`, (req, res) => {
      const l = state.mailchimp.lists.find((x) => x.id === req.params.id);
      if (!l) return res.status(404).json({ status: 404 });
      res.json({ stats: { member_count: l.member_count } });
    });
    app.get(`${M}/reports`, (req, res) => {
      state.mailchimp.calls.reports++;
      const since = req.query.since_send_time ? Date.parse(String(req.query.since_send_time)) : 0;
      const items = state.mailchimp.reports.filter((r) => Date.parse(r.send_time) >= since).sort((a, b) => b.send_time.localeCompare(a.send_time));
      res.json({ reports: page(items, req.query, 40), total_items: items.length });
    });

    // ---------------------------------------------------------------- Brevo
    const B = "/api.brevo.com/v3";
    app.use(B, (req, res, next) => {
      if (req.headers["api-key"] !== BREVO_KEY) return res.status(401).json({ code: "unauthorized", message: "Key not found" });
      next();
    });
    app.get(`${B}/account`, (_req, res) => res.json({ organization_id: "org-77aa", email: "owner@acme.test", firstName: "Ada", lastName: "Owner", companyName: "Acme Brevo", plan: [{ type: "free", credits: 300 }] }));
    app.get(`${B}/contacts`, (_req, res) => res.json({ contacts: [{ id: 1, email: "a@example.com" }], count: state.brevo.contacts }));
    app.get(`${B}/emailCampaigns`, (req, res) => {
      state.brevo.calls.campaigns++;
      const q = req.query as Record<string, string>;
      if ((q.startDate && !q.endDate) || q.status !== "sent") return res.status(400).json({ code: "invalid_parameter" });
      const from = q.startDate ? Date.parse(q.startDate) : 0;
      const to = q.endDate ? Date.parse(q.endDate) : Infinity;
      const items = state.brevo.campaigns.filter((c) => c.status === "sent" && Date.parse(c.sentDate) >= from && Date.parse(c.sentDate) <= to);
      const limit = Math.min(Number(q.limit ?? 50), 25);
      const offset = Number(q.offset ?? 0);
      res.json({ campaigns: items.slice(offset, offset + limit), count: items.length });
    });
  });
  return { ...mock, state };
}
