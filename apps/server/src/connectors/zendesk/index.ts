import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { datesBetween, localDate, type FactInput } from "../normalize.js";
import { Tally, basic, businessTimezone, deleteRecords, finishRecordSync, overridable, recordWindow, recomputeDays, required, storeRecords, writeSnapshot, type StoredRecord } from "../kit.js";
import type { ConnectorDefinition, Credentials, SyncContext, SyncResult } from "../types.js";

/**
 * Zendesk Support. Connected with an agent/admin email and an API token (Basic auth
 * "<email>/token:<api token>") against https://<subdomain>.zendesk.com/api/v2.
 * Tickets come from the cursor-based incremental export (with sideloaded metric sets), are
 * stored as records and aggregated per day in the business's timezone (Zendesk's API
 * doesn't expose the account timezone):
 *  - tickets created by created_at; solved by metric_set.solved_at (tickets currently solved/closed)
 *  - first reply minutes (calendar) + tickets with a first reply, and CSAT good/rated, are attributed
 *    to the ticket's CREATED day, so averages describe the tickets that arrived that day
 *  - open tickets (new/open/pending/on-hold) is a snapshot for the sync day from the search count API.
 * Tickets exported with status "deleted" are removed. The export cursor is kept between syncs;
 * reconciliation restarts the export 30 days back to pick up anything missed.
 */
const ZD = overridable("ZENDESK_BASE_URL_OVERRIDE");
const FLOW = ["support_tickets_created", "support_tickets_solved", "support_first_reply_minutes", "support_first_replies", "support_csat_good", "support_csat_rated"];
const SNAPSHOT = ["support_open_tickets"];
const DATE_FIELDS = ["created", "solved"];
const INITIAL_DAYS = 365;
const OPEN_QUERY = "type:ticket status<solved";

interface TicketRec { created: string; solved: string | null; channel: string; firstReplyMin: number | null; csat: "good" | "bad" | null }

const CHANNEL: Record<string, string> = {
  email: "Email", web: "Web form", chat: "Chat", native_messaging: "Messaging", api: "API", voice: "Phone", mobile_sdk: "Mobile SDK",
  mobile: "Mobile", facebook: "Facebook", twitter: "X (Twitter)", any_channel: "Integrations", sms: "SMS", whatsapp: "WhatsApp", instagram_dm: "Instagram",
  rule: "Automation", closed_ticket: "Follow-up", side_conversation: "Side conversation", help_center: "Help center",
};

const base = (c: Credentials) => `https://${c.subdomain}.zendesk.com/api/v2`;
const auth = (c: Credentials) => ({ Authorization: basic(`${c.email}/token`, c.api_token) });

async function get<T = any>(c: Credentials, path: string): Promise<T> {
  const { data } = await providerFetch(ZD(`${base(c)}${path}`), { provider: "Zendesk", headers: auth(c) });
  return data as T;
}

function subdomainOf(raw: string) {
  let v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  v = v.replace(/\.zendesk\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(v)) throw new ProviderError("permanent", "Enter your Zendesk subdomain, e.g. acme for acme.zendesk.com.");
  return v;
}

async function me(c: Credentials) {
  const d = await get(c, "/users/me.json");
  return d.user as { id: number | null; name?: string; role?: string; email?: string };
}

function normTicket(t: any, ms: any | undefined, tz: string): TicketRec | null {
  if (!t.created_at) return null;
  const solvedStatus = t.status === "solved" || t.status === "closed";
  const solvedAt = solvedStatus ? ms?.solved_at ?? t.updated_at : null;
  const reply = ms?.reply_time_in_minutes?.calendar;
  const score = t.satisfaction_rating?.score;
  const channel = t.via?.channel ? CHANNEL[t.via.channel] ?? String(t.via.channel).replace(/_/g, " ").replace(/^./, (x: string) => x.toUpperCase()) : "Unknown";
  return {
    created: localDate(t.created_at, tz),
    solved: solvedAt ? localDate(solvedAt, tz) : null,
    channel,
    firstReplyMin: typeof reply === "number" ? reply : null,
    csat: score === "good" || score === "bad" ? score : null,
  };
}

function dayFacts(date: string, records: TicketRec[]): FactInput[] {
  const t = new Tally(FLOW);
  for (const r of records) {
    const ch = { channel: r.channel };
    if (r.created === date) {
      t.addAll("support_tickets_created", 1, ch);
      if (r.firstReplyMin != null) {
        t.addAll("support_first_replies", 1, ch);
        t.addAll("support_first_reply_minutes", r.firstReplyMin, ch);
      }
      if (r.csat) {
        t.add("support_csat_rated");
        if (r.csat === "good") t.add("support_csat_good");
      }
    }
    if (r.solved === date) t.addAll("support_tickets_solved", 1, ch);
  }
  return t.facts();
}

