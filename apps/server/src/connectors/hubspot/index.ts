import { createHash, createHmac } from "node:crypto";
import { addDays, todayIn } from "@bca/shared";
import { config } from "../../config.js";
import { safeEqual } from "../../lib/crypto.js";
import { ProviderError, providerFetch, providerUrl } from "../http.js";
import { datesBetween, localDate, replaceFacts, updateAssetCursor, upsertSourceRecords, type FactInput } from "../normalize.js";
import type { ConnectorDefinition, Credentials, SyncContext, SyncResult, VerifiedWebhook } from "../types.js";

/**
 * HubSpot CRM. OAuth 2.0 (30-minute access tokens, long-lived refresh token).
 * Contacts and deals are imported as records via the CRM search API (incremental
 * by last-modified time, working around the 10,000-result search window), stored
 * as source records and aggregated per day in the portal's timezone:
 *  - new contacts by create date; qualified leads by the date a contact first became an MQL or SQL
 *  - deals created by create date; won/lost and won value by close date (home currency)
 *  - open pipeline is a point-in-time snapshot, recorded for the day of each sync
 *    (HubSpot doesn't expose historical pipeline states, so past snapshots aren't invented).
 * Webhooks (contact/deal changes) are verified with the v3 signature and trigger a re-fetch.
 */
const H = (url: string) => providerUrl(url, "HUBSPOT_BASE_URL_OVERRIDE");
const API = (path: string) => H(`https://api.hubapi.com/${path}`);
const SCOPES = ["oauth", "crm.objects.contacts.read", "crm.objects.deals.read"];
const FLOW = ["crm_new_contacts", "crm_qualified_leads", "crm_deals_created", "crm_deals_won", "crm_deals_lost", "crm_won_value"];
const SNAPSHOT = ["crm_open_deals", "crm_open_pipeline"];
/** HubSpot search returns at most 10k results per query (adjustable for tests). */
export const HUBSPOT_LIMITS = { searchWindow: 10_000 };
const PAGE = 200;

const CONTACT_PROPS = ["createdate", "lastmodifieddate", "lifecyclestage", "hs_analytics_source", "hs_lifecyclestage_marketingqualifiedlead_date", "hs_lifecyclestage_salesqualifiedlead_date"];
const DEAL_PROPS = ["createdate", "hs_lastmodifieddate", "closedate", "pipeline", "dealstage", "amount_in_home_currency", "hs_is_closed", "hs_is_closed_won"];

const SOURCE: Record<string, string> = {
  ORGANIC_SEARCH: "Organic search", PAID_SEARCH: "Paid search", EMAIL_MARKETING: "Email", SOCIAL_MEDIA: "Organic social", PAID_SOCIAL: "Paid social",
  REFERRALS: "Referrals", DIRECT_TRAFFIC: "Direct", OTHER_CAMPAIGNS: "Other campaigns", OFFLINE: "Offline sources", AI_REFERRALS: "AI referrals",
};
const STAGE: Record<string, string> = {
  subscriber: "Subscriber", lead: "Lead", marketingqualifiedlead: "MQL", salesqualifiedlead: "SQL", opportunity: "Opportunity", customer: "Customer", evangelist: "Evangelist", other: "Other",
};

/** What we keep per record — no names, emails or other personal data. */
interface ContactRec { kind: "contact"; created: string; qualified: string | null; stage: string; source: string }
interface DealRec { kind: "deal"; created: string; closed: string | null; status: "open" | "won" | "lost"; pipeline: string; stage: string; amount: number | null }

const auth = (creds: Credentials) => ({ Authorization: `Bearer ${creds.access_token}` });

// ------------------------------------------------------------------ OAuth

async function token(form: Record<string, string>) {
  const { data } = await providerFetch(API("oauth/v3/token"), { provider: "HubSpot", method: "POST", form, retries: 0 });
  return data as { access_token: string; refresh_token: string; expires_in: number };
}

async function accountInfo(creds: Credentials) {
  const { data } = await providerFetch(API("account-info/v3/details"), { provider: "HubSpot", headers: auth(creds) });
  return data as { portalId: number; timeZone?: string; companyCurrency?: string; uiDomain?: string; accountType?: string };
}

