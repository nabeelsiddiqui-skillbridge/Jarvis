import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { datesBetween, localDate, type FactInput } from "../normalize.js";
import { Tally, businessTimezone, finishRecordSync, fromUnix, overridable, recordWindow, recomputeDays, required, storeRecords, writeSnapshot, type StoredRecord } from "../kit.js";
import type { ConnectorDefinition, Credentials, SyncContext, SyncResult } from "../types.js";

/**
 * Intercom. Connected with an access token from the Developer Hub (Bearer), against the
 * workspace's regional API host (US, EU or AU), pinned to INTERCOM_API_VERSION.
 * Conversations are read through the search API (updated_at > cursor, cursor pagination),
 * stored as records and aggregated per day in the workspace's timezone (else the business's):
 *  - "tickets" are inbound conversations: customer-initiated ones (outbound messages, campaigns
 *    and automated messages aren't support demand); channel = source.type
 *  - created by created_at; solved = currently closed conversations, by statistics.last_close_at
 *  - first reply minutes (time_to_admin_reply, else first_admin_reply_at − created_at) and CSAT
 *    (conversation_rating 1–5; 4–5 is good) are attributed to the conversation's CREATED day
 *  - open tickets (open + snoozed) is a snapshot for the sync day from a search count.
 * Deleted conversations aren't reported by the search API; they disappear only from the snapshot.
 */
const IC = overridable("INTERCOM_BASE_URL_OVERRIDE");
export const INTERCOM_API_VERSION = "2.13";
const HOSTS: Record<string, string> = { us: "https://api.intercom.io", eu: "https://api.eu.intercom.io", au: "https://api.au.intercom.io" };
const FLOW = ["support_tickets_created", "support_tickets_solved", "support_first_reply_minutes", "support_first_replies", "support_csat_good", "support_csat_rated"];
const SNAPSHOT = ["support_open_tickets"];
const DATE_FIELDS = ["created", "solved"];
const INITIAL_DAYS = 365;
export const INTERCOM_LIMITS = { perPage: 150 };
/** Conversation origins that represent inbound support demand. */
const inbound = (deliveredAs: string | undefined) => !deliveredAs || deliveredAs === "customer_initiated";

interface ConvRec { created: string; solved: string | null; channel: string; firstReplyMin: number | null; rating: number | null }

const CHANNEL: Record<string, string> = {
  conversation: "Chat", email: "Email", facebook: "Facebook", twitter: "X (Twitter)", instagram: "Instagram", whatsapp: "WhatsApp",
  sms: "SMS", phone_call: "Phone", push: "Push", chat: "Chat", messenger: "Chat",
};

const hostOf = (c: Credentials) => HOSTS[c.region] ?? HOSTS.us!;
const headers = (c: Credentials) => ({ Authorization: `Bearer ${c.access_token}`, "Intercom-Version": INTERCOM_API_VERSION });

async function call<T = any>(c: Credentials, path: string, json?: unknown): Promise<T> {
  const { data } = await providerFetch(IC(`${hostOf(c)}${path}`), { provider: "Intercom", headers: headers(c), ...(json ? { method: "POST", json, idempotent: true } : {}) });
  return data as T;
}

async function me(c: Credentials) {
  return call<{ type: string; id: string; name?: string; app?: { id_code: string; name: string; timezone?: string | null; region?: string } }>(c, "/me");
}

function normConv(o: any, tz: string): ConvRec | null {
  if (!o.created_at) return null;
  if (!inbound(o.source?.delivered_as)) return null;
  const s = o.statistics ?? {};
  const closed = o.state === "closed";
  const closedAt = closed ? s.last_close_at ?? o.updated_at : null;
  let reply: number | null = null;
  if (typeof s.time_to_admin_reply === "number") reply = s.time_to_admin_reply / 60;
  else if (typeof s.first_admin_reply_at === "number") reply = Math.max(0, s.first_admin_reply_at - o.created_at) / 60;
  const rating = Number(o.conversation_rating?.rating);
  const type = o.source?.type;
  return {
    created: localDate(fromUnix(o.created_at)!, tz),
    solved: closedAt ? localDate(fromUnix(closedAt)!, tz) : null,
    channel: type ? CHANNEL[type] ?? String(type).replace(/_/g, " ").replace(/^./, (x: string) => x.toUpperCase()) : "Unknown",
    firstReplyMin: reply == null ? null : Math.round(reply * 100) / 100,
    rating: rating >= 1 && rating <= 5 ? rating : null,
  };
}

function dayFacts(date: string, records: ConvRec[]): FactInput[] {
  const t = new Tally(FLOW);
  for (const r of records) {
    const ch = { channel: r.channel };
    if (r.created === date) {
      t.addAll("support_tickets_created", 1, ch);
      if (r.firstReplyMin != null) {
        t.addAll("support_first_replies", 1, ch);
        t.addAll("support_first_reply_minutes", r.firstReplyMin, ch);
      }
      if (r.rating != null) {
        t.add("support_csat_rated");
        if (r.rating >= 4) t.add("support_csat_good");
      }
    }
    if (r.solved === date) t.addAll("support_tickets_solved", 1, ch);
  }
  return t.facts();
}