async function syncAccount(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
  const w = recordWindow(ctx, tz, INITIAL_DAYS);
  const affected = new Set<string>();
  const restart = w.initial || ctx.mode === "reconcile" || !w.cursor.afterCursor;
  const startTime = Math.floor((w.initial ? Date.parse(`${w.coveredFrom}T00:00:00Z`) - 86_400_000 : Date.now() - 30 * 86_400_000) / 1000);
  let url = restart ? `/incremental/tickets/cursor.json?start_time=${startTime}&include=metric_sets` : `/incremental/tickets/cursor.json?cursor=${encodeURIComponent(w.cursor.afterCursor)}&include=metric_sets`;
  let count = 0;
  let afterCursor: string | null = w.cursor.afterCursor ?? null;
  for (;;) {
    const d = await get(creds, url);
    const tickets: any[] = d.tickets ?? [];
    count += tickets.length;
    const metrics = new Map<number, any>((d.metric_sets ?? []).map((m: any) => [m.ticket_id, m]));
    const recs: StoredRecord<TicketRec>[] = [];
    const deleted: string[] = [];
    for (const t of tickets) {
      if (t.status === "deleted") { deleted.push(String(t.id)); continue; }
      const n = normTicket(t, metrics.get(t.id), tz);
      if (n) recs.push({ type: "ticket", id: String(t.id), payload: n, date: n.created, occurredAt: new Date(t.created_at).toISOString(), updatedAt: t.updated_at ?? null });
    }
    await storeRecords(ctx, recs, ["created", "solved"], affected);
    await deleteRecords(ctx, "ticket", deleted, DATE_FIELDS, affected);
    if (d.after_cursor) afterCursor = d.after_cursor;
    if (d.end_of_stream || !d.after_cursor) break;
    url = `/incremental/tickets/cursor.json?cursor=${encodeURIComponent(d.after_cursor)}&include=metric_sets`;
  }
  ctx.log(`exported ${count} tickets`);

  const prevTo: string | null = w.cursor.coveredTo ?? null;
  const fill = w.initial || !prevTo ? w.allDays() : datesBetween(addDays(prevTo, 1) <= w.today ? addDays(prevTo, 1) : w.today, w.today);
  const dates = [...new Set([...affected, ...fill])].filter((x) => x >= w.coveredFrom && x <= w.today);
  const recomputed = await recomputeDays<TicketRec>(ctx, dates, { recordTypes: ["ticket"], dateFields: DATE_FIELDS, owned: FLOW, compute: dayFacts });

  // Open tickets right now (includes tickets older than the imported window).
  const open = await get(creds, `/search/count.json?query=${encodeURIComponent(OPEN_QUERY)}`);
  await writeSnapshot(ctx, w.today, [{ metric: "support_open_tickets", value: Number(open.count ?? 0) }], SNAPSHOT);

  return finishRecordSync(ctx, {
    coveredFrom: w.coveredFrom, today: w.today, records: count, recomputed, cursor: { afterCursor },
    notes: w.initial ? ["Open tickets are recorded from today onward; past backlog sizes aren't reconstructed."] : [],
  });
}

export const zendesk: ConnectorDefinition = {
  id: "zendesk",
  name: "Zendesk",
  category: "Support",
  description: "Tickets created and solved by channel, open backlog, first reply time and customer satisfaction.",
  implemented: true,
  configKeys: [],
  scopes: [{ scope: "read", reason: "Read tickets, their metrics and satisfaction ratings (ticket subjects, messages and requester details are not stored)" }],
  metrics: [...FLOW, ...SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Changes appear at the next sync (every hour)",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: 30,
  docsUrl: "https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/",
  tokenConnect: {
    fields: [
      { key: "subdomain", label: "Zendesk subdomain", placeholder: "acme", help: "The part before .zendesk.com" },
      { key: "email", label: "Agent or admin email", placeholder: "you@company.com" },
      { key: "apiToken", label: "API token", secret: true },
    ],
    instructions: [
      "In Zendesk open Admin Center → Apps and integrations → APIs → Zendesk API (API tokens).",
      "Turn on Token access if it's off, click \"Add API token\", give it a description and copy the token (it's shown once).",
      "Enter the email of an agent or admin (an admin sees every ticket; agents only the tickets they can access) and the token.",
    ],
    async connect(input) {
      const v = required(input, { subdomain: "Zendesk subdomain", email: "Email", apiToken: "API token" });
      const subdomain = subdomainOf(v.subdomain);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw new ProviderError("permanent", "Enter the email address of the Zendesk agent or admin who created the token.");
      if (!/^[A-Za-z0-9]{20,64}$/.test(v.apiToken)) throw new ProviderError("permanent", "That doesn't look like a Zendesk API token (40 letters and digits).");
      const creds = { subdomain, email: v.email, api_token: v.apiToken };
      const user = await me(creds);
      // Unauthenticated requests can come back as the anonymous user rather than a 401.
      if (!user?.id) throw new ProviderError("auth", "Zendesk didn't accept the email and API token.");
      if (user.role !== "admin" && user.role !== "agent") throw new ProviderError("permanent", "That user isn't a Zendesk agent or admin; ticket data needs an agent or admin account.");
      return { credentials: creds, scopes: ["read"], externalAccountId: subdomain, displayName: `${subdomain}.zendesk.com`, tokenExpiresAt: null, settings: { authMode: "token", role: user.role } };
    },
  },
  async discoverAssets(creds) {
    return [{ providerAssetId: creds.subdomain, name: `${creds.subdomain}.zendesk.com`, kind: "account", currency: null, timezone: null }];
  },
  sync: syncAccount,
  async healthCheck(ctx) {
    const user = await me(await ctx.credentials());
    if (!user?.id) throw new ProviderError("auth", "Zendesk no longer accepts the API token. Reconnect the account.");
  },
};