/** Pipeline/stage ids → labels, cached on the asset. */
async function pipelines(creds: Credentials) {
  const { data } = await providerFetch(API("crm/v3/pipelines/deals"), { provider: "HubSpot", headers: auth(creds) });
  const out: Record<string, { label: string; stages: Record<string, string> }> = {};
  for (const p of data.results ?? []) out[p.id] = { label: p.label, stages: Object.fromEntries((p.stages ?? []).map((s: any) => [s.id, s.label])) };
  return out;
}

// ------------------------------------------------------------------ normalize

function normContact(o: any, tz: string): ContactRec | null {
  const p = o.properties ?? {};
  if (!p.createdate) return null;
  const q = [p.hs_lifecyclestage_marketingqualifiedlead_date, p.hs_lifecyclestage_salesqualifiedlead_date].filter(Boolean).sort()[0];
  return {
    kind: "contact",
    created: localDate(p.createdate, tz),
    qualified: q ? localDate(q, tz) : null,
    stage: STAGE[p.lifecyclestage] ?? (p.lifecyclestage ? "Other" : "Unknown"),
    source: SOURCE[p.hs_analytics_source] ?? (p.hs_analytics_source ? "Other" : "Unknown"),
  };
}

function normDeal(o: any, tz: string, labels: Record<string, { label: string; stages: Record<string, string> }>): DealRec | null {
  const p = o.properties ?? {};
  if (!p.createdate) return null;
  const won = p.hs_is_closed_won === "true";
  const closed = p.hs_is_closed === "true" || won;
  const pipe = labels[p.pipeline];
  const amount = p.amount_in_home_currency == null || p.amount_in_home_currency === "" ? null : Number(p.amount_in_home_currency);
  return {
    kind: "deal",
    created: localDate(p.createdate, tz),
    closed: closed && p.closedate ? localDate(p.closedate, tz) : null,
    status: won ? "won" : closed ? "lost" : "open",
    pipeline: pipe?.label ?? "Unknown pipeline",
    stage: pipe?.stages[p.dealstage] ?? "Unknown stage",
    amount: Number.isFinite(amount) ? amount : null,
  };
}

// ------------------------------------------------------------------ fetch

/**
 * All objects modified at/after `sinceMs`, ascending. The search API stops at 10k
 * results, so when a window fills up the query restarts from the last modified time seen.
 */
async function searchModified(creds: Credentials, object: "contacts" | "deals", sinceMs: number, onPage: (objs: any[]) => Promise<void>) {
  const modProp = object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";
  const props = object === "contacts" ? CONTACT_PROPS : DEAL_PROPS;
  let since = sinceMs;
  let maxSeen = sinceMs;
  let total = 0;
  for (;;) {
    let after: string | undefined;
    let inWindow = 0;
    let lastMod = since;
    for (;;) {
      const { data } = await providerFetch(API(`crm/v3/objects/${object}/search`), {
        provider: "HubSpot",
        method: "POST",
        idempotent: true,
        headers: auth(creds),
        json: {
          filterGroups: [{ filters: [{ propertyName: modProp, operator: "GTE", value: String(since) }] }],
          sorts: [{ propertyName: modProp, direction: "ASCENDING" }],
          properties: props,
          limit: PAGE,
          ...(after ? { after } : {}),
        },
      });
      const results: any[] = data.results ?? [];
      inWindow += results.length;
      total += results.length;
      for (const r of results) {
        const t = Date.parse(r.properties?.[modProp] ?? r.updatedAt ?? "");
        if (Number.isFinite(t)) { lastMod = Math.max(lastMod, t); maxSeen = Math.max(maxSeen, t); }
      }
      if (results.length) await onPage(results);
      after = data.paging?.next?.after;
      if (!after || inWindow + PAGE > HUBSPOT_LIMITS.searchWindow) break;
    }
    if (!after) break; // exhausted
    if (lastMod <= since) throw new ProviderError("permanent", `More than ${HUBSPOT_LIMITS.searchWindow} HubSpot ${object} share one modification time; can't page past them.`);
    since = lastMod; // overlapping restart; upserts are idempotent
  }
  return { total, maxSeen };
}