async function syncWorkspace(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
  const w = recordWindow(ctx, tz, INITIAL_DAYS);
  const startedAt = Math.floor(Date.now() / 1000);
  const overlap = 600;
  const affected = new Set<string>();
  const since = w.initial ? Math.floor(Date.parse(`${w.coveredFrom}T00:00:00Z`) / 1000) - 86_400
    : ctx.mode === "reconcile" ? startedAt - 30 * 86_400 : Number(w.cursor.updatedAt ?? startedAt) - overlap;

  let starting: string | undefined;
  let count = 0;
  let maxSeen = Number(w.cursor.updatedAt ?? 0);
  for (;;) {
    const d = await call(creds, "/conversations/search", {
      query: { field: "updated_at", operator: ">", value: since },
      pagination: { per_page: INTERCOM_LIMITS.perPage, ...(starting ? { starting_after: starting } : {}) },
    });
    const list: any[] = d.conversations ?? [];
    count += list.length;
    const recs: StoredRecord<ConvRec>[] = [];
    for (const o of list) {
      maxSeen = Math.max(maxSeen, Number(o.updated_at) || 0);
      const n = normConv(o, tz);
      if (n) recs.push({ type: "conversation", id: String(o.id), payload: n, date: n.created, occurredAt: fromUnix(o.created_at)!, updatedAt: fromUnix(o.updated_at) });
    }
    await storeRecords(ctx, recs, ["created", "solved"], affected);
    starting = d.pages?.next?.starting_after;
    if (!starting || !list.length) break;
  }
  ctx.log(`fetched ${count} conversations`);

  const prevTo: string | null = w.cursor.coveredTo ?? null;
  const fill = w.initial || !prevTo ? w.allDays() : datesBetween(addDays(prevTo, 1) <= w.today ? addDays(prevTo, 1) : w.today, w.today);
  const dates = [...new Set([...affected, ...fill])].filter((x) => x >= w.coveredFrom && x <= w.today);
  const recomputed = await recomputeDays<ConvRec>(ctx, dates, { recordTypes: ["conversation"], dateFields: DATE_FIELDS, owned: FLOW, compute: dayFacts });

  // Open right now: open (incl. snoozed) conversations, counted by the search API.
  const open = await call(creds, "/conversations/search", { query: { field: "open", operator: "=", value: true }, pagination: { per_page: 1 } });
  await writeSnapshot(ctx, w.today, [{ metric: "support_open_tickets", value: Number(open.total_count ?? 0) }], SNAPSHOT);

  return finishRecordSync(ctx, {
    coveredFrom: w.coveredFrom, today: w.today, records: count, recomputed,
    cursor: { updatedAt: Math.max(maxSeen, w.initial ? startedAt - overlap : 0) },
    notes: w.initial ? ["Open conversations are recorded from today onward; past backlog sizes aren't reconstructed."] : [],
  });
}

export const intercom: ConnectorDefinition = {
  id: "intercom",
  name: "Intercom",
  category: "Support",
  description: "Inbound conversations created and closed by channel, open backlog, first reply time and conversation ratings.",
  implemented: true,
  configKeys: [],
  scopes: [{ scope: "Read conversations", reason: "Conversation timestamps, state, channel, reply statistics and ratings (message content and contact details are not stored)" }],
  metrics: [...FLOW, ...SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Changes appear at the next sync (every hour)",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: 30,
  docsUrl: "https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/searchconversations",
  tokenConnect: {
    fields: [
      { key: "accessToken", label: "Access token", secret: true },
      { key: "region", label: "Data region (US, EU or AU)", placeholder: "US", optional: true, help: "Where your Intercom workspace is hosted; leave empty for US." },
    ],
    instructions: [
      "In Intercom open Settings → Integrations → Developer Hub and create a new app (internal integration) for your workspace.",
      "Under Configure → Authentication copy the Access token.",
      "Make sure the app has the \"Read conversations\" and \"Read admins\" permissions (Configure → Authentication → Edit).",
      "If your workspace is hosted in Europe or Australia, choose EU or AU as the data region.",
    ],
    async connect(input) {
      const v = required(input, { accessToken: "Access token" });
      const region = (input.region ?? "").trim().toLowerCase() || "us";
      if (!HOSTS[region]) throw new ProviderError("permanent", "The data region must be US, EU or AU.");
      if (!/^[A-Za-z0-9+/=_-]{30,}$/.test(v.accessToken)) throw new ProviderError("permanent", "That doesn't look like an Intercom access token.");
      const creds = { access_token: v.accessToken, region };
      const info = await me(creds);
      if (!info.app?.id_code) throw new ProviderError("permanent", "Intercom didn't return the workspace for this token.");
      return { credentials: creds, scopes: ["Read conversations"], externalAccountId: info.app.id_code, displayName: info.app.name, tokenExpiresAt: null, settings: { authMode: "token", region } };
    },
  },
  async discoverAssets(creds) {
    const info = await me(creds);
    const app = info.app!;
    let tz: string | null = app.timezone ?? null;
    try {
      if (tz) new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      tz = null; // not an IANA name
    }
    return [{ providerAssetId: app.id_code, name: app.name, kind: "workspace", currency: null, timezone: tz, metadata: { region: creds.region } }];
  },
  sync: syncWorkspace,
  async healthCheck(ctx) {
    await me(await ctx.credentials());
  },
};
