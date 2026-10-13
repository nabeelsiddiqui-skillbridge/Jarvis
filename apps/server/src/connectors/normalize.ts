import type pg from "pg";
import { addDays, todayIn } from "@bca/shared";
import type { SyncContext } from "./types.js";

export interface SourceRecordInput {
  recordType: string;
  providerId: string;
  localDate: string;
  occurredAt: string;
  sourceUpdatedAt?: string | null;
  payload: unknown;
}

/** Idempotent upsert keyed by (asset, record type, provider id). Re-deliveries just overwrite. */
export async function upsertSourceRecords(ctx: SyncContext, records: SourceRecordInput[]) {
  if (!records.length) return;
  const { connection: c, asset: a } = ctx;
  await ctx.db.query(
    `INSERT INTO source_records (workspace_id, business_id, connection_id, asset_id, provider, record_type, provider_id, local_date, occurred_at, source_updated_at, payload, sync_job_id)
     SELECT $1, $2, $3, $4, $5, t.rt, t.pid, t.ld::date, t.oa::timestamptz, t.su::timestamptz, t.pl::jsonb, $6
       FROM unnest($7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[]) AS t(rt, pid, ld, oa, su, pl)
     ON CONFLICT (asset_id, record_type, provider_id) DO UPDATE SET
       local_date = excluded.local_date, occurred_at = excluded.occurred_at, source_updated_at = excluded.source_updated_at,
       payload = excluded.payload, ingested_at = now(), sync_job_id = excluded.sync_job_id
     WHERE source_records.source_updated_at IS NULL OR excluded.source_updated_at IS NULL OR excluded.source_updated_at >= source_records.source_updated_at`,
    [c.workspace_id, c.business_id, c.id, a.id, c.provider, ctx.jobId,
      records.map((r) => r.recordType), records.map((r) => r.providerId), records.map((r) => r.localDate),
      records.map((r) => r.occurredAt), records.map((r) => r.sourceUpdatedAt ?? null), records.map((r) => JSON.stringify(r.payload))],
  );
}

export interface FactInput {
  metric: string;
  dimKey?: string;
  dimValue?: string;
  value: number;
  currency?: string | null;
}

/**
 * Replace the facts for the given asset-days with freshly computed ones. Runs in
 * one transaction so readers never see a half-written day.
 */
export async function replaceFacts(ctx: SyncContext, dates: string[], compute: (date: string) => Promise<FactInput[]> | FactInput[], ownedMetrics: string[]) {
  if (!dates.length) return 0;
  const { connection: c, asset: a, db } = ctx;
  const rows: (FactInput & { date: string })[] = [];
  for (const d of dates) for (const f of await compute(d)) rows.push({ ...f, date: d });
  await db.query("BEGIN");
  try {
    await db.query(`DELETE FROM metric_facts WHERE asset_id = $1 AND date = ANY($2::date[]) AND metric_key = ANY($3::text[])`, [a.id, dates, ownedMetrics]);
    for (let i = 0; i < rows.length; i += 5000) {
      const chunk = rows.slice(i, i + 5000);
      await db.query(
        `INSERT INTO metric_facts (workspace_id, business_id, connection_id, asset_id, provider, metric_key, date, dim_key, dim_value, value, currency, sync_job_id)
         SELECT $1, $2, $3, $4, $5, m, d::date, dk, dv, v, cur, $6
           FROM unnest($7::text[], $8::text[], $9::text[], $10::text[], $11::numeric[], $12::text[]) AS t(m, d, dk, dv, v, cur)`,
        [c.workspace_id, c.business_id, c.id, a.id, c.provider, ctx.jobId,
          chunk.map((r) => r.metric), chunk.map((r) => r.date), chunk.map((r) => r.dimKey ?? ""), chunk.map((r) => r.dimValue ?? ""),
          chunk.map((r) => r.value), chunk.map((r) => r.currency ?? null)],
      );
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  return dates.length;
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Local reporting date of an instant in a timezone. */
export function localDate(iso: string, timezone: string) {
  return todayIn(timezone, new Date(iso));
}

export async function updateAssetCursor(db: pg.PoolClient, assetId: string, cursor: Record<string, unknown>, latestDataDate: string | null) {
  await db.query(
    `UPDATE connection_assets SET sync_cursor = sync_cursor || $2::jsonb, latest_data_date = COALESCE($3::date, latest_data_date), last_synced_at = now() WHERE id = $1`,
    [assetId, JSON.stringify(cursor), latestDataDate],
  );
}
