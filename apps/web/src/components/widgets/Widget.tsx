import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { CheckCircle2, Clock, Sparkles, XCircle } from "lucide-react";
import { daysBetween, formatMetricValue, resolvePreset, todayIn, type DateRangeSpec, type Goal, type MetricUnit, type WidgetSpec } from "@bca/shared";
import { get } from "@/lib/api";
import { keys } from "@/lib/business";
import { useCatalog, useMetricQuery } from "@/lib/metrics";
import { Prerequisite } from "@/components/ui/EmptyState";
import { WidgetFrame, relativeTime } from "./WidgetFrame";
import { BarsByDimension, DonutView, Empty, FunnelView, GeoView, KpiView, PipelineView, RankingView, SeriesView, TableView } from "./renderers";

export interface WidgetProps {
  widget: WidgetSpec;
  businessId: string;
  timezone: string;
  dashboardRange: DateRangeSpec;
  actions?: ReactNode;
  editing?: boolean;
}

export function Widget(props: WidgetProps) {
  const { widget } = props;
  if (widget.type === "goal") return <GoalWidget {...props} />;
  if (widget.type === "freshness") return <FreshnessWidget {...props} />;
  if (widget.type === "commentary") return <CommentaryWidget {...props} />;
  return <QueryWidget {...props} />;
}

function QueryWidget({ widget, businessId, dashboardRange, actions, editing }: WidgetProps) {
  const interval = widget.refresh.mode === "interval" ? widget.refresh.intervalSec : undefined;
  // Time-series widgets need a granularity; charts default to daily.
  const query = widget.query && (widget.type === "line" || widget.type === "area" || (widget.type === "bar" && !widget.query.dimension)) && widget.query.granularity === "none"
    ? { ...widget.query, granularity: "day" as const }
    : widget.query;
  const q = useMetricQuery(businessId, query, dashboardRange, interval);
  const catalog = useCatalog(businessId);
  const labels = Object.fromEntries([...(catalog.data?.metrics ?? []), ...(catalog.data?.calculated ?? [])].map((m) => [m.key, { label: m.label, unit: m.unit }]));
  const r = q.data;
  let view: ReactNode = null;
  if (r && r.availability !== "unavailable") {
    switch (widget.type) {
      case "kpi": view = <KpiView result={r} widget={widget} />; break;
      case "line": case "area": view = <SeriesView result={r} widget={widget} />; break;
      case "bar": view = widget.query?.dimension ? <BarsByDimension result={r} /> : <SeriesView result={r} widget={widget} />; break;
      case "donut": view = <DonutView result={r} />; break;
      case "table": view = <TableView result={r} widget={widget} metricLabels={labels} />; break;
      case "ranking": view = <RankingView result={r} />; break;
      case "geo": view = <GeoView result={r} />; break;
      case "funnel": view = <FunnelView result={r} />; break;
      case "pipeline": view = <PipelineView result={r} />; break;
      default: view = <Empty>Unsupported widget</Empty>;
    }
  }
  return (
    <WidgetFrame title={widget.title} result={r} loading={q.isPending} error={q.error} onRetry={() => q.refetch()} actions={actions} businessId={businessId} dragHandle={editing}>
      {view}
    </WidgetFrame>
  );
}

function goalRange(period: Goal["period"], timezone: string): { preset: "month_to_date" | "quarter_to_date" | "year_to_date" } {
  void timezone;
  return { preset: period === "quarter" ? "quarter_to_date" : period === "year" ? "year_to_date" : "month_to_date" };
}

