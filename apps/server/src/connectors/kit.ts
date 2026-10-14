import { addDays, todayIn } from "@bca/shared";
import { ProviderError, providerUrl } from "./http.js";
import { datesBetween, replaceFacts, updateAssetCursor, upsertSourceRecords, type FactInput } from "./normalize.js";
import type { SyncContext, SyncResult } from "./types.js";

/**
 * Building blocks shared by the record-based connectors (WooCommerce, Stripe, Zendesk,
 * Intercom, Salesforce, GoHighLevel, Xero…): records are stored as source records with
 * the reporting dates they affect, and only those days are recomputed from what is stored.
 */

/** Route a provider URL to a local stand-in in tests (`<PROVIDER>_BASE_URL_OVERRIDE`). */
export const overridable = (envKey: string) => (url: string) => providerUrl(url, envKey);

/** The business's reporting timezone (for providers that don't report one). */
export async function businessTimezone(ctx: SyncContext): Promise<string> {
  const { rows } = await ctx.db.query(`SELECT timezone FROM businesses WHERE id = $1`, [ctx.connection.business_id]);
  return rows[0]?.timezone ?? "UTC";
}

/** Daily counter: metric × optional dimension value → value. */
export class Tally {
  private m = new Map<string, number>();
  constructor(owned: string[] = []) {
    for (const k of owned) this.add(k, 0); // explicit daily totals (true zeros)
  }
  add(metric: string, by = 1, dimKey = "", dimValue = "") {
    const k = `${metric}\u0000${dimKey}\u0000${dimValue}`;
    this.m.set(k, (this.m.get(k) ?? 0) + by);
    return this;
  }
  /** Add to the total and to each listed dimension. */
  addAll(metric: string, by: number, dims: Record<string, string | null | undefined> = {}) {
    this.add(metric, by);
    for (const [k, v] of Object.entries(dims)) if (v != null && v !== "") this.add(metric, by, k, v);
    return this;
  }
  facts(money: Set<string> = new Set(), currency: string | null = null): FactInput[] {
    return [...this.m].map(([k, v]) => {
      const [metric, dimKey, dimValue] = k.split("\u0000") as [string, string, string];
      const isMoney = money.has(metric);
      return { metric, dimKey, dimValue, value: isMoney ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000, currency: isMoney ? currency : null };
    });
  }
}

export interface StoredRecord<P> {
  type: string;
  id: string;
  payload: P;
  /** Primary reporting date (YYYY-MM-DD, local). */
  date: string;
  occurredAt: string;
  updatedAt?: string | null;
}

/**
 * Upsert records and return every reporting date whose figures may change: the dates in
 * the previous stored version (e.g. an order moved to another day) and in the new one.
 * `dateFields` names payload fields holding local dates.
 */
export async function storeRecords<P extends Record<string, any>>(ctx: SyncContext, recs: StoredRecord<P>[], dateFields: (keyof P & string)[], affected: Set<string>) {
  if (!recs.length) return;
  const byType = new Map<string, StoredRecord<P>[]>();
  for (const r of recs) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
  for (const [type, list] of byType) {
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      const prev = await ctx.db.query(`SELECT payload FROM source_records WHERE asset_id = $1 AND record_type = $2 AND provider_id = ANY($3::text[])`, [ctx.asset.id, type, chunk.map((r) => r.id)]);
      for (const { payload } of prev.rows) for (const f of dateFields) if (payload?.[f]) affected.add(payload[f]);
    }
  }
  for (const r of recs) for (const f of dateFields) if (r.payload[f]) affected.add(r.payload[f]);
  for (let i = 0; i < recs.length; i += 1000) {
    await upsertSourceRecords(ctx, recs.slice(i, i + 1000).map((r) => ({
      recordType: r.type, providerId: r.id, localDate: r.date, occurredAt: r.occurredAt, sourceUpdatedAt: r.updatedAt ?? null, payload: r.payload,
    })));
  }
}

