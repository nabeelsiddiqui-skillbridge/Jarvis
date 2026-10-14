import { replaceFacts, updateAssetCursor, upsertSourceRecords, type FactInput } from "../normalize.js";
import type { ConnectorDefinition, SyncContext, SyncResult } from "../types.js";
import { importableMetrics, type ImportProvider, type ParsedTable, type TableRow } from "./parse.js";

/**
 * CSV upload. There's no provider: the user uploads a file through
 * POST /api/businesses/:id/imports/csv (routes/imports.ts), which parses it with the shared
 * table parser, stores one source record per day ("row", keyed by date) and queues a sync.
 * The sync rewrites the connection's facts from the stored rows: every day that has stored
 * facts or rows is recomputed, so a re-upload fully replaces the previous file's figures
 * (days missing from the new file lose their facts). Figures are daily totals only
 * (no dimension breakdowns); empty cells are "no data", never zero.
 */

const ROW = "row";

/** Metrics a manual source owns (all importable ones, so stale columns are cleared on re-upload). */
export const ownedMetrics = (provider: ImportProvider) => importableMetrics(provider).map((m) => m.key);

/** Replace the stored rows of this asset with a freshly parsed table. */
export async function storeTable(ctx: Pick<SyncContext, "db" | "connection" | "asset" | "jobId">, table: ParsedTable) {
  await ctx.db.query(`DELETE FROM source_records WHERE asset_id = $1 AND record_type = $2`, [ctx.asset.id, ROW]);
  for (let i = 0; i < table.rows.length; i += 2000) {
    await upsertSourceRecords(ctx as SyncContext, table.rows.slice(i, i + 2000).map((r) => ({
      recordType: ROW, providerId: r.date, localDate: r.date, occurredAt: `${r.date}T00:00:00Z`, payload: r,
    })));
  }
  if (table.currency !== ctx.asset.currency) {
    await ctx.db.query(`UPDATE connection_assets SET currency = $2 WHERE id = $1`, [ctx.asset.id, table.currency]);
    ctx.asset.currency = table.currency;
  }
}

function rowFacts(r: TableRow | undefined, money: Set<string>): FactInput[] {
  if (!r) return [];
  return Object.entries(r.values).map(([metric, value]) => ({ metric, value, currency: money.has(metric) ? r.currency : null }));
}

/** Rewrite every fact of this asset from its stored rows (days no longer present are cleared). */
export async function rewriteFromRows(ctx: SyncContext, provider: ImportProvider, notes: string[] = []): Promise<SyncResult> {
  const money = new Set(importableMetrics(provider).filter((m) => m.unit === "currency").map((m) => m.key));
  const stored = await ctx.db.query(`SELECT payload FROM source_records WHERE asset_id = $1 AND record_type = $2`, [ctx.asset.id, ROW]);
  const rows = new Map<string, TableRow>(stored.rows.map((r) => [r.payload.date, r.payload as TableRow]));
  const existing = await ctx.db.query(`SELECT DISTINCT date::text AS d FROM metric_facts WHERE asset_id = $1`, [ctx.asset.id]);
  const dates = [...new Set([...rows.keys(), ...existing.rows.map((r) => r.d as string)])].sort();
  const n = await replaceFacts(ctx, dates, (d) => rowFacts(rows.get(d), money), ownedMetrics(provider));
  const kept = [...rows.keys()].sort();
  const from = kept[0] ?? null;
  const to = kept[kept.length - 1] ?? null;
  await updateAssetCursor(ctx.db, ctx.asset.id, { coveredFrom: from, coveredTo: to, rows: kept.length }, to);
  return { records: kept.length, datesRecomputed: n, coveredFrom: from, coveredTo: to, notes: notes.length ? notes : undefined };
}

export const csvUpload: ConnectorDefinition = {
  id: "csv",
  name: "CSV upload",
  category: "Data import",
  description: "Upload your own daily figures (sales, ad spend, books, email, support…) as a CSV file: one row per day, one column per metric.",
  implemented: true,
  configKeys: [],
  scopes: [],
  metrics: ownedMetrics("csv"),
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Only as current as the last upload",
  // Uploaded figures don't go stale on a schedule; re-syncing only recomputes stored rows.
  staleAfterHours: 24 * 365,
  syncIntervalMinutes: 24 * 60,
  reconcileDays: 0,
  sync: (ctx) => rewriteFromRows(ctx, "csv"),
};
