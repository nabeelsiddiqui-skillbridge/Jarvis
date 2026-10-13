import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import {
  DIMENSIONS,
  WIDGET_SHAPES,
  WIDGET_TYPES,
  widgetSpec,
  type DateRangeSpec,
  type Goal,
  type WidgetSpec,
  type WidgetType,
} from "@bca/shared";
import { get } from "@/lib/api";
import { keys } from "@/lib/business";
import { cn } from "@/lib/cn";
import { useCatalog } from "@/lib/metrics";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Select } from "@/components/ui/Field";
import { Widget } from "@/components/widgets/Widget";
import { DateRangeSelect, MetricSelect, allMetrics } from "./pickers";
import { CalculatedMetricDialog } from "./CalculatedMetricDialog";

const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  kpi: { w: 3, h: 4 }, line: { w: 6, h: 8 }, area: { w: 6, h: 8 }, bar: { w: 6, h: 8 }, donut: { w: 4, h: 8 }, table: { w: 12, h: 9 },
  funnel: { w: 6, h: 8 }, ranking: { w: 6, h: 8 }, pipeline: { w: 6, h: 7 }, goal: { w: 4, h: 5 }, geo: { w: 6, h: 8 }, commentary: { w: 6, h: 6 }, freshness: { w: 6, h: 6 },
};

export const sizeFor = (t: WidgetType) => DEFAULT_SIZE[t];

type Draft = {
  type: WidgetType;
  title: string;
  titleTouched: boolean;
  metric: string;
  metrics: string[];
  dimension: string;
  granularity: "none" | "day" | "week" | "month";
  dateRange: DateRangeSpec | null;
  comparison: "none" | "previous_period" | "previous_year";
  filterOp: "in" | "not_in";
  filterValues: string;
  limit: number;
  targetValue: string;
  targetPeriod: "range" | "day" | "week" | "month";
  targetLabel: string;
  goalId: string;
  refreshMode: "on_new_data" | "interval" | "manual";
  refreshSec: number;
};

function toDraft(w: WidgetSpec | null): Draft {
  return {
    type: w?.type ?? "kpi",
    title: w?.title ?? "",
    titleTouched: Boolean(w),
    metric: w?.query?.metric ?? "",
    metrics: w?.query?.metrics ?? [],
    dimension: w?.query?.dimension ?? "",
    granularity: w?.query?.granularity ?? "day",
    dateRange: w?.query?.dateRange ?? null,
    comparison: w?.query?.comparison ?? "previous_period",
    filterOp: w?.query?.filters[0]?.op ?? "in",
    filterValues: w?.query?.filters[0]?.values.join(", ") ?? "",
    limit: w?.query?.limit ?? 10,
    targetValue: w?.options.target?.value != null ? String(w.options.target.value) : "",
    targetPeriod: w?.options.target?.period ?? "range",
    targetLabel: w?.options.target?.label ?? "",
    goalId: w?.options.goalId ?? "",
    refreshMode: w?.refresh.mode ?? "on_new_data",
    refreshSec: w?.refresh.intervalSec ?? 900,
  };
}

export function buildSpec(d: Draft, base: WidgetSpec | null, layout: WidgetSpec["layout"]) {
  const shape = WIDGET_SHAPES[d.type];
  const values = d.filterValues.split(",").map((s) => s.trim()).filter(Boolean);
  const query = shape.needsMetric && d.metric
    ? {
        metric: d.metric,
        metrics: shape.multiMetric ? d.metrics.filter(Boolean) : [],
        dimension: shape.dimension === "none" ? null : d.dimension || null,
        granularity: shape.series || (d.type === "bar" && !d.dimension) || d.type === "kpi" ? (d.granularity === "none" ? "day" : d.granularity) : "none",
        dateRange: d.dateRange,
        comparison: d.comparison,
        filters: d.dimension && values.length ? [{ dimension: d.dimension, op: d.filterOp, values }] : [],
        sources: [],
        limit: d.limit,
        sort: "value_desc",
      }
    : null;
  return widgetSpec.safeParse({
    id: base?.id ?? Math.random().toString(36).slice(2, 10),
    type: d.type,
    title: d.title.trim() || WIDGET_TYPES[d.type],
    query,
    options: {
      ...(base?.options ?? {}),
      target: d.targetValue !== "" && Number.isFinite(Number(d.targetValue)) ? { value: Number(d.targetValue), period: d.targetPeriod, label: d.targetLabel || undefined } : null,
      goalId: d.type === "goal" ? d.goalId || null : null,
    },
    refresh: d.refreshMode === "interval" ? { mode: "interval", intervalSec: d.refreshSec } : { mode: d.refreshMode },
    layout,
  });
}