/** Remove records that no longer exist at the provider (e.g. deleted tickets), returning their dates. */
export async function deleteRecords(ctx: SyncContext, type: string, ids: string[], dateFields: string[], affected: Set<string>) {
  if (!ids.length) return;
  const { rows } = await ctx.db.query(`DELETE FROM source_records WHERE asset_id = $1 AND record_type = $2 AND provider_id = ANY($3::text[]) RETURNING payload`, [ctx.asset.id, type, ids]);
  for (const { payload } of rows) for (const f of dateFields) if (payload?.[f]) affected.add(payload[f]);
}

/**
 * Recompute the given days from stored records. Loads every record of `recordTypes`
 * whose `dateFields` touch those days in one pass, then calls `compute(date, records)`
 * with the records touching each day.
 */
export async function recomputeDays<P = any>(
  ctx: SyncContext,
  dates: Iterable<string>,
  opts: { recordTypes: string[]; dateFields: string[]; owned: string[]; compute: (date: string, records: (P & { _type: string })[]) => FactInput[] },
) {
  const list = [...new Set(dates)].sort();
  if (!list.length) return 0;
  const cond = opts.dateFields.map((f) => `payload->>'${f.replace(/[^a-zA-Z0-9_]/g, "")}' = ANY($3::text[])`).join(" OR ");
  const { rows } = await ctx.db.query(
    `SELECT record_type, payload FROM source_records WHERE asset_id = $1 AND record_type = ANY($2::text[]) AND (${cond})`,
    [ctx.asset.id, opts.recordTypes, list],
  );
  const touching = new Map<string, (P & { _type: string })[]>();
  for (const r of rows) {
    const rec = { ...r.payload, _type: r.record_type };
    const seen = new Set<string>();
    for (const f of opts.dateFields) {
      const d = r.payload?.[f];
      if (d && !seen.has(d)) {
        seen.add(d);
        touching.set(d, [...(touching.get(d) ?? []), rec]);
      }
    }
  }
  return replaceFacts(ctx, list, (d) => opts.compute(d, touching.get(d) ?? []), opts.owned);
}

/** Write point-in-time figures (open tickets, MRR, stock) for one day — normally "today". */
export async function writeSnapshot(ctx: SyncContext, date: string, facts: FactInput[], owned: string[]) {
  return replaceFacts(ctx, [date], () => facts, owned);
}

/**
 * The date window a record-based sync covers. The first import covers `initialDays`; later
 * syncs continue from the cursor. All days in the covered range are real (empty days are zeros).
 */
export function recordWindow(ctx: SyncContext, tz: string, initialDays: number) {
  const today = todayIn(tz);
  const cursor = ctx.asset.sync_cursor ?? {};
  const initial = ctx.mode === "initial" || !cursor.coveredFrom;
  const coveredFrom: string = initial ? addDays(today, -initialDays + 1) : cursor.coveredFrom;
  return { today, initial, coveredFrom, cursor, allDays: () => datesBetween(coveredFrom, today) };
}

/** Finish a record-based sync: save the cursor and report. */
export async function finishRecordSync(ctx: SyncContext, p: { coveredFrom: string; today: string; records: number; recomputed: number; cursor?: Record<string, unknown>; notes?: string[] }): Promise<SyncResult> {
  await updateAssetCursor(ctx.db, ctx.asset.id, { coveredFrom: p.coveredFrom, coveredTo: p.today, ...(p.cursor ?? {}) }, p.today);
  return { records: p.records, datesRecomputed: p.recomputed, coveredFrom: p.coveredFrom, coveredTo: p.today, notes: p.notes };
}

/** Basic auth header value. */
export const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/** Unix seconds → ISO. */
export const fromUnix = (s: number | null | undefined) => (s == null ? null : new Date(s * 1000).toISOString());

/** Require non-empty trimmed fields, with a friendly message. */
export function required(input: Record<string, string>, fields: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, label] of Object.entries(fields)) {
    const v = (input[k] ?? "").trim();
    if (!v) throw new ProviderError("permanent", `${label} is required.`);
    out[k] = v;
  }
  return out;
}
