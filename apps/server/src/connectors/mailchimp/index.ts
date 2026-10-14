import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { basic, businessTimezone, finishRecordSync, overridable, recomputeDays, recordWindow, storeRecords, Tally, writeSnapshot, deleteRecords } from "../kit.js";
import { datesBetween, localDate } from "../normalize.js";
import type { AssetInfo, ConnectorDefinition, Credentials, SyncContext, SyncResult } from "../types.js";

/**
 * Mailchimp Marketing API 3.0, connected with an API key (`<key>-<dc>`, the suffix
 * names the data center: https://<dc>.api.mailchimp.com/3.0, HTTP Basic auth with any
 * username). Each audience (list) is an asset.
 *
 * Data model: every sent campaign's report (GET /reports) is stored as a source record
 * and attributed to its send day in the account timezone, with the campaign as dimension:
 *  - email_sends = emails_sent − bounces (delivered), email_opens = unique opens,
 *    email_clicks = unique subscriber clicks, email_unsubscribes = unsubscribes.
 *  Opens/clicks keep accruing for weeks after a send, so campaigns sent in the last 30 days
 *  (90 on reconciliation) are re-fetched on every sync; engagement is credited to the send
 *  day, not the day it happened (an approximation of daily activity).
 *  - email_list_size = the audience's subscribed member count, a snapshot for the sync day.
 */
const M = overridable("MAILCHIMP_BASE_URL_OVERRIDE");
const KEY_FORMAT = /^[0-9a-f]{32}-([a-z]{2,4}\d{1,3})$/;
const PAGE = 1000; // max `count` per request
const REPORT_FIELDS = [
  "reports.id", "reports.campaign_title", "reports.subject_line", "reports.list_id", "reports.type", "reports.send_time",
  "reports.emails_sent", "reports.unsubscribed", "reports.bounces", "reports.opens.unique_opens", "reports.clicks.unique_subscriber_clicks", "total_items",
].join(",");

export const EMAIL_FLOW = ["email_sends", "email_opens", "email_clicks", "email_unsubscribes"];
export const EMAIL_SNAPSHOT = ["email_list_size"];

const api = (creds: Credentials, path: string) => M(`https://${creds.dc}.api.mailchimp.com/3.0${path}`);
const get = async <T = any>(creds: Credentials, path: string) =>
  (await providerFetch<T>(api(creds, path), { provider: "Mailchimp", headers: { Authorization: basic("bca", creds.api_key) } })).data;

// ------------------------------------------------------------------ shared campaign sync

/** A sent campaign's figures, as reported by an email platform. */
export interface CampaignStat {
  id: string;
  name: string;
  sentAt: string;
  sends: number;
  opens: number;
  clicks: number;
  unsubscribes: number;
}
type CampaignPayload = { day: string; campaign: string; sends: number; opens: number; clicks: number; unsubscribes: number };

/**
 * Record-based sync shared by the campaign-report connectors (Mailchimp, Brevo): fetch
 * campaigns sent since the window start, store them by local send day, drop stored campaigns
 * that disappeared from the re-fetched window, recompute the window's days (empty days are
 * true zeros) and write the list-size snapshot for today.
 */
export async function syncSentCampaigns(ctx: SyncContext, p: {
  tz: string;
  initialDays: number;
  lookbackDays: number;
  reconcileDays: number;
  fetchSince(sinceIso: string): Promise<CampaignStat[]>;
  listSize?(): Promise<number | null>;
  notes?: string[];
}): Promise<SyncResult> {
  const { today, initial, coveredFrom, cursor } = recordWindow(ctx, p.tz, p.initialDays);
  let sinceDay = initial ? coveredFrom : addDays(today, -(ctx.mode === "reconcile" ? p.reconcileDays : p.lookbackDays));
  if (!initial && cursor.coveredTo && cursor.coveredTo < sinceDay) sinceDay = cursor.coveredTo; // long gap since the last sync
  if (sinceDay < coveredFrom) sinceDay = coveredFrom;

  // One day of slack before the window start covers any timezone offset; the local day decides.
  const stats = await p.fetchSince(`${addDays(sinceDay, -1)}T00:00:00Z`);
  const recs = stats
    .map((s) => ({ s, day: localDate(s.sentAt, p.tz) }))
    .filter(({ day }) => day >= sinceDay && day <= today)
    .map(({ s, day }) => ({
      type: "campaign",
      id: s.id,
      date: day,
      occurredAt: new Date(s.sentAt).toISOString(),
      payload: { day, campaign: s.name, sends: s.sends, opens: s.opens, clicks: s.clicks, unsubscribes: s.unsubscribes } satisfies CampaignPayload,
    }));

  const affected = new Set<string>(datesBetween(sinceDay, today));
  // Campaigns deleted at the provider no longer appear in the re-fetched window.
  const stored = await ctx.db.query(`SELECT provider_id FROM source_records WHERE asset_id = $1 AND record_type = 'campaign' AND local_date >= $2::date`, [ctx.asset.id, sinceDay]);
  const seen = new Set(recs.map((r) => r.id));
  await deleteRecords(ctx, "campaign", stored.rows.map((r) => r.provider_id as string).filter((id) => !seen.has(id)), ["day"], affected);
  await storeRecords<CampaignPayload>(ctx, recs, ["day"], affected);

  const recomputed = await recomputeDays<CampaignPayload>(ctx, [...affected].filter((d) => d >= coveredFrom && d <= today), {
    recordTypes: ["campaign"],
    dateFields: ["day"],
    owned: EMAIL_FLOW,
    compute(_date, records) {
      const t = new Tally(EMAIL_FLOW);
      for (const r of records) {
        const dims = { campaign: r.campaign };
        t.addAll("email_sends", r.sends, dims).addAll("email_opens", r.opens, dims).addAll("email_clicks", r.clicks, dims).addAll("email_unsubscribes", r.unsubscribes, dims);
      }
      return t.facts();
    },
  });

  const size = p.listSize ? await p.listSize() : null;
  if (size != null) await writeSnapshot(ctx, today, [{ metric: "email_list_size", value: size }], EMAIL_SNAPSHOT);
  return finishRecordSync(ctx, { coveredFrom, today, records: recs.length, recomputed, notes: p.notes });
}

