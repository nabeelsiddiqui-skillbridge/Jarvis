import type pg from "pg";
import {
  addDays, baseDependencies, formatMetricValue, todayIn, widgetQuery,
  type MetricEvidence, type MetricUnit, type ReportContent,
} from "@bca/shared";
import { availableBaseMetrics, loadAvailability, loadCalcs, runQuery, type EngineBusiness } from "../metrics/engine.js";
import { toMetricEvidence } from "../metrics/evidence.js";
import { kpisFor } from "../metrics/kpis.js";
import { PROVIDER_META } from "../metrics/providers.js";
import { AiUnavailable, NARRATIVE_RULES, aiConfigured, aiText } from "../ai/complete.js";

/**
 * Briefings and reports. Figures come from the metric engine; the AI narrative
 * (optional) only summarizes them and cites evidence ids. A report is always
 * usable without AI: the deterministic summary lines are part of the content.
 */

export type ReportKind = "daily_briefing" | "weekly_report" | "custom";
interface Biz extends EngineBusiness { workspace_id: string; name: string; industry: string }

export function reportPeriod(kind: ReportKind, timezone: string, custom?: { from: string; to: string }) {
  const yesterday = addDays(todayIn(timezone), -1);
  if (kind === "daily_briefing") return { period: { from: yesterday, to: yesterday }, label: "the previous day" };
  if (kind === "weekly_report") return { period: { from: addDays(yesterday, -6), to: yesterday }, label: "the previous 7 days" };
  if (!custom) throw new Error("A custom report needs a period");
  return { period: custom, label: "the previous period" };
}

export async function buildReport(db: pg.PoolClient, business: Biz, kind: ReportKind, period: { from: string; to: string }, comparisonLabel: string) {
  const av = await loadAvailability(db, business);
  const available = availableBaseMetrics(av);
  const has = (k: string) => baseDependencies(k).every((d) => available.has(d));
  const calcs = await loadCalcs(db, business.id);
  const ctx = { db, business, availability: av, calcs, dashboardRange: { preset: "last_30_days" as const } };
  let n = 0;
  const headline: MetricEvidence[] = [];
  for (const key of kpisFor(business.industry).filter(has).slice(0, 8)) {
    const query = widgetQuery.parse({ metric: key, dateRange: period, comparison: "previous_period" });
    const r = await runQuery(ctx, query);
    headline.push(toMetricEvidence(`R${++n}`, r, query, `${r.metric.label}, ${period.from === period.to ? period.from : `${period.from} – ${period.to}`}`));
  }
  // Month to date for daily briefings, so the day is seen in context.
  if (kind === "daily_briefing") {
    for (const key of kpisFor(business.industry).filter(has).slice(0, 2)) {
      const query = widgetQuery.parse({ metric: key, dateRange: { preset: "month_to_date" }, comparison: "none" });
      const r = await runQuery(ctx, query);
      headline.push(toMetricEvidence(`R${++n}`, r, query, `${r.metric.label}, month to date`));
    }
  }
  const fmt = (e: MetricEvidence, v: number | null) => formatMetricValue(v, e.metric.unit as MetricUnit, e.currency);
  const movers = headline
    .filter((e) => e.change != null && !e.comparisonPartial && Math.abs(e.change) >= 10 && e.availability === "available")
    .sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!))
    .slice(0, 4)
    .map((e) => ({ metric: e.metric.key, label: e.metric.label, change: e.change!, evidenceId: e.id }));

  const ins = (await db.query(
    `SELECT id, severity, title, finding FROM insights WHERE business_id = $1 AND status = 'open'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'positive' THEN 2 ELSE 3 END, detected_at DESC LIMIT 6`,
    [business.id],
  )).rows;

  const goalsRows = (await db.query(`SELECT title, metric_key, target_value::float8 AS target, period FROM business_goals WHERE business_id = $1 ORDER BY created_at`, [business.id])).rows;
  const goals: ReportContent["goals"] = [];
  for (const g of goalsRows) {
    if (!g.metric_key || !has(g.metric_key) || g.target == null) { goals.push({ title: g.title, metric: g.metric_key, value: null, target: g.target, pacePct: null, unit: null, currency: null }); continue; }
    const preset = g.period === "quarter" ? "quarter_to_date" : g.period === "year" ? "year_to_date" : "month_to_date";
    const r = await runQuery(ctx, widgetQuery.parse({ metric: g.metric_key, dateRange: { preset }, comparison: "none" }));
    goals.push({ title: g.title, metric: g.metric_key, value: r.total, target: g.target, pacePct: r.total != null && g.target ? (r.total / g.target) * 100 : null, unit: r.metric.unit, currency: r.currency });
  }

  const dataHealth = av.sources.map((s) => ({ provider: PROVIDER_META[s.provider]?.name ?? s.provider, name: s.assetName ?? s.accountName, status: s.status, stale: s.stale, lastSuccessAt: s.lastSyncedAt }));
  const summary: string[] = [];
  for (const e of headline.slice(0, kind === "daily_briefing" ? 4 : 6)) {
    if (e.availability === "unavailable") { summary.push(`${e.metric.label}: no data for this period [${e.id}].`); continue; }
    const ch = e.change != null && !e.comparisonPartial ? ` (${e.change >= 0 ? "+" : "−"}${Math.abs(e.change).toFixed(1)}% vs ${comparisonLabel})` : "";
    summary.push(`${e.metric.label}: ${fmt(e, e.total)}${ch}${e.availability === "partial" ? ", partial data" : ""} [${e.id}].`);
  }
  if (ins.length) summary.push(`${ins.length} open insight${ins.length > 1 ? "s" : ""}, led by: ${ins[0].title}.`);
  const unhealthy = dataHealth.filter((d) => d.stale || ["error", "reauth_required"].includes(d.status));
  if (unhealthy.length) summary.push(`Data issues: ${unhealthy.map((d) => `${d.provider} (${d.stale ? "stale" : d.status.replace(/_/g, " ")})`).join(", ")} — affected figures may be incomplete.`);
  if (!headline.length) summary.push("No connected data yet — connect a source to receive figures in this report.");

  const limitations = [...new Set(headline.flatMap((e) => e.limitations))].slice(0, 8);
  const content: ReportContent = {
    headline, comparisonLabel, movers,
    insights: ins.map((i) => ({ id: i.id, severity: i.severity, title: i.title, finding: i.finding })),
    goals, dataHealth, deterministicSummary: summary, limitations,
  };

  let narrative: string | null = null;
  let narrativeStatus: "none" | "ready" | "failed" | "unavailable" = aiConfigured() ? "none" : "unavailable";
  let narrativeModel: string | null = null;
  if (aiConfigured() && headline.length) {
    try {
      const payload = { business: { name: business.name, industry: business.industry, demo: business.is_demo }, report: kind, period, comparison: comparisonLabel, headline: headline.map(slim), movers, open_insights: content.insights, goals, data_health: dataHealth, limitations };
      const r = await aiText({
        system: `${NARRATIVE_RULES}\n\nTask: write the ${kind === "daily_briefing" ? "daily briefing" : "report summary"} for the business team: a short paragraph on how the period went, then up to three bullet points ("- ") on what deserves attention, each citing evidence ids (R1, R2…). Under 150 words.${business.is_demo ? " This is a demo business with sample data; say so once." : ""}`,
        user: JSON.stringify(payload),
        maxTokens: 3000,
      });
      narrative = r.text;
      narrativeModel = r.model;
      narrativeStatus = "ready";
    } catch (e) {
      if (!(e instanceof AiUnavailable)) { console.warn("[report] narrative failed", (e as Error).message); narrativeStatus = "failed"; }
    }
  }
  return { content, narrative, narrativeStatus, narrativeModel };
}

