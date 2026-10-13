import type pg from "pg";
import {
  addDays, baseDependencies, formatMetricValue, getMetric, todayIn,
  type BaseMetric, type ConnectionsEvidence, type DimensionId, type InsightDriver, type InsightSeverity, type MetricEvidence, type MetricUnit, type QueryResult, type WidgetQueryInput,
} from "@bca/shared";
import { widgetQuery } from "@bca/shared";
import { availableBaseMetrics, loadAvailability, loadCalcs, runQuery, type Availability, type EngineBusiness } from "../metrics/engine.js";
import { toMetricEvidence } from "../metrics/evidence.js";

/**
 * Deterministic insight rules. Every number in a finding comes from the metric
 * engine over complete, fully covered periods; nothing here is AI-generated.
 *  - period_change: last 7 complete days vs the previous 7 (significant moves only)
 *  - anomaly: yesterday far outside the trailing 28-day daily distribution
 *  - goal_pacing: period-to-date progress against user-confirmed goals
 *  - data_health: failing, disconnected or stale connections (auto-resolved when healthy)
 */

export interface Candidate {
  rule: "period_change" | "anomaly" | "goal_pacing" | "data_health" | "threshold";
  dedupeKey: string;
  severity: InsightSeverity;
  title: string;
  finding: string;
  impact: string | null;
  nextStep: string | null;
  metricKey: string | null;
  period: { from: string; to: string } | null;
  comparison: { from: string; to: string } | null;
  evidence: (MetricEvidence | ConnectionsEvidence)[];
  drivers: InsightDriver[];
}

interface Biz extends EngineBusiness { workspace_id: string; name: string }

const SUM_METRICS = ["store_net_sales", "store_orders", "sessions", "key_events", "ad_spend", "ad_conversions", "organic_clicks", "crm_qualified_leads", "crm_new_contacts", "crm_won_value"];
const RATIO_METRICS: Record<string, { volume: string; min: number }> = {
  conversion_rate: { volume: "sessions", min: 500 },
  aov: { volume: "store_orders", min: 30 },
  roas: { volume: "ad_spend", min: 300 },
  cpa: { volume: "ad_conversions", min: 15 },
  organic_ctr: { volume: "organic_impressions", min: 1000 },
  mer: { volume: "ad_spend", min: 300 },
};
const MIN_VOLUME: Partial<Record<MetricUnit, number>> = { currency: 300, count: 50, number: 20 };
/** Lumpy totals (a few large deals) need enough events behind them before a % change means anything. */
const SUM_VOLUME: Record<string, { metric: string; min: number }> = { crm_won_value: { metric: "crm_deals_won", min: 5 } };
const DRIVER_DIMS: DimensionId[] = ["channel", "campaign", "product", "source_medium", "pipeline", "page", "country"];

const NEXT_STEP: Record<string, { down: string; up: string }> = {
  store_net_sales: { down: "Check the largest contributors below, then confirm checkout, stock and pricing weren't the cause.", up: "Identify what drove the increase (products, channels) and whether it can be repeated." },
  store_orders: { down: "Compare traffic and conversion rate for the same period to see whether fewer visitors or fewer conversions caused the drop.", up: "Check which channels brought the extra orders." },
  sessions: { down: "Review traffic by channel to find which sources declined, and check for tracking changes.", up: "See which channels grew and whether the extra traffic converts." },
  key_events: { down: "Check landing pages and forms for issues and compare traffic by channel.", up: "Find the pages and channels producing the extra conversions." },
  ad_spend: { down: "Confirm budgets and campaign status are as intended.", up: "Review campaigns with the largest spend increase and their return." },
  ad_conversions: { down: "Review campaigns with the largest drop and check conversion tracking.", up: "Consider shifting budget towards the campaigns driving the gain." },
  organic_clicks: { down: "Open Search Console data by page and query to find where clicks were lost.", up: "Note which pages gained and keep them updated." },
  crm_qualified_leads: { down: "Review lead sources and qualification criteria for changes.", up: "Check which sources produced the extra qualified leads." },
  crm_new_contacts: { down: "Review lead capture sources and forms.", up: "See which sources brought the new contacts." },
  crm_won_value: { down: "Review stalled deals in the pipeline and the sales team's close dates.", up: "Note which pipelines and deal types closed." },
  conversion_rate: { down: "Check site speed, checkout and landing pages, and compare by device and channel.", up: "Find which channels or pages improved and apply what works elsewhere." },
  aov: { down: "Check discounts, product mix and bundles.", up: "See which products raised order value." },
  roas: { down: "Review campaigns with falling return; pause or adjust the weakest.", up: "Consider scaling the campaigns with the best return, carefully." },
  cpa: { down: "Keep doing what lowered acquisition cost; scale cautiously.", up: "Review campaigns where cost per conversion rose and check targeting and bids." },
  organic_ctr: { down: "Review titles and descriptions on pages with falling click-through.", up: "Note which pages improved click-through." },
  mer: { down: "Compare ad spend growth with sales growth; trim spend that isn't returning.", up: "Marketing efficiency improved; check which channels contributed." },
};