// ------------------------------------------------------------------ Mailchimp

async function accountInfo(creds: Credentials) {
  return get<{ account_id: string; account_name: string; email?: string; account_timezone?: string }>(creds, "/?fields=account_id,account_name,email,account_timezone");
}

async function listAudiences(creds: Credentials) {
  const out: any[] = [];
  for (;;) {
    const page = await get(creds, `/lists?count=${PAGE}&offset=${out.length}&fields=lists.id,lists.name,lists.stats.member_count,total_items`);
    out.push(...(page.lists ?? []));
    if (!page.lists?.length || out.length >= (page.total_items ?? 0)) break;
  }
  return out;
}

/** Reports for campaigns sent since `since` (all audiences; filtered to one by list_id). */
async function reportsSince(creds: Credentials, listId: string, since: string): Promise<CampaignStat[]> {
  const out: CampaignStat[] = [];
  let total = Infinity;
  // Advance by what was returned (the server may cap `count` below what was asked for).
  for (let offset = 0; offset < total; ) {
    const q = new URLSearchParams({ count: String(PAGE), offset: String(offset), since_send_time: since, fields: REPORT_FIELDS });
    const page = await get(creds, `/reports?${q}`);
    total = page.total_items ?? 0;
    const reports: any[] = page.reports ?? [];
    for (const r of reports) {
      if (r.list_id !== listId || !r.send_time) continue;
      const b = r.bounces ?? {};
      const bounced = Number(b.hard_bounces ?? 0) + Number(b.soft_bounces ?? 0) + Number(b.syntax_errors ?? 0);
      out.push({
        id: String(r.id),
        name: r.campaign_title || r.subject_line || `Campaign ${r.id}`,
        sentAt: r.send_time,
        sends: Math.max(0, Number(r.emails_sent ?? 0) - bounced),
        opens: Number(r.opens?.unique_opens ?? 0),
        clicks: Number(r.clicks?.unique_subscriber_clicks ?? 0),
        unsubscribes: Number(r.unsubscribed ?? 0),
      });
    }
    if (!reports.length) break;
    offset += reports.length;
  }
  return out;
}

export const mailchimp: ConnectorDefinition = {
  id: "mailchimp",
  name: "Mailchimp",
  category: "Email",
  description: "Campaign deliveries, opens, clicks and unsubscribes per audience, plus audience size.",
  implemented: true,
  configKeys: [],
  scopes: [{ scope: "api_key", reason: "Read campaign reports and audience sizes (API keys have full account access; only reads are made)." }],
  metrics: [...EMAIL_FLOW, ...EMAIL_SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Campaign results appear at the next sync (every 6 hours); opens and clicks keep updating for 30 days after a send",
  staleAfterHours: 26,
  syncIntervalMinutes: 360,
  reconcileDays: 90,
  docsUrl: "https://mailchimp.com/developer/marketing/guides/quick-start/",
  tokenConnect: {
    fields: [{ key: "apiKey", label: "API key", placeholder: "0123…cdef-us21", help: "Ends with your data center, e.g. -us21", secret: true }],
    instructions: [
      "In Mailchimp click your profile icon → Profile → Extras → API keys.",
      "Click Create A Key, name it (e.g. \"Business Command AI\") and copy the key right away — Mailchimp shows it only once.",
      "Paste the full key including the part after the dash (e.g. -us21). Mailchimp API keys can't be limited to read-only; this connection only reads reports and audiences.",
    ],
    async connect(input) {
      const key = (input.apiKey ?? "").trim();
      const m = KEY_FORMAT.exec(key);
      if (!m) throw new ProviderError("permanent", "That doesn't look like a Mailchimp API key (32 characters followed by your data center, e.g. …-us21).");
      const creds = { api_key: key, dc: m[1] };
      const info = await accountInfo(creds);
      return { credentials: creds, scopes: ["api_key"], externalAccountId: String(info.account_id), displayName: info.account_name || "Mailchimp account", tokenExpiresAt: null, settings: { authMode: "token" } };
    },
  },
  async discoverAssets(creds): Promise<AssetInfo[]> {
    const [info, lists] = await Promise.all([accountInfo(creds), listAudiences(creds)]);
    return lists.map((l) => ({ providerAssetId: String(l.id), name: l.name || `Audience ${l.id}`, kind: "audience", currency: null, timezone: info.account_timezone || null }));
  },
  async sync(ctx) {
    const creds = await ctx.credentials();
    const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
    const listId = ctx.asset.provider_asset_id;
    return syncSentCampaigns(ctx, {
      tz, initialDays: 365, lookbackDays: 30, reconcileDays: 90,
      fetchSince: (since) => reportsSince(creds, listId, since),
      async listSize() {
        const l = await get(creds, `/lists/${encodeURIComponent(listId)}?fields=stats.member_count`);
        return l?.stats?.member_count ?? null;
      },
    });
  },
  async healthCheck(ctx) {
    await accountInfo(await ctx.credentials());
  },
};
