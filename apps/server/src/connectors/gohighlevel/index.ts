import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { datesBetween, localDate, type FactInput } from "../normalize.js";
import { Tally, businessTimezone, deleteRecords, finishRecordSync, overridable, recordWindow, recomputeDays, required, storeRecords, writeSnapshot, type StoredRecord } from "../kit.js";
import type { ConnectorDefinition, Credentials, SyncContext, SyncResult } from "../types.js";

/**
 * GoHighLevel (LeadConnector API v2). Connected per sub-account (location) with a Private
 * Integration token (Bearer) plus the `Version` header. Contacts and opportunities are stored
 * as records and aggregated per day in the location's timezone:
 *  - crm_new_contacts by dateAdded (lifecycle_stage = contact type, source_medium = contact source).
 *    GoHighLevel has no lead-qualification field, so qualified leads aren't reported.
 *  - deals created by createdAt; won/lost by lastStatusChangeAt (the moment the status was set;
 *    updatedAt when missing). "abandoned" opportunities count as lost (closed without a win).
 *  - open pipeline/open deals: snapshot of status "open" opportunities for the sync day, by stage and pipeline.
 * Contacts are fetched incrementally by dateUpdated through the contact search; opportunities are
 * re-listed in full each sync (needed for the snapshot), which also detects deletions. Opportunity
 * values use the location's currency when the API reports one, else the business currency.
 */
const GHL = overridable("GOHIGHLEVEL_BASE_URL_OVERRIDE");
const BASE = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
const FLOW = ["crm_new_contacts", "crm_deals_created", "crm_deals_won", "crm_deals_lost", "crm_won_value"];
const SNAPSHOT = ["crm_open_deals", "crm_open_pipeline"];
const MONEY = new Set(["crm_won_value", "crm_open_pipeline"]);
const DATE_FIELDS = ["created", "closed"];
const INITIAL_DAYS = 400;
/** Page sizes (opportunity search allows up to 100). */
export const GHL_LIMITS = { contactPage: 100, opportunityPage: 100 };

interface ContactRec { created: string; stage: string; source: string }
interface DealRec { created: string; closed: string | null; status: "open" | "won" | "lost"; pipeline: string; stage: string; amount: number | null }
type Pipelines = Record<string, { name: string; stages: Record<string, string> }>;

const headers = (c: Credentials) => ({ Authorization: `Bearer ${c.access_token}`, Version: GHL_API_VERSION });

async function get<T = any>(c: Credentials, path: string): Promise<T> {
  const { data } = await providerFetch(GHL(`${BASE}${path}`), { provider: "GoHighLevel", headers: headers(c) });
  return data as T;
}

async function location(c: Credentials) {
  const d = await get(c, `/locations/${encodeURIComponent(c.location_id)}`);
  const loc = d.location ?? d;
  if (!loc?.id) throw new ProviderError("permanent", "GoHighLevel didn't return the location.");
  // Currency isn't a documented location field; accept it when present.
  const currency = (loc.currency ?? loc.business?.currency ?? loc.settings?.currency ?? null) as string | null;
  return { id: String(loc.id), name: String(loc.name ?? `Location ${loc.id}`), timezone: (loc.timezone ?? null) as string | null, currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null };
}