const pctText = (v: number) => `${Math.abs(v) >= 10 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}%`;

async function q(db: pg.PoolClient, business: Biz, av: Availability, calcs: Awaited<ReturnType<typeof loadCalcs>>, input: WidgetQueryInput): Promise<QueryResult> {
  return runQuery({ db, business, availability: av, calcs, dashboardRange: { preset: "last_30_days" } }, widgetQuery.parse(input));
}

export async function detectInsights(db: pg.PoolClient, business: Biz): Promise<Candidate[]> {
  const av = await loadAvailability(db, business);
  const available = availableBaseMetrics(av);
  const has = (k: string) => baseDependencies(k).every((d) => available.has(d));
  const calcs = await loadCalcs(db, business.id);
  const today = todayIn(business.timezone);
  const yesterday = addDays(today, -1);
  const week = { from: addDays(yesterday, -6), to: yesterday };
  const out: Candidate[] = [];
  let n = 0;
  const eid = () => `I${++n}`;

  // ---- period change (sum metrics)
  for (const key of SUM_METRICS.filter(has)) {
    const m = getMetric(key) as BaseMetric;
    const r = await q(db, business, av, calcs, { metric: key, dateRange: week, comparison: "previous_period" });
    if (r.availability !== "available" || r.comparisonPartial || r.change == null || r.total == null || r.comparisonTotal == null) continue;
    if (Math.max(r.total, r.comparisonTotal) < (MIN_VOLUME[m.unit] ?? 50)) continue;
    if (Math.abs(r.change) < 15) continue;
    const vol = SUM_VOLUME[key];
    if (vol) {
      const v = await q(db, business, av, calcs, { metric: vol.metric, dateRange: week, comparison: "previous_period" });
      if ((v.total ?? 0) + (v.comparisonTotal ?? 0) < vol.min) continue;
    }
    const favorable = (r.change > 0) === m.higherIsBetter;
    if (favorable && Math.abs(r.change) < 20) continue;
    const severity: InsightSeverity = favorable ? "positive" : Math.abs(r.change) >= 40 ? "critical" : "warning";
    const delta = r.total - r.comparisonTotal;
    const fmt = (v: number | null) => formatMetricValue(v, m.unit, r.currency);
    const drivers = await driversFor(db, business, av, calcs, key, r);
    const ev = toMetricEvidence(eid(), r, { dimension: null, granularity: "none" }, `${m.label}, last 7 days vs previous 7`);
    out.push({
      rule: "period_change",
      dedupeKey: `period_change:${key}:${r.change > 0 ? "up" : "down"}:${weekStart(yesterday)}`,
      severity,
      title: `${m.label} ${r.change > 0 ? "up" : "down"} ${pctText(r.change)} over the last 7 days`,
      finding: `${m.label} was ${fmt(r.total)} from ${week.from} to ${week.to}, compared with ${fmt(r.comparisonTotal)} in the previous 7 days (${r.change > 0 ? "+" : "−"}${pctText(r.change)}).`,
      impact: `About ${fmt(Math.abs(delta))} ${delta > 0 ? "more" : "less"} ${m.label.toLowerCase()} than the previous 7 days${drivers[0] ? `; the largest contributor was ${drivers[0].label} (${drivers[0].delta > 0 ? "+" : "−"}${fmt(Math.abs(drivers[0].delta))}).` : "."}`,
      nextStep: NEXT_STEP[key]?.[r.change > 0 ? "up" : "down"] ?? null,
      metricKey: key, period: r.range, comparison: r.comparisonRange, evidence: [ev], drivers,
    });
  }

  // ---- period change (ratios, only with enough volume behind them)
  for (const [key, vol] of Object.entries(RATIO_METRICS)) {
    if (!has(key) || !has(vol.volume)) continue;
    const m = getMetric(key)!;
    const [r, v] = await Promise.all([
      q(db, business, av, calcs, { metric: key, dateRange: week, comparison: "previous_period" }),
      q(db, business, av, calcs, { metric: vol.volume, dateRange: week, comparison: "previous_period" }),
    ]);
    if (r.availability !== "available" || r.comparisonPartial || r.change == null || r.total == null || r.comparisonTotal == null) continue;
    if ((v.total ?? 0) < vol.min || (v.comparisonTotal ?? 0) < vol.min) continue;
    if (Math.abs(r.change) < 15) continue;
    const favorable = (r.change > 0) === m.higherIsBetter;
    if (favorable && Math.abs(r.change) < 20) continue;
    const fmt = (x: number | null) => formatMetricValue(x, m.unit as MetricUnit, r.currency);
    const ev = toMetricEvidence(eid(), r, { dimension: null, granularity: "none" }, `${m.label}, last 7 days vs previous 7`);
    out.push({
      rule: "period_change",
      dedupeKey: `period_change:${key}:${r.change > 0 ? "up" : "down"}:${weekStart(yesterday)}`,
      severity: favorable ? "positive" : Math.abs(r.change) >= 40 ? "critical" : "warning",
      title: `${m.label} ${r.change > 0 ? "up" : "down"} ${pctText(r.change)} over the last 7 days`,
      finding: `${m.label} was ${fmt(r.total)} from ${week.from} to ${week.to}, compared with ${fmt(r.comparisonTotal)} in the previous 7 days.`,
      impact: m.unit === "percent" ? `A change of ${Math.abs(r.total - r.comparisonTotal).toFixed(2)} percentage points.` : null,
      nextStep: NEXT_STEP[key]?.[r.change > 0 ? "up" : "down"] ?? null,
      metricKey: key, period: r.range, comparison: r.comparisonRange, evidence: [ev], drivers: [],
    });
  }

  // ---- daily anomaly (yesterday vs the previous 28 days)
  for (const key of SUM_METRICS.filter(has)) {
    const m = getMetric(key) as BaseMetric;
    const r = await q(db, business, av, calcs, { metric: key, dateRange: { from: addDays(yesterday, -28), to: yesterday }, granularity: "day", comparison: "none" });
    const s = r.series ?? [];
    if (r.availability !== "available" || s.length < 29 || s.some((p) => p.value == null)) continue;
    const hist = s.slice(0, -1).map((p) => p.value!);
    const y = s.at(-1)!.value!;
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / (hist.length - 1));
    if (mean * 7 < (MIN_VOLUME[m.unit] ?? 50) || sd === 0) continue;
    const z = (y - mean) / sd;
    const rel = mean ? ((y - mean) / mean) * 100 : 0;
    if (Math.abs(z) < 3 || Math.abs(rel) < 30) continue;
    const favorable = (z > 0) === m.higherIsBetter;
    const fmt = (v: number) => formatMetricValue(v, m.unit, r.currency);
    const yr = await q(db, business, av, calcs, { metric: key, dateRange: { from: yesterday, to: yesterday }, comparison: "none" });
    const ev = toMetricEvidence(eid(), yr, { dimension: null, granularity: "none" }, `${m.label} on ${yesterday}`);
    const hev = toMetricEvidence(eid(), r, { dimension: null, granularity: "day" }, `${m.label}, daily for the previous 28 days`);
    out.push({
      rule: "anomaly",
      dedupeKey: `anomaly:${key}:${yesterday}`,
      severity: favorable ? "positive" : "warning",
      title: `Unusual ${m.label.toLowerCase()} on ${yesterday}`,
      finding: `${m.label} was ${fmt(y)} on ${yesterday}, ${rel > 0 ? "above" : "below"} the 28-day daily average of ${fmt(mean)} by ${pctText(rel)} (${Math.abs(z).toFixed(1)} standard deviations).`,
      impact: `${fmt(Math.abs(y - mean))} ${y > mean ? "above" : "below"} a typical day.`,
      nextStep: favorable ? "Check what happened that day (campaign, promotion, press) so it can be repeated." : "Check for outages, tracking problems or a campaign change on that day.",
      metricKey: key, period: { from: yesterday, to: yesterday }, comparison: { from: addDays(yesterday, -28), to: addDays(yesterday, -1) }, evidence: [ev, hev], drivers: [],
    });
  }

  // ---- goal pacing
  const goals = (await db.query(`SELECT id, title, metric_key, target_value::float8 AS target, period FROM business_goals WHERE business_id = $1 AND metric_key IS NOT NULL AND target_value IS NOT NULL`, [business.id])).rows;
  for (const g of goals) {
    if (!has(g.metric_key)) continue;
    const m = getMetric(g.metric_key)!;
    const preset = g.period === "quarter" ? "quarter_to_date" : g.period === "year" ? "year_to_date" : "month_to_date";
    // Complete days only (through yesterday), so today's partial figure doesn't distort the pace.
    const ptd = await q(db, business, av, calcs, { metric: g.metric_key, dateRange: { preset }, comparison: "none" });
    const start = ptd.range.from;
    if (yesterday < start) continue;
    const r = await q(db, business, av, calcs, { metric: g.metric_key, dateRange: { from: start, to: yesterday }, comparison: "none" });
    if (r.availability !== "available" || r.total == null) continue;
    const periodEnd = g.period === "quarter" ? endOfQuarter(start) : g.period === "year" ? `${start.slice(0, 4)}-12-31` : endOfMonth(start);
    const elapsed = daysBetween(start, r.range.to) + 1; // days covered by the figure (today may be in progress)
    const total = daysBetween(start, periodEnd) + 1;
    if (elapsed < 6) continue; // too early in the period to judge pace
    const isSum = m.kind === "base" ? (m as BaseMetric).aggregation === "sum" : false;
    const expected = isSum ? (g.target * elapsed) / total : g.target;
    const pace = expected ? (r.total / expected) * 100 : null;
    if (pace == null) continue;
    const better = m.higherIsBetter ? pace : 200 - pace;
    if (better >= 90 && better < 105) continue;
    const fmt = (v: number) => formatMetricValue(v, m.unit as MetricUnit, r.currency);
    const ev = toMetricEvidence(eid(), r, { dimension: null, granularity: "none" }, `${m.label}, ${g.period} to date (complete days)`);
    out.push({
      rule: "goal_pacing",
      dedupeKey: `goal_pacing:${g.id}:${start}:${better < 90 ? "behind" : "ahead"}`,
      severity: better < 75 ? "critical" : better < 90 ? "warning" : "positive",
      title: `${better < 90 ? "Behind" : "Ahead of"} pace on "${g.title}"`,
      finding: `${m.label} is ${fmt(r.total)} so far this ${g.period} (${start} to ${r.range.to}), against a ${g.period}ly target of ${fmt(g.target)}${isSum ? ` — ${pace.toFixed(0)}% of where it would be at an even pace (${fmt(expected)})` : ""}.`,
      impact: isSum ? `At the current rate the ${g.period} would end near ${fmt((r.total / Math.max(1, elapsed)) * total)}.` : null,
      nextStep: better < 90 ? "Review the drivers of this metric and agree actions for the rest of the period." : "Keep the current plan; consider raising the target if the trend holds.",
      metricKey: g.metric_key, period: r.range, comparison: null, evidence: [ev], drivers: [],
    });
  }

  // ---- data health
  const conns = (await db.query(
    `SELECT c.id, c.provider, c.display_name, c.status, c.last_error, c.last_success_at, c.is_demo,
            (SELECT max(a.latest_data_date)::text FROM connection_assets a WHERE a.connection_id = c.id AND a.selected) AS latest
       FROM connections c WHERE c.business_id = $1 AND c.disconnected_at IS NULL`,
    [business.id],
  )).rows;
  for (const c of conns) {
    const src = av.sources.find((s) => s.connectionId === c.id);
    const problem = c.status === "reauth_required" ? "reconnect" : c.status === "error" ? "error" : src?.stale ? "stale" : null;
    if (!problem || c.is_demo) continue;
    const id = eid();
    const evidence: ConnectionsEvidence = { id, kind: "connections", question: "Data connection status", connections: [{ provider: src?.provider ?? c.provider, name: c.display_name, status: c.status, lastSuccessAt: c.last_success_at ? new Date(c.last_success_at).toISOString() : null, latestDataDate: c.latest, stale: Boolean(src?.stale), lastError: c.last_error, isDemo: false }] };
    out.push({
      rule: "data_health",
      dedupeKey: `data_health:${c.id}:${problem}`,
      severity: problem === "stale" ? "warning" : "critical",
      title: problem === "reconnect" ? `${c.display_name} needs to be reconnected` : problem === "error" ? `${c.display_name} is failing to sync` : `${c.display_name} data is out of date`,
      finding: problem === "stale" ? `The last successful sync was ${c.last_success_at ? new Date(c.last_success_at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never"}; figures from this source may be out of date.` : `The connection reports: ${c.last_error ?? "an error"}.`,
      impact: "Dashboards, insights and assistant answers that use this source show incomplete or stale figures until it recovers.",
      nextStep: problem === "reconnect" ? "Open Connections and reconnect the account." : "Open Connections, check the error and run a sync.",
      metricKey: null, period: null, comparison: null, evidence: [evidence], drivers: [],
    });
  }
  return out;
}