export function WidgetEditor({ open, onClose, initial, businessId, timezone, dashboardRange, onSave }: {
  open: boolean;
  onClose: () => void;
  initial: WidgetSpec | null;
  businessId: string;
  timezone: string;
  dashboardRange: DateRangeSpec;
  onSave: (w: WidgetSpec) => void;
}) {
  const catalog = useCatalog(businessId);
  const goals = useQuery({ queryKey: keys.goals(businessId), queryFn: ({ signal }) => get<Goal[]>(`/businesses/${businessId}/goals`, signal), enabled: open });
  const [d, setD] = useState<Draft>(() => toDraft(initial));
  const [calcOpen, setCalcOpen] = useState(false);
  useEffect(() => { if (open) setD(toDraft(initial)); }, [open, initial]);

  const metrics = allMetrics(catalog.data);
  const metric = metrics.find((m) => m.key === d.metric);
  const shape = WIDGET_SHAPES[d.type];
  const dims = (metric?.dimensions ?? []).filter((x) => (d.type === "geo" ? x === "country" : true));
  const set = (patch: Partial<Draft>) => setD((prev) => {
    const next = { ...prev, ...patch };
    // Suggest a title from the metric until the user types one.
    if (!next.titleTouched) {
      const ml = metrics.find((m) => m.key === next.metric)?.label;
      const dl = next.dimension ? DIMENSIONS[next.dimension as keyof typeof DIMENSIONS] : null;
      next.title = next.type === "goal" ? goals.data?.find((g) => g.id === next.goalId)?.title ?? "Goal progress" : next.type === "freshness" ? "Data freshness" : next.type === "commentary" ? "AI commentary" : ml ? (dl ? `${ml} by ${dl.toLowerCase()}` : ml) : "";
    }
    // Keep the dimension valid for the chosen metric and widget type.
    const nm = metrics.find((m) => m.key === next.metric);
    const nshape = WIDGET_SHAPES[next.type];
    if (nshape.dimension === "none") next.dimension = "";
    else if (next.type === "geo") next.dimension = nm?.dimensions.includes("country") ? "country" : "";
    else if (next.dimension && !nm?.dimensions.includes(next.dimension)) next.dimension = "";
    else if (nshape.dimension === "required" && !next.dimension) next.dimension = nm?.dimensions[0] ?? "";
    return next;
  });

  const layout = initial?.layout ?? { x: 0, y: 10_000, ...sizeFor(d.type) };
  const parsed = useMemo(() => buildSpec(d, initial, { ...layout, ...(initial && initial.type === d.type ? {} : sizeFor(d.type)), y: Math.min(layout.y, 10_000) }), [d, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const error = parsed.success ? null : parsed.error.issues[0]?.message;

  return (
    <Dialog open={open} onClose={onClose} title={initial ? "Edit widget" : "Add widget"} size="xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!parsed.success} onClick={() => parsed.success && onSave(parsed.data)}>{initial ? "Apply" : "Add to dashboard"}</Button></>}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Widget type</legend>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4" role="radiogroup">
              {(Object.keys(WIDGET_TYPES) as WidgetType[]).map((t) => (
                <button key={t} role="radio" aria-checked={d.type === t} onClick={() => set({ type: t })}
                  className={cn("rounded-lg border px-2 py-2 text-xs font-medium transition-colors", d.type === t ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg")}>
                  {WIDGET_TYPES[t]}
                </button>
              ))}
            </div>
          </fieldset>

          <Field label="Title">{(p) => <Input {...p} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value, titleTouched: true })} />}</Field>

          {d.type === "goal" && (
            <Field label="Goal" hint={goals.data && !goals.data.length ? "Add goals in Business settings first." : "Goals need a linked metric and target to show progress."}>
              {(p) => (
                <Select {...p} value={d.goalId} onChange={(e) => set({ goalId: e.target.value })}>
                  <option value="">— Choose a goal —</option>
                  {goals.data?.map((g) => <option key={g.id} value={g.id}>{g.title}{!g.metricKey ? " (no metric linked)" : ""}</option>)}
                </Select>
              )}
            </Field>
          )}

          {shape.needsMetric && (
            <>
              <Field label={d.type === "funnel" ? "First step" : "Metric"} hint={metric ? metric.description : undefined}>
                {(p) => (
                  <div className="flex gap-2">
                    <MetricSelect {...p} catalog={catalog.data} value={d.metric} allowEmpty onChange={(k) => set({ metric: k })} />
                    <Button variant="secondary" aria-label="New calculated metric" title="New calculated metric" onClick={() => setCalcOpen(true)}><Plus className="size-4" /></Button>
                  </div>
                )}
              </Field>
              {shape.multiMetric && (
                <fieldset className="space-y-2">
                  <legend className="text-[13px] font-medium">{d.type === "funnel" ? "Next steps" : "Extra columns"}</legend>
                  {d.metrics.map((k, i) => (
                    <div key={i} className="flex gap-2">
                      <MetricSelect catalog={catalog.data} value={k} aria-label={`Metric ${i + 2}`} onChange={(v) => set({ metrics: d.metrics.map((x, j) => (j === i ? v : x)) })} />
                      <Button variant="ghost" aria-label="Remove" onClick={() => set({ metrics: d.metrics.filter((_, j) => j !== i) })}><X className="size-4" /></Button>
                    </div>
                  ))}
                  {d.metrics.length < 6 && <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => set({ metrics: [...d.metrics, d.metric] })}>Add {d.type === "funnel" ? "step" : "column"}</Button>}
                </fieldset>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {shape.dimension !== "none" && (
                  <Field label="Break down by" hint={!dims.length && d.metric ? "This metric has no breakdowns." : undefined}>
                    {(p) => (
                      <Select {...p} value={d.dimension} onChange={(e) => set({ dimension: e.target.value })} disabled={d.type === "geo"}>
                        {shape.dimension === "optional" && <option value="">Over time</option>}
                        {dims.map((x) => <option key={x} value={x}>{DIMENSIONS[x as keyof typeof DIMENSIONS]}</option>)}
                      </Select>
                    )}
                  </Field>
                )}
                {(shape.series || (d.type === "bar" && !d.dimension)) && (
                  <Field label="Interval">{(p) => (
                    <Select {...p} value={d.granularity === "none" ? "day" : d.granularity} onChange={(e) => set({ granularity: e.target.value as Draft["granularity"] })}>
                      <option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option>
                    </Select>
                  )}</Field>
                )}
                {d.dimension && <Field label="Show top">{(p) => <Select {...p} value={d.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>{[5, 10, 15, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>}
              </div>
              <Field label="Date range">{(p) => <DateRangeSelect id={p.id} value={d.dateRange} inherit onChange={(v) => set({ dateRange: v })} />}</Field>
              <Field label="Compare to">{(p) => (
                <Select {...p} value={d.comparison} onChange={(e) => set({ comparison: e.target.value as Draft["comparison"] })}>
                  <option value="previous_period">Previous period</option><option value="previous_year">Same period last year</option><option value="none">No comparison</option>
                </Select>
              )}</Field>
              {d.dimension && (
                <fieldset className="grid gap-2 sm:grid-cols-[120px_1fr]">
                  <legend className="mb-1 text-[13px] font-medium">Filter {DIMENSIONS[d.dimension as keyof typeof DIMENSIONS]?.toLowerCase()} <span className="font-normal text-subtle">(optional)</span></legend>
                  <Select aria-label="Filter operator" value={d.filterOp} onChange={(e) => set({ filterOp: e.target.value as "in" | "not_in" })}><option value="in">Only</option><option value="not_in">Exclude</option></Select>
                  <Input aria-label="Filter values" placeholder="Comma-separated values" value={d.filterValues} onChange={(e) => set({ filterValues: e.target.value })} />
                </fieldset>
              )}
              {["kpi", "line", "area", "bar"].includes(d.type) && (
                <fieldset className="grid gap-2 sm:grid-cols-3">
                  <legend className="mb-1 text-[13px] font-medium">Target <span className="font-normal text-subtle">(optional)</span></legend>
                  <Input aria-label="Target value" inputMode="decimal" placeholder="Value" value={d.targetValue} onChange={(e) => set({ targetValue: e.target.value.replace(/[^0-9.-]/g, "") })} />
                  <Select aria-label="Target applies per" value={d.targetPeriod} onChange={(e) => set({ targetPeriod: e.target.value as Draft["targetPeriod"] })}>
                    <option value="range">Whole range</option><option value="day">Per day</option><option value="week">Per week</option><option value="month">Per month</option>
                  </Select>
                  <Input aria-label="Target label" placeholder="Label (e.g. Monthly target)" value={d.targetLabel} onChange={(e) => set({ targetLabel: e.target.value })} />
                </fieldset>
              )}
              <Field label="Refresh">{(p) => (
                <div className="flex gap-2">
                  <Select {...p} value={d.refreshMode} onChange={(e) => set({ refreshMode: e.target.value as Draft["refreshMode"] })}>
                    <option value="on_new_data">When new data is synced</option><option value="interval">On a schedule</option><option value="manual">Only when opened</option>
                  </Select>
                  {d.refreshMode === "interval" && (
                    <Select aria-label="Refresh interval" value={d.refreshSec} onChange={(e) => set({ refreshSec: Number(e.target.value) })}>
                      {[300, 900, 3600, 21600].map((s) => <option key={s} value={s}>{s < 3600 ? `${s / 60} min` : `${s / 3600} h`}</option>)}
                    </Select>
                  )}
                </div>
              )}</Field>
            </>
          )}
          {error && <p role="alert" className="text-sm text-warning">{error}</p>}
        </div>

        <div className="lg:sticky lg:top-0">
          <p className="mb-2 text-[13px] font-medium">Preview</p>
          <div style={{ height: Math.max(180, (parsed.success ? parsed.data.layout.h : 6) * 36) }} className="max-h-[420px]">
            {parsed.success ? (
              <Widget widget={parsed.data} businessId={businessId} timezone={timezone} dashboardRange={dashboardRange} />
            ) : (
              <div className="grid h-full place-items-center rounded-xl border border-dashed border-line-strong text-sm text-subtle">Complete the settings to preview</div>
            )}
          </div>
        </div>
      </div>
      <CalculatedMetricDialog open={calcOpen} onClose={() => setCalcOpen(false)} businessId={businessId} onCreated={(key) => set({ metric: key })} />
    </Dialog>
  );
}
