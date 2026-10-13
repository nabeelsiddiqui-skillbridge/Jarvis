import { addDays, todayIn } from "@bca/shared";
import { datesBetween, replaceFacts, updateAssetCursor, upsertSourceRecords, type FactInput } from "./normalize.js";
import type { SyncContext, SyncResult } from "./types.js";

/**
 * Shared sync for providers that return pre-aggregated daily reports (GA4, Search
 * Console, Google Ads). The report rows for the fetched window are authoritative,
 * so facts for exactly those days are replaced; each row is also kept as a source
 * record for provenance. Days in the window with no total row are written as
 * zeros only up to the provider's latest available day.
 */
export interface ReportRow {
  date: string;
  /** "" for totals, otherwise the dimension key (channel, campaign…) */
  dimKey: string;
  dimValue: string;
  values: Record<string, number>;
}

export interface ReportPlan {
  /** Metric keys this connector owns (deleted/replaced for fetched days). */
  owned: string[];
  /** Metrics that are money (get the asset currency). */
  money: Set<string>;
  /** Days of history on first import. */
  initialDays: number;
  /** Days re-fetched on each incremental sync (late-arriving data). */
  lookbackDays: number;
  /** Days re-fetched on reconciliation. */
  reconcileDays: number;
  /** Days before "today" that the provider has no data for yet (e.g. Search Console ≈ 2). */
  lagDays: number;
  /** Max days per API request window. */
  windowDays: number;
  fetch(ctx: SyncContext, from: string, to: string): Promise<ReportRow[]>;
  /** Whether zero-filling totals is correct for days with no rows (true for counts/spend). */
  zeroFillTotals: boolean;
}

export async function syncReport(ctx: SyncContext, plan: ReportPlan): Promise<SyncResult> {
  const tz = ctx.asset.timezone ?? "UTC";
  const today = todayIn(tz);
  const lastDay = addDays(today, -plan.lagDays);
  const cursor = ctx.asset.sync_cursor ?? {};
  const initial = ctx.mode === "initial" || !cursor.coveredFrom;
  const from = initial ? addDays(today, -plan.initialDays + 1)
    : ctx.mode === "reconcile" ? addDays(today, -plan.reconcileDays)
    : addDays(cursor.coveredTo && cursor.coveredTo < addDays(today, -plan.lookbackDays) ? cursor.coveredTo : today, -plan.lookbackDays);
  const coveredFrom = initial ? from : (cursor.coveredFrom as string);

  const rows: ReportRow[] = [];
  for (let start = from; start <= lastDay; start = addDays(start, plan.windowDays)) {
    const end = addDays(start, plan.windowDays - 1) < lastDay ? addDays(start, plan.windowDays - 1) : lastDay;
    rows.push(...(await plan.fetch(ctx, start, end)));
  }
  const days = datesBetween(from < coveredFrom ? coveredFrom : from, lastDay);
  const latestWithData = rows.filter((r) => r.dimKey === "").map((r) => r.date).sort().pop() ?? null;

  // Provenance: keep every report row.
  await upsertSourceRecords(ctx, rows.map((r) => ({
    recordType: `report:${r.dimKey || "total"}`,
    providerId: `${r.date}|${r.dimValue}`,
    localDate: r.date,
    occurredAt: `${r.date}T00:00:00Z`,
    payload: r,
  })));

  const byDay = new Map<string, ReportRow[]>();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const currency = ctx.asset.currency ?? null;
  const toFacts = (date: string): FactInput[] => {
    const facts: FactInput[] = [];
    const dayRows = byDay.get(date) ?? [];
    const hasTotal = dayRows.some((r) => r.dimKey === "");
    if (!hasTotal && plan.zeroFillTotals && latestWithData && date <= latestWithData) {
      for (const m of plan.owned) if (!m.startsWith("_")) facts.push({ metric: m, value: 0, currency: plan.money.has(m) ? currency : null });
    }
    for (const r of dayRows) {
      for (const [m, v] of Object.entries(r.values)) {
        if (!Number.isFinite(v)) continue;
        facts.push({ metric: m, value: v, currency: plan.money.has(m) ? currency : null, dimKey: r.dimKey, dimValue: r.dimValue });
      }
    }
    return facts;
  };
  // Never write days after the provider's latest available data (they'd look like zeros).
  const writable = days.filter((d) => !latestWithData || d <= latestWithData || !plan.zeroFillTotals);
  const recomputed = await replaceFacts(ctx, writable, toFacts, plan.owned);
  const coveredTo = latestWithData && (!cursor.coveredTo || latestWithData > cursor.coveredTo) ? latestWithData : (cursor.coveredTo ?? latestWithData);
  await updateAssetCursor(ctx.db, ctx.asset.id, { coveredFrom, coveredTo }, coveredTo);
  return { records: rows.length, datesRecomputed: recomputed, coveredFrom, coveredTo };
}