/** Largest contributors to a change, by the first dimension that has data for this metric. */
async function driversFor(db: pg.PoolClient, business: Biz, av: Availability, calcs: Awaited<ReturnType<typeof loadCalcs>>, key: string, r: QueryResult): Promise<InsightDriver[]> {
  const m = getMetric(key)!;
  if (!r.comparisonRange) return [];
  const direction = Math.sign((r.total ?? 0) - (r.comparisonTotal ?? 0));
  for (const dim of DRIVER_DIMS.filter((d) => m.dimensions.includes(d))) {
    const [cur, prev] = await Promise.all([
      q(db, business, av, calcs, { metric: key, dimension: dim, dateRange: r.range, comparison: "none", limit: 50 }),
      q(db, business, av, calcs, { metric: key, dimension: dim, dateRange: r.comparisonRange, comparison: "none", limit: 50 }),
    ]);
    if (!cur.rows?.length || !prev.rows?.length || cur.availability === "unavailable") continue;
    const labels = new Set([...cur.rows, ...prev.rows].map((x) => x.label));
    const val = (rows: NonNullable<QueryResult["rows"]>, l: string) => rows.find((x) => x.label === l)?.value ?? 0;
    return [...labels]
      .map((label) => ({ dimension: dim, label, current: val(cur.rows!, label), previous: val(prev.rows!, label), delta: val(cur.rows!, label) - val(prev.rows!, label) }))
      .filter((d) => Math.sign(d.delta) === direction && d.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 3);
  }
  return [];
}

// ------------------------------------------------------------------ date helpers

const parse = (d: string) => new Date(`${d}T00:00:00Z`);
const fmtD = (t: Date) => t.toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
const endOfMonth = (d: string) => { const t = parse(d); return fmtD(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0))); };
const endOfQuarter = (d: string) => { const t = parse(d); const qEnd = Math.floor(t.getUTCMonth() / 3) * 3 + 3; return fmtD(new Date(Date.UTC(t.getUTCFullYear(), qEnd, 0))); };
/** Monday of the ISO week containing `d`. */
export const weekStart = (d: string) => { const t = parse(d); const wd = (t.getUTCDay() + 6) % 7; return addDays(d, -wd); };