async function batchRead(creds: Credentials, object: "contacts" | "deals", ids: string[]) {
  if (!ids.length) return [];
  const { data } = await providerFetch(API(`crm/v3/objects/${object}/batch/read`), {
    provider: "HubSpot",
    method: "POST",
    idempotent: true,
    headers: auth(creds),
    json: { inputs: ids.map((id) => ({ id })), properties: object === "contacts" ? CONTACT_PROPS : DEAL_PROPS },
  });
  return (data.results ?? []) as any[];
}

// ------------------------------------------------------------------ store + aggregate

/** Upsert records, collecting every date whose figures may change (old and new). */
async function store(ctx: SyncContext, kind: "contact" | "deal", objs: any[], tz: string, affected: Set<string>) {
  const labels = (ctx.asset.metadata?.pipelines ?? {}) as Record<string, { label: string; stages: Record<string, string> }>;
  const recs = objs.map((o) => ({ o, n: kind === "contact" ? normContact(o, tz) : normDeal(o, tz, labels) })).filter((x) => x.n);
  if (!recs.length) return;
  const prev = await ctx.db.query(`SELECT payload FROM source_records WHERE asset_id = $1 AND record_type = $2 AND provider_id = ANY($3::text[])`,
    [ctx.asset.id, kind, recs.map((r) => String(r.o.id))]);
  const touch = (p: any) => { for (const d of [p.created, p.qualified, p.closed]) if (d) affected.add(d); };
  prev.rows.forEach((r) => touch(r.payload));
  recs.forEach((r) => touch(r.n));
  await upsertSourceRecords(ctx, recs.map(({ o, n }) => ({
    recordType: kind,
    providerId: String(o.id),
    localDate: n!.created,
    occurredAt: o.properties.createdate,
    sourceUpdatedAt: o.properties.lastmodifieddate ?? o.properties.hs_lastmodifieddate ?? o.updatedAt ?? null,
    payload: n,
  })));
}

/** Flow metrics for one day, from stored records. Days in the covered range with no activity are real zeros. */
async function computeDay(ctx: SyncContext, date: string): Promise<FactInput[]> {
  const { rows } = await ctx.db.query(
    `SELECT payload FROM source_records WHERE asset_id = $1 AND record_type IN ('contact','deal')
        AND (payload->>'created' = $2 OR payload->>'qualified' = $2 OR payload->>'closed' = $2)`,
    [ctx.asset.id, date],
  );
  const currency = ctx.asset.currency ?? null;
  const facts: FactInput[] = [];
  const counts = new Map<string, number>(); // metric|dimKey|dimValue
  const inc = (metric: string, dimKey = "", dimValue = "", by = 1) => counts.set(`${metric}|${dimKey}|${dimValue}`, (counts.get(`${metric}|${dimKey}|${dimValue}`) ?? 0) + by);
  for (const m of FLOW) inc(m, "", "", 0); // explicit daily totals
  for (const { payload: p } of rows) {
    if (p.kind === "contact") {
      if (p.created === date) { inc("crm_new_contacts"); inc("crm_new_contacts", "lifecycle_stage", p.stage); inc("crm_new_contacts", "source_medium", p.source); }
      if (p.qualified === date) { inc("crm_qualified_leads"); inc("crm_qualified_leads", "source_medium", p.source); }
    } else {
      if (p.created === date) { inc("crm_deals_created"); inc("crm_deals_created", "pipeline", p.pipeline); }
      if (p.closed === date && p.status === "won") {
        inc("crm_deals_won"); inc("crm_deals_won", "pipeline", p.pipeline);
        inc("crm_won_value", "", "", p.amount ?? 0); inc("crm_won_value", "pipeline", p.pipeline, p.amount ?? 0);
      }
      if (p.closed === date && p.status === "lost") { inc("crm_deals_lost"); inc("crm_deals_lost", "pipeline", p.pipeline); }
    }
  }
  for (const [k, v] of counts) {
    const [metric, dimKey, dimValue] = k.split("|") as [string, string, string];
    const money = metric === "crm_won_value";
    facts.push({ metric, value: money ? Math.round(v * 100) / 100 : v, currency: money ? currency : null, dimKey, dimValue });
  }
  return facts;
}