function GoalWidget({ widget, businessId, timezone, actions, editing }: WidgetProps) {
  const goals = useQuery({ queryKey: keys.goals(businessId), queryFn: ({ signal }) => get<Goal[]>(`/businesses/${businessId}/goals`, signal) });
  const goal = goals.data?.find((g) => g.id === widget.options.goalId);
  const range = goal ? goalRange(goal.period, timezone) : null;
  const q = useMetricQuery(businessId, goal?.metricKey && range ? { metric: goal.metricKey, dateRange: range, comparison: "none" } : null);
  const r = q.data;
  let body: ReactNode;
  if (goals.isPending) body = null;
  else if (!goal) body = <Empty>This goal was deleted.</Empty>;
  else if (!goal.metricKey || goal.targetValue == null) body = <p className="text-sm text-muted">“{goal.title}” isn't linked to a metric and target, so progress can't be measured. Edit the goal in Business settings.</p>;
  else if (r && r.availability !== "unavailable" && r.total != null) {
    const pct = (r.total / goal.targetValue) * 100;
    const today = todayIn(timezone);
    const span = resolvePreset(range!.preset, today);
    const periodEnd = goal.period === "month" ? new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).toISOString().slice(0, 10) : null;
    const elapsed = periodEnd ? daysBetween(span.from, today) / daysBetween(span.from, periodEnd) : null;
    const higher = r.metric.higherIsBetter;
    // Ratios (e.g. MER) are compared directly; additive metrics are paced through the period.
    const additive = ["currency", "count"].includes(r.metric.unit) && !r.metric.formula;
    const onTrack = additive && elapsed ? (higher ? pct / 100 >= elapsed * 0.97 : pct / 100 <= elapsed) : higher ? r.total >= goal.targetValue : r.total <= goal.targetValue;
    body = (
      <div className="flex h-full flex-col justify-center gap-2">
        <p className="text-[13px] text-muted">{goal.title}</p>
        <div className="flex items-baseline gap-2">
          <span className="font-display text-2xl font-semibold tabular-nums">{formatMetricValue(r.total, r.metric.unit as MetricUnit, r.currency)}</span>
          <span className="text-sm text-subtle">of {formatMetricValue(goal.targetValue, r.metric.unit as MetricUnit, r.currency)}</span>
        </div>
        {additive && (
          <div className="relative h-2 rounded-full bg-white/5" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${goal.title} progress`}>
            <div className="h-full rounded-full bg-gradient-to-r from-accent to-violet" style={{ width: `${Math.min(100, pct)}%` }} />
            {elapsed != null && <div className="absolute -top-1 h-4 w-0.5 rounded bg-fg/60" style={{ left: `${Math.min(100, elapsed * 100)}%` }} title="Where you'd be on a straight-line pace" />}
          </div>
        )}
        <p className={`inline-flex items-center gap-1.5 text-xs font-medium ${onTrack ? "text-success" : "text-warning"}`}>
          {onTrack ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
          {onTrack ? "On track" : "Behind"} {additive ? `· ${pct.toFixed(0)}% of target${elapsed ? `, ${(elapsed * 100).toFixed(0)}% of the ${goal.period} elapsed` : ""}` : `· this ${goal.period} to date`}
        </p>
      </div>
    );
  }
  return (
    <WidgetFrame title={widget.title} result={r} loading={goals.isPending || q.isPending && Boolean(goal?.metricKey)} error={q.error} actions={actions} businessId={businessId} dragHandle={editing}>
      {body}
    </WidgetFrame>
  );
}

function FreshnessWidget({ widget, businessId, actions, editing }: WidgetProps) {
  const catalog = useCatalog(businessId);
  const sources = catalog.data?.sources ?? [];
  return (
    <section className="panel flex h-full flex-col overflow-hidden">
      <header className={`flex items-center gap-2 px-4 pb-1 pt-3 ${editing ? "widget-drag cursor-grab" : ""}`}>
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{widget.title}</h3>
        {actions}
      </header>
      <div className="widget-nodrag min-h-0 flex-1 overflow-auto px-4 py-2">
        {catalog.isPending ? null : !sources.length ? (
          <p className="text-sm text-muted">No data sources yet. <Link className="text-accent hover:underline" to={`/app/b/${businessId}/connections`}>Connect one</Link>.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-subtle"><tr><th className="py-1 text-left font-medium">Source</th><th className="text-left font-medium">Status</th><th className="text-left font-medium">Latest data</th><th className="text-left font-medium">Last sync</th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.connectionId} className="border-t border-line/60">
                  <td className="py-1.5 pr-2"><span className="font-medium">{s.accountName}</span>{s.reportingDelay && <span className="block text-[11px] text-subtle">{s.reportingDelay}</span>}</td>
                  <td className="pr-2">{s.isDemo ? <span className="text-demo">Demo</span> : s.stale ? <span className="inline-flex items-center gap-1 text-warning"><Clock className="size-3" />Stale</span> : s.status === "active" ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="size-3" />Healthy</span> : <span className="text-danger">{s.status.replace("_", " ")}</span>}</td>
                  <td className="pr-2 tabular-nums">{s.latestDataDate ?? "—"}</td>
                  <td className="tabular-nums text-muted">{s.isDemo ? "—" : relativeTime(s.lastSyncedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function CommentaryWidget({ widget, actions, editing }: WidgetProps) {
  return (
    <section className="panel flex h-full flex-col overflow-hidden">
      <header className={`flex items-center gap-2 px-4 pb-1 pt-3 ${editing ? "widget-drag cursor-grab" : ""}`}>
        <Sparkles className="size-4 text-violet" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{widget.title}</h3>
        {actions}
      </header>
      <div className="widget-nodrag flex-1 overflow-auto px-4 py-2">
        <Prerequisite title="AI commentary arrives with the assistant (build stage 5)">
          This widget will summarize what changed on this dashboard, citing the widgets' data. It never shows text until real analysis is available.
        </Prerequisite>
      </div>
    </section>
  );
}