const slim = (e: MetricEvidence) => ({
  id: e.id, metric: e.metric.label, unit: e.metric.unit, currency: e.currency, period: e.range, comparison: e.comparisonRange,
  availability: e.availability, total: e.total, comparison_total: e.comparisonTotal, change_pct: e.change == null ? null : Math.round(e.change * 10) / 10,
  comparison_partial: e.comparisonPartial || undefined, stale_sources: e.sources.filter((s) => s.stale).map((s) => s.provider), limitations: e.limitations,
});

export const REPORT_TITLE: Record<ReportKind, string> = { daily_briefing: "Daily briefing", weekly_report: "Weekly report", custom: "Report" };

export async function saveReport(db: pg.PoolClient, business: Biz, kind: ReportKind, period: { from: string; to: string }, built: Awaited<ReturnType<typeof buildReport>>, opts: { createdBy?: string | null; runId?: string | null; title?: string }) {
  const comparison = built.content.headline.find((h) => h.comparisonRange)?.comparisonRange ?? null;
  const title = opts.title ?? `${REPORT_TITLE[kind]} · ${period.from === period.to ? period.from : `${period.from} – ${period.to}`}`;
  const { rows } = await db.query(
    `INSERT INTO reports (workspace_id, business_id, kind, title, period, comparison, content, narrative, narrative_status, narrative_model, is_demo, automation_run_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [business.workspace_id, business.id, kind, title, JSON.stringify(period), comparison && JSON.stringify(comparison), JSON.stringify(built.content), built.narrative, built.narrativeStatus, built.narrativeModel, business.is_demo, opts.runId ?? null, opts.createdBy ?? null],
  );
  await db.query("SELECT app.notify_business($1, 'report_created', $2)", [business.id, JSON.stringify({ reportId: rows[0].id })]);
  return rows[0].id as string;
}