/** Current open pipeline (a snapshot for "today"). */
async function snapshot(ctx: SyncContext): Promise<{ facts: FactInput[]; missingAmounts: number }> {
  const { rows } = await ctx.db.query(`SELECT payload FROM source_records WHERE asset_id = $1 AND record_type = 'deal' AND payload->>'status' = 'open'`, [ctx.asset.id]);
  const currency = ctx.asset.currency ?? null;
  const facts: FactInput[] = [];
  let missingAmounts = 0;
  const agg = new Map<string, { n: number; v: number }>([["||", { n: 0, v: 0 }]]); // explicit total, even with no open deals
  const bump = (k: string, amount: number) => { const a = agg.get(k) ?? { n: 0, v: 0 }; a.n++; a.v += amount; agg.set(k, a); };
  for (const { payload: p } of rows) {
    if (p.amount == null) missingAmounts++;
    const a = p.amount ?? 0;
    bump("||", a); bump(`deal_stage|${p.stage}`, a); bump(`pipeline|${p.pipeline}`, a);
  }
  for (const [k, { n, v }] of agg) {
    const [dimKey, dimValue = ""] = k === "||" ? ["", ""] : k.split("|");
    facts.push({ metric: "crm_open_deals", value: n, dimKey, dimValue });
    facts.push({ metric: "crm_open_pipeline", value: Math.round(v * 100) / 100, currency, dimKey, dimValue });
  }
  return { facts, missingAmounts };
}

// ------------------------------------------------------------------ sync

async function syncPortal(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? "UTC";
  const today = todayIn(tz);
  const cursor = ctx.asset.sync_cursor ?? {};
  const initial = ctx.mode === "initial" || !cursor.coveredFrom;
  const startedAt = Date.now();
  const affected = new Set<string>();
  const notes: string[] = [];

  // Refresh pipeline labels each run so renamed stages show correctly.
  ctx.asset.metadata = { ...ctx.asset.metadata, pipelines: await pipelines(creds) };
  await ctx.db.query(`UPDATE connection_assets SET metadata = metadata || $2::jsonb WHERE id = $1`, [ctx.asset.id, JSON.stringify({ pipelines: ctx.asset.metadata.pipelines })]);

  const coveredFrom: string = initial ? addDays(today, -399) : cursor.coveredFrom;
  // Initial: every contact touched since the window start, and *all* deals (open pipeline needs old open deals).
  // Incremental: everything modified since the last run (10-minute overlap). Reconcile: re-read 30 days of changes.
  const overlap = 10 * 60_000;
  const contactSince = initial ? Date.parse(`${coveredFrom}T00:00:00Z`) - 86_400_000
    : ctx.mode === "reconcile" ? Date.now() - 30 * 86_400_000 : Number(cursor.contactsModifiedMs ?? startedAt) - overlap;
  const dealSince = initial ? 0 : ctx.mode === "reconcile" ? Date.now() - 30 * 86_400_000 : Number(cursor.dealsModifiedMs ?? startedAt) - overlap;

  const c = await searchModified(creds, "contacts", contactSince, (objs) => store(ctx, "contact", objs, tz, affected));
  const d = await searchModified(creds, "deals", dealSince, (objs) => store(ctx, "deal", objs, tz, affected));
  ctx.log(`fetched ${c.total} contacts, ${d.total} deals`);

  const prevTo: string | null = cursor.coveredTo ?? null;
  const fill = datesBetween(initial || !prevTo ? coveredFrom : addDays(prevTo, 1) <= today ? addDays(prevTo, 1) : today, today);
  const dates = [...new Set([...affected, ...fill])].filter((x) => x >= coveredFrom && x <= today).sort();
  const recomputed = await replaceFacts(ctx, dates, (x) => computeDay(ctx, x), FLOW);
  const snap = await snapshot(ctx);
  await replaceFacts(ctx, [today], () => snap.facts, SNAPSHOT);
  if (snap.missingAmounts) notes.push(`${snap.missingAmounts} open deals have no amount and add nothing to pipeline value.`);
  if (initial) notes.push("Open pipeline is recorded from today onward; HubSpot doesn't provide past pipeline snapshots.");

  await updateAssetCursor(ctx.db, ctx.asset.id, {
    coveredFrom, coveredTo: today,
    contactsModifiedMs: Math.max(Number(cursor.contactsModifiedMs ?? 0), c.maxSeen, initial ? startedAt - overlap : 0),
    dealsModifiedMs: Math.max(Number(cursor.dealsModifiedMs ?? 0), d.maxSeen, initial ? startedAt - overlap : 0),
  }, today);
  return { records: c.total + d.total, datesRecomputed: recomputed, coveredFrom, coveredTo: today, notes };
}