async function pipelines(c: Credentials): Promise<Pipelines> {
  const d = await get(c, `/opportunities/pipelines?locationId=${encodeURIComponent(c.location_id)}`);
  const out: Pipelines = {};
  for (const p of d.pipelines ?? []) out[p.id] = { name: p.name, stages: Object.fromEntries((p.stages ?? []).map((s: any) => [s.id, s.name])) };
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function normContact(o: any, tz: string): ContactRec | null {
  if (!o.dateAdded) return null;
  return { created: localDate(o.dateAdded, tz), stage: o.type ? cap(String(o.type)) : "Unknown", source: o.source ? String(o.source) : "Unknown" };
}

function normDeal(o: any, tz: string, labels: Pipelines): DealRec | null {
  if (!o.createdAt) return null;
  const status = o.status === "won" ? "won" : o.status === "lost" || o.status === "abandoned" ? "lost" : "open";
  const when = o.lastStatusChangeAt ?? o.updatedAt;
  const pipe = labels[o.pipelineId];
  const amount = o.monetaryValue == null ? null : Number(o.monetaryValue);
  return {
    created: localDate(o.createdAt, tz),
    closed: status !== "open" && when ? localDate(when, tz) : null,
    status,
    pipeline: pipe?.name ?? "Unknown pipeline",
    stage: pipe?.stages[o.pipelineStageId] ?? "Unknown stage",
    amount: Number.isFinite(amount) ? amount : null,
  };
}

/** Contacts updated at/after `sinceIso`, ascending, via POST /contacts/search with searchAfter paging. */
async function contactsSince(c: Credentials, sinceIso: string, onPage: (cs: any[]) => Promise<void>) {
  let searchAfter: unknown[] | undefined;
  let page = 1;
  let total = 0;
  let maxSeen = 0;
  for (;;) {
    const { data } = await providerFetch(GHL(`${BASE}/contacts/search`), {
      provider: "GoHighLevel", method: "POST", idempotent: true, headers: headers(c),
      json: {
        locationId: c.location_id,
        pageLimit: GHL_LIMITS.contactPage,
        filters: [{ field: "dateUpdated", operator: "range", value: { gte: sinceIso } }],
        sort: [{ field: "dateUpdated", direction: "asc" }],
        ...(searchAfter ? { searchAfter } : { page }),
      },
    });
    const list: any[] = data.contacts ?? [];
    total += list.length;
    for (const x of list) maxSeen = Math.max(maxSeen, Date.parse(x.dateUpdated ?? "") || 0);
    if (list.length) await onPage(list);
    if (list.length < GHL_LIMITS.contactPage) break;
    const last = list[list.length - 1];
    if (Array.isArray(last.searchAfter)) searchAfter = last.searchAfter;
    else page++;
  }
  return { total, maxSeen };
}

/** Every opportunity in the location (GET /opportunities/search, startAfter/startAfterId paging). */
async function allOpportunities(c: Credentials) {
  const out: any[] = [];
  let after: { startAfter?: string; startAfterId?: string } = {};
  for (;;) {
    const q = new URLSearchParams({ location_id: c.location_id, limit: String(GHL_LIMITS.opportunityPage) });
    if (after.startAfterId) q.set("startAfterId", after.startAfterId);
    if (after.startAfter) q.set("startAfter", after.startAfter);
    const d = await get(c, `/opportunities/search?${q}`);
    const list: any[] = d.opportunities ?? [];
    out.push(...list);
    const meta = d.meta ?? {};
    if (!list.length || !meta.startAfterId || (!meta.nextPageUrl && !meta.nextPage)) break;
    if (meta.startAfterId === after.startAfterId) break; // defensive: no progress
    after = { startAfterId: String(meta.startAfterId), startAfter: meta.startAfter != null ? String(meta.startAfter) : undefined };
  }
  return out;
}

function dayFacts(date: string, records: ((ContactRec | DealRec) & { _type: string })[], currency: string | null): FactInput[] {
  const t = new Tally(FLOW);
  for (const r of records) {
    if (r._type === "contact") {
      const x = r as ContactRec;
      if (x.created === date) t.addAll("crm_new_contacts", 1, { lifecycle_stage: x.stage, source_medium: x.source });
    } else {
      const d = r as DealRec;
      if (d.created === date) t.addAll("crm_deals_created", 1, { pipeline: d.pipeline });
      if (d.closed === date && d.status === "won") {
        t.addAll("crm_deals_won", 1, { pipeline: d.pipeline });
        t.addAll("crm_won_value", d.amount ?? 0, { pipeline: d.pipeline });
      }
      if (d.closed === date && d.status === "lost") t.addAll("crm_deals_lost", 1, { pipeline: d.pipeline });
    }
  }
  return t.facts(MONEY, currency);
}

async function businessCurrency(ctx: SyncContext): Promise<string | null> {
  const { rows } = await ctx.db.query(`SELECT currency FROM businesses WHERE id = $1`, [ctx.connection.business_id]);
  return rows[0]?.currency ?? null;
}

async function syncLocation(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
  const currency = ctx.asset.currency ?? (await businessCurrency(ctx));
  const w = recordWindow(ctx, tz, INITIAL_DAYS);
  const startedAt = Date.now();
  const overlap = 10 * 60_000;
  const affected = new Set<string>();
  const notes: string[] = [];

  const labels = await pipelines(creds);
  await ctx.db.query(`UPDATE connection_assets SET metadata = metadata || $2::jsonb WHERE id = $1`, [ctx.asset.id, JSON.stringify({ pipelines: labels })]);

  // Contacts: initial/reconcile re-read the whole window; incremental continues from the cursor.
  const full = w.initial || ctx.mode === "reconcile";
  const since = full ? new Date(Date.parse(`${w.coveredFrom}T00:00:00Z`) - 86_400_000).toISOString() : new Date(Number(w.cursor.contactsUpdatedMs ?? startedAt) - overlap).toISOString();
  const seen = new Set<string>();
  const contacts = await contactsSince(creds, since, async (list) => {
    const recs: StoredRecord<ContactRec>[] = [];
    for (const o of list) {
      const n = normContact(o, tz);
      seen.add(String(o.id));
      if (n) recs.push({ type: "contact", id: String(o.id), payload: n, date: n.created, occurredAt: new Date(o.dateAdded).toISOString(), updatedAt: o.dateUpdated ?? null });
    }
    await storeRecords(ctx, recs, ["created"], affected);
  });
  if (ctx.mode === "reconcile") {
    // Contacts created in the window always appear in a full re-read; the rest were deleted.
    const { rows } = await ctx.db.query(`SELECT provider_id FROM source_records WHERE asset_id = $1 AND record_type = 'contact' AND payload->>'created' >= $2`, [ctx.asset.id, w.coveredFrom]);
    await deleteRecords(ctx, "contact", rows.map((r) => r.provider_id).filter((id) => !seen.has(id)), DATE_FIELDS, affected);
  }

  // Opportunities: the full list every run (open pipeline needs old open deals; deletions show up as gaps).
  const opps = await allOpportunities(creds);
  const recs: StoredRecord<DealRec>[] = [];
  for (const o of opps) {
    const n = normDeal(o, tz, labels);
    if (n) recs.push({ type: "deal", id: String(o.id), payload: n, date: n.created, occurredAt: new Date(o.createdAt).toISOString(), updatedAt: o.updatedAt ?? null });
  }
  await storeRecords(ctx, recs, ["created", "closed"], affected);
  const ids = new Set(recs.map((r) => r.id));
  const stored = await ctx.db.query(`SELECT provider_id FROM source_records WHERE asset_id = $1 AND record_type = 'deal'`, [ctx.asset.id]);
  await deleteRecords(ctx, "deal", stored.rows.map((r) => r.provider_id).filter((id) => !ids.has(id)), DATE_FIELDS, affected);
  ctx.log(`fetched ${contacts.total} contacts, ${opps.length} opportunities`);

  const prevTo: string | null = w.cursor.coveredTo ?? null;
  const fill = w.initial || !prevTo ? w.allDays() : datesBetween(addDays(prevTo, 1) <= w.today ? addDays(prevTo, 1) : w.today, w.today);
  const dates = [...new Set([...affected, ...fill])].filter((d) => d >= w.coveredFrom && d <= w.today);
  const recomputed = await recomputeDays<ContactRec | DealRec>(ctx, dates, {
    recordTypes: ["contact", "deal"], dateFields: DATE_FIELDS, owned: FLOW, compute: (d, rs) => dayFacts(d, rs, currency),
  });

  const t = new Tally(SNAPSHOT);
  let missing = 0;
  for (const r of recs) {
    if (r.payload.status !== "open") continue;
    if (r.payload.amount == null) missing++;
    const dims = { deal_stage: r.payload.stage, pipeline: r.payload.pipeline };
    t.addAll("crm_open_deals", 1, dims);
    t.addAll("crm_open_pipeline", r.payload.amount ?? 0, dims);
  }
  await writeSnapshot(ctx, w.today, t.facts(MONEY, currency), SNAPSHOT);
  if (missing) notes.push(`${missing} open opportunities have no value and add nothing to pipeline value.`);
  if (!ctx.asset.currency) notes.push(`GoHighLevel doesn't report the location's currency; opportunity values are taken to be in ${currency}.`);
  if (w.initial) notes.push("Open pipeline is recorded from today onward; past pipeline snapshots aren't reconstructed.");

  return finishRecordSync(ctx, {
    coveredFrom: w.coveredFrom, today: w.today, records: contacts.total + opps.length, recomputed, notes,
    cursor: { contactsUpdatedMs: Math.max(Number(w.cursor.contactsUpdatedMs ?? 0), contacts.maxSeen, full ? startedAt - overlap : 0) },
  });
}

export const gohighlevel: ConnectorDefinition = {
  id: "gohighlevel",
  name: "GoHighLevel",
  category: "CRM",
  description: "New contacts, opportunities created, won and lost, won value and open pipeline by stage and pipeline for a sub-account.",
  implemented: true,
  configKeys: [],
  scopes: [
    { scope: "contacts.readonly", reason: "Contact creation dates, type and source (no names, emails or phone numbers are stored)" },
    { scope: "opportunities.readonly", reason: "Opportunity status, value, pipeline and stage" },
    { scope: "locations.readonly", reason: "The sub-account's name and timezone" },
  ],
  metrics: [...FLOW, ...SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Changes appear at the next sync (every hour)",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: 30,
  docsUrl: "https://highlevel.stoplight.io/docs/integrations/",
  tokenConnect: {
    fields: [
      { key: "token", label: "Private Integration token", placeholder: "pit-…", secret: true },
      { key: "locationId", label: "Location (sub-account) ID", placeholder: "ve9EPM428h8vShlRW1KT", help: "Settings → Business Profile → Location ID" },
    ],
    instructions: [
      "In the GoHighLevel sub-account open Settings → Private Integrations and click \"Create new Integration\".",
      "Give it a name and select the scopes View Contacts (contacts.readonly), View Opportunities (opportunities.readonly) and View Locations (locations.readonly).",
      "Create it and copy the token (it starts with pit-); it is shown only once.",
      "Copy the Location ID from Settings → Business Profile (or the sub-account URL).",
    ],
    async connect(input) {
      const v = required(input, { token: "Private Integration token", locationId: "Location ID" });
      if (!/^pit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.token)) throw new ProviderError("permanent", "That doesn't look like a GoHighLevel Private Integration token (it starts with pit-).");
      if (!/^[A-Za-z0-9]{8,40}$/.test(v.locationId)) throw new ProviderError("permanent", "That doesn't look like a GoHighLevel Location ID.");
      const creds = { access_token: v.token, location_id: v.locationId };
      let loc;
      try {
        loc = await location(creds);
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === "scope" || e.kind === "not_found")) throw new ProviderError("permanent", "The token can't read that location. Check the Location ID and that the token was created in that sub-account with locations.readonly.");
        throw e;
      }
      return { credentials: creds, scopes: ["contacts.readonly", "opportunities.readonly", "locations.readonly"], externalAccountId: loc.id, displayName: loc.name, tokenExpiresAt: null, settings: { authMode: "token" } };
    },
  },
  async discoverAssets(creds) {
    const loc = await location(creds);
    return [{ providerAssetId: loc.id, name: loc.name, kind: "location", currency: loc.currency, timezone: loc.timezone, metadata: { pipelines: await pipelines(creds) } }];
  },
  sync: syncLocation,
  async healthCheck(ctx) {
    await location(await ctx.credentials());
  },
};