// ------------------------------------------------------------------ webhooks

/**
 * v3 signature: base64(HMAC-SHA256(client secret, METHOD + full URI + raw body + timestamp)),
 * rejected if the timestamp is older than 5 minutes. HubSpot sends batches of events.
 */
function verifyWebhook(req: any): VerifiedWebhook | null {
  const secret = process.env.HUBSPOT_CLIENT_SECRET;
  const raw: Buffer | undefined = req.rawBody;
  const sig = req.get("x-hubspot-signature-v3");
  const ts = req.get("x-hubspot-request-timestamp");
  if (!secret || !raw || !sig || !ts) return null;
  if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return null;
  const uri = `${config.apiUrl.replace(/\/$/, "")}${req.originalUrl}`;
  const expected = createHmac("sha256", secret).update(`${req.method}${uri}${raw.toString("utf8")}${ts}`).digest("base64");
  if (!safeEqual(expected, sig)) return null;
  let events: any[];
  try {
    events = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(events) || !events.length) return null;
  const portals = new Set(events.map((e) => String(e.portalId)));
  if (portals.size !== 1) return null; // HubSpot batches per portal
  const deliveryId = createHash("sha256").update(events.map((e) => String(e.eventId)).sort().join(",")).digest("hex");
  return { deliveryId, topic: [...new Set(events.map((e) => e.subscriptionType))].join(","), accountRef: [...portals][0]!, payload: events };
}

async function handleWebhook(ctx: SyncContext, hook: VerifiedWebhook) {
  const events = (hook.payload as any[]) ?? [];
  const ids = (prefix: string) => [...new Set(events.filter((e) => String(e.subscriptionType).startsWith(prefix)).map((e) => String(e.objectId)))];
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? "UTC";
  const affected = new Set<string>();
  const contactIds = ids("contact.");
  const dealIds = ids("deal.");
  // Deleted objects: drop the record (its dates are still recomputed).
  for (const e of events.filter((x) => /\.(deletion|privacyDeletion)$/.test(String(x.subscriptionType)))) {
    const kind = String(e.subscriptionType).startsWith("deal.") ? "deal" : "contact";
    const old = await ctx.db.query(`DELETE FROM source_records WHERE asset_id = $1 AND record_type = $2 AND provider_id = $3 RETURNING payload`, [ctx.asset.id, kind, String(e.objectId)]);
    for (const r of old.rows) for (const dd of [r.payload.created, r.payload.qualified, r.payload.closed]) if (dd) affected.add(dd);
  }
  // Re-read current state through the API rather than trusting event bodies.
  for (let i = 0; i < contactIds.length; i += 100) await store(ctx, "contact", await batchRead(creds, "contacts", contactIds.slice(i, i + 100)), tz, affected);
  for (let i = 0; i < dealIds.length; i += 100) await store(ctx, "deal", await batchRead(creds, "deals", dealIds.slice(i, i + 100)), tz, affected);
  const coveredFrom = ctx.asset.sync_cursor?.coveredFrom;
  const today = todayIn(tz);
  const dates = [...affected].filter((x) => (!coveredFrom || x >= coveredFrom) && x <= today);
  const n = await replaceFacts(ctx, dates, (x) => computeDay(ctx, x), FLOW);
  if (dealIds.length) await replaceFacts(ctx, [today], async () => (await snapshot(ctx)).facts, SNAPSHOT);
  return { datesRecomputed: n };
}

// ------------------------------------------------------------------ definition

export const hubspot: ConnectorDefinition = {
  id: "hubspot",
  name: "HubSpot",
  category: "CRM",
  description: "New contacts, qualified leads, deals created, won and lost, won value and open pipeline by stage and pipeline.",
  implemented: true,
  configKeys: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
  accessRequirements: [
    "A HubSpot public app (developer account) with redirect URL <API_URL>/api/oauth/hubspot/callback and scopes crm.objects.contacts.read, crm.objects.deals.read.",
    "Optional: webhook subscriptions (contact/deal creation, property change, deletion) pointing at <API_URL>/api/webhooks/hubspot for near-real-time updates.",
  ],
  scopes: [
    { scope: "crm.objects.contacts.read", reason: "Contact creation dates, lifecycle stage and original source (no names or emails are stored)" },
    { scope: "crm.objects.deals.read", reason: "Deal stages, pipelines, amounts and close dates" },
    { scope: "oauth", reason: "Identify the HubSpot account" },
  ],
  metrics: [...FLOW, ...SNAPSHOT],
  actions: [],
  supportsWebhooks: true,
  reportingDelay: "Changes appear within minutes (webhooks) or at the next hourly sync",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: 30,
  docsUrl: "https://developers.hubspot.com/docs/api/oauth-quickstart-guide",
  authorizeUrl({ state, redirectUri }) {
    const q = new URLSearchParams({ client_id: process.env.HUBSPOT_CLIENT_ID!, redirect_uri: redirectUri, scope: SCOPES.join(" "), state });
    return `${H("https://app.hubspot.com/oauth/authorize")}?${q}`;
  },
  async handleCallback({ query, redirectUri }) {
    if (!query.code) throw new ProviderError("permanent", "HubSpot didn't return an authorization code.");
    const t = await token({ grant_type: "authorization_code", client_id: process.env.HUBSPOT_CLIENT_ID!, client_secret: process.env.HUBSPOT_CLIENT_SECRET!, redirect_uri: redirectUri, code: query.code });
    const creds = { access_token: t.access_token, refresh_token: t.refresh_token };
    const info = await accountInfo(creds);
    return {
      credentials: creds,
      scopes: SCOPES,
      externalAccountId: String(info.portalId),
      displayName: `HubSpot account #${info.portalId}`,
      tokenExpiresAt: new Date(Date.now() + t.expires_in * 1000),
    };
  },
  needsRefresh: (_c, expiresAt) => !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60_000,
  async refreshCredentials(creds) {
    try {
      const t = await token({ grant_type: "refresh_token", client_id: process.env.HUBSPOT_CLIENT_ID!, client_secret: process.env.HUBSPOT_CLIENT_SECRET!, refresh_token: creds.refresh_token });
      return { credentials: { ...creds, access_token: t.access_token, refresh_token: t.refresh_token ?? creds.refresh_token }, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 400) throw new ProviderError("auth", "HubSpot access was revoked. Reconnect the account.", 400, undefined, e.detail);
      throw e;
    }
  },
  async discoverAssets(creds) {
    const info = await accountInfo(creds);
    return [{ providerAssetId: String(info.portalId), name: `HubSpot account #${info.portalId}`, kind: "portal", currency: info.companyCurrency ?? null, timezone: info.timeZone ?? null, metadata: { pipelines: await pipelines(creds) } }];
  },
  sync: syncPortal,
  verifyWebhook,
  handleWebhook,
  async healthCheck(ctx) {
    await accountInfo(await ctx.credentials());
  },
  async revoke(creds) {
    await providerFetch(API(`oauth/v1/refresh-tokens/${encodeURIComponent(creds.refresh_token)}`), { provider: "HubSpot", method: "DELETE", retries: 0 });
  },
};
