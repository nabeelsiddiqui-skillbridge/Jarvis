import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatBucket, formatMetricValue, type MetricUnit, type QueryResult, type WidgetSpec } from "@bca/shared";
import { cn } from "@/lib/cn";
import { AXIS, COMPARISON, GRID, PRIMARY, SERIES, SURFACE, TARGET, foldOther } from "@/lib/viz";

const fmt = (r: QueryResult, v: number | null | undefined, compact = false) => formatMetricValue(v, r.metric.unit as MetricUnit, r.currency, { compact });

/** Change vs comparison: arrow + signed % + "vs previous period"; never color alone. */
export function Delta({ result, className }: { result: QueryResult; className?: string }) {
  if (result.change == null) {
    const why = !result.comparisonRange ? "" : result.comparisonPartial ? "Prior period incomplete" : result.comparisonTotal === 0 ? "Prior period was 0" : "No comparison data";
    return <span className={cn("text-xs text-subtle", className)}>{why}</span>;
  }
  const up = result.change > 0;
  const flat = Math.abs(result.change) < 0.05;
  const good = flat ? null : up === result.metric.higherIsBetter;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", good == null ? "text-muted" : good ? "text-success" : "text-danger", className)}>
      <Icon className="size-3.5" aria-hidden />
      <span>{up ? "+" : ""}{result.change.toFixed(Math.abs(result.change) < 10 ? 1 : 0)}%</span>
      <span className="font-normal text-subtle">vs prev.</span>
      <span className="sr-only">{good == null ? "unchanged" : good ? "(improvement)" : "(decline)"}</span>
    </span>
  );
}

function ChartTooltip({ active, payload, label, result, granularity }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-[#0b1220]/95 px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium text-fg">{granularity ? formatBucket(label, granularity) : label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-muted">
          <span className="inline-block size-2 rounded-full" style={{ background: p.color }} aria-hidden />
          {p.name}: <span className="font-medium text-fg">{fmt(result, p.value)}</span>
        </p>
      ))}
    </div>
  );
}

const axisProps = { stroke: AXIS, fontSize: 11, tickLine: false, axisLine: false } as const;

// ------------------------------------------------------------------ KPI

export function KpiView({ result, widget }: { result: QueryResult; widget: WidgetSpec }) {
  const target = widget.options.target;
  const pct = target && result.total != null && target.value ? (result.total / target.value) * 100 : null;
  const spark = result.series?.map((p) => ({ v: p.value })) ?? [];
  return (
    <div className="flex h-full flex-col justify-between gap-1">
      <div>
        <p className="font-display text-[28px] font-semibold leading-tight tracking-tight tabular-nums">{fmt(result, result.total)}</p>
        {widget.options.showComparison !== false && <Delta result={result} />}
        {result.comparisonTotal != null && !result.comparisonPartial && widget.options.showComparison !== false && (
          <p className="text-[11px] text-subtle">Previous: {fmt(result, result.comparisonTotal)}</p>
        )}
      </div>
      {pct != null ? (
        <div>
          <div className="flex justify-between text-[11px] text-muted"><span>{target!.label ?? "Target"} {fmt(result, target!.value, true)}</span><span>{pct.toFixed(0)}%</span></div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to target">
            <div className="h-full rounded-full bg-gradient-to-r from-accent to-violet" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        </div>
      ) : spark.length > 2 ? (
        <div className="h-10" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs><linearGradient id={`sp-${widget.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={PRIMARY} stopOpacity={0.35} /><stop offset="1" stopColor={PRIMARY} stopOpacity={0} /></linearGradient></defs>
              <Area type="monotone" dataKey="v" stroke={PRIMARY} strokeWidth={1.5} fill={`url(#sp-${widget.id})`} isAnimationActive={false} connectNulls={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ time series (line / area / bar over time)

export function SeriesView({ result, widget }: { result: QueryResult; widget: WidgetSpec }) {
  const g = widget.query?.granularity === "none" ? "day" : (widget.query?.granularity ?? "day");
  const data = result.series ?? [];
  const showCmp = widget.options.showComparison !== false && data.some((p) => p.comparison != null);
  const target = widget.options.target;
  const targetLine = target && (target.period === g || (target.period === "day" && g === "day")) ? target.value : null;
  const common = { data, margin: { top: 8, right: 8, left: 0, bottom: 0 } };
  const xa = <XAxis dataKey="bucket" {...axisProps} tickFormatter={(b) => formatBucket(b, g)} minTickGap={24} />;
  const ya = <YAxis {...axisProps} width={56} tickFormatter={(v) => fmt(result, v, true)} />;
  const grid = <CartesianGrid stroke={GRID} vertical={false} />;
  const tip = <Tooltip content={<ChartTooltip result={result} granularity={g} />} cursor={{ stroke: "rgb(148 163 184 / 0.4)", fill: "rgb(148 163 184 / 0.06)" }} />;
  const ref = targetLine != null ? <ReferenceLine y={targetLine} stroke={TARGET} strokeDasharray="4 4" label={{ value: target!.label ?? "Target", fill: "#c4b5fd", fontSize: 11, position: "insideTopRight" }} /> : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-display text-xl font-semibold tabular-nums">{fmt(result, result.total)}</span>
        <Delta result={result} />
        {showCmp && (
          <span className="ml-auto flex items-center gap-3 text-[11px] text-muted" aria-label="Legend">
            <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded" style={{ background: PRIMARY }} />This period</span>
            <span className="flex items-center gap-1"><span className="h-0 w-3 border-t border-dashed" style={{ borderColor: COMPARISON }} />Previous</span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {widget.type === "bar" ? (
            <BarChart {...common} barCategoryGap="20%">
              {grid}{xa}{ya}{tip}{ref}
              <Bar dataKey="value" name={result.metric.label} fill={PRIMARY} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              {showCmp && <Bar dataKey="comparison" name="Previous period" fill={COMPARISON} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
            </BarChart>
          ) : widget.type === "line" ? (
            <LineChart {...common}>
              {grid}{xa}{ya}{tip}{ref}
              {showCmp && <Line type="monotone" dataKey="comparison" name="Previous period" stroke={COMPARISON} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
              <Line type="monotone" dataKey="value" name={result.metric.label} stroke={PRIMARY} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
            </LineChart>
          ) : (
            <AreaChart {...common}>
              <defs><linearGradient id={`ar-${widget.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={PRIMARY} stopOpacity={0.3} /><stop offset="1" stopColor={PRIMARY} stopOpacity={0} /></linearGradient></defs>
              {grid}{xa}{ya}{tip}{ref}
              {showCmp && <Line type="monotone" dataKey="comparison" name="Previous period" stroke={COMPARISON} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
              <Area type="monotone" dataKey="value" name={result.metric.label} stroke={PRIMARY} strokeWidth={2} fill={`url(#ar-${widget.id})`} activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ breakdowns

/** Horizontal bars by category (identity is on the axis label, so one hue). */
export function BarsByDimension({ result }: { result: QueryResult }) {
  const rows = result.rows ?? [];
  if (!rows.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barCategoryGap="22%">
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" {...axisProps} tickFormatter={(v) => fmt(result, v, true)} />
        <YAxis type="category" dataKey="label" {...axisProps} width={120} tickFormatter={(l: string) => (l.length > 18 ? `${l.slice(0, 17)}…` : l)} />
        <Tooltip content={<ChartTooltip result={result} />} cursor={{ fill: "rgb(148 163 184 / 0.06)" }} />
        <Bar dataKey="value" name={result.metric.label} fill={PRIMARY} radius={[0, 4, 4, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutView({ result }: { result: QueryResult }) {
  const rows = useMemo(() => foldOther(result.rows ?? []), [result.rows]);
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  if (!rows.length) return <Empty />;
  return (
    <div className="flex h-full items-center gap-4">
      <div className="relative h-full min-h-[120px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="88%" paddingAngle={1.5} stroke={SURFACE} strokeWidth={2} isAnimationActive={false}>
              {rows.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
            </Pie>
            <Tooltip content={<ChartTooltip result={result} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div><p className="font-display text-base font-semibold tabular-nums">{fmt(result, result.total, true)}</p><p className="text-[10px] text-subtle">total</p></div>
        </div>
      </div>
      <ul className="max-w-[45%] space-y-1 text-xs" aria-label="Legend">
        {rows.map((r, i) => (
          <li key={r.label} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i] }} aria-hidden />
            <span className="truncate text-muted">{r.label}</span>
            <span className="ml-auto pl-2 tabular-nums text-fg">{total ? `${(((r.value ?? 0) / total) * 100).toFixed(0)}%` : "—"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TableView({ result, widget, metricLabels }: { result: QueryResult; widget: WidgetSpec; metricLabels: Record<string, { label: string; unit: string }> }) {
  const rows = result.rows ?? [];
  const extras = widget.query?.metrics ?? [];
  if (!rows.length) return <Empty />;
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="sticky top-0 bg-panel text-[11px] uppercase tracking-wide text-subtle">
          <tr>
            <th scope="col" className="py-1.5 pr-3 font-medium">{widget.query?.dimension?.replace("_", " ")}</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">{result.metric.label}</th>
            {extras.map((k) => <th key={k} scope="col" className="py-1.5 pr-3 text-right font-medium">{metricLabels[k]?.label ?? k}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-line/60">
              <th scope="row" className="max-w-[240px] truncate py-1.5 pr-3 font-normal text-fg/90" title={r.label}>{r.label}</th>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(result, r.value)}</td>
              {extras.map((k) => (
                <td key={k} className="py-1.5 pr-3 text-right tabular-nums text-muted">
                  {formatMetricValue(r.extra?.[k] ?? null, (metricLabels[k]?.unit ?? "number") as MetricUnit, result.currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RankingView({ result }: { result: QueryResult }) {
  const rows = result.rows ?? [];
  const max = Math.max(...rows.map((r) => r.value ?? 0), 0);
  if (!rows.length) return <Empty />;
  return (
    <ol className="h-full space-y-2 overflow-auto pr-1">
      {rows.map((r, i) => (
        <li key={r.label} className="text-[13px]">
          <div className="flex items-baseline gap-2">
            <span className="w-5 shrink-0 text-right text-xs text-subtle tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate" title={r.label}>{r.label}</span>
            <span className="tabular-nums">{fmt(result, r.value)}</span>
            {r.share != null && <span className="w-10 text-right text-[11px] text-subtle tabular-nums">{r.share.toFixed(0)}%</span>}
          </div>
          <div className="ml-7 mt-1 h-1 rounded-full bg-white/5"><div className="h-full rounded-full bg-accent/80" style={{ width: `${max ? ((r.value ?? 0) / max) * 100 : 0}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

const FLAGS: Record<string, string> = {
  "United States": "🇺🇸", Canada: "🇨🇦", "United Kingdom": "🇬🇧", Australia: "🇦🇺", Germany: "🇩🇪", France: "🇫🇷", Netherlands: "🇳🇱", India: "🇮🇳", Pakistan: "🇵🇰",
  Spain: "🇪🇸", Italy: "🇮🇹", Brazil: "🇧🇷", Mexico: "🇲🇽", Japan: "🇯🇵", Sweden: "🇸🇪", "United Arab Emirates": "🇦🇪", Ireland: "🇮🇪", "New Zealand": "🇳🇿",
};

export function GeoView({ result }: { result: QueryResult }) {
  const rows = result.rows ?? [];
  if (!rows.length) return <Empty />;
  return (
    <ul className="grid h-full content-start gap-x-6 gap-y-2.5 overflow-auto pr-1 sm:grid-cols-2">
      {rows.map((r) => (
        <li key={r.label} className="text-[13px]">
          <div className="flex items-center gap-2">
            <span aria-hidden className="w-5 text-base leading-none">{FLAGS[r.label] ?? "🌐"}</span>
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="tabular-nums">{fmt(result, r.value, true)}</span>
          </div>
          <div className="ml-7 mt-1 h-1 rounded-full bg-white/5"><div className="h-full rounded-full bg-accent/80" style={{ width: `${r.share ?? 0}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function FunnelView({ result }: { result: QueryResult }) {
  const steps = result.steps ?? [];
  const first = steps[0]?.value ?? null;
  if (!steps.length) return <Empty />;
  return (
    <ol className="flex h-full flex-col justify-center gap-2.5">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1]!.value : null;
        const stepRate = prev && s.value != null ? (s.value / prev) * 100 : null;
        const width = first && s.value != null ? Math.max(2, (s.value / first) * 100) : 0;
        return (
          <li key={s.key}>
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="text-muted">{s.label}</span>
              <span className="tabular-nums">{formatMetricValue(s.value, s.unit as MetricUnit, result.currency)}{stepRate != null && <span className="ml-2 text-[11px] text-subtle">{stepRate.toFixed(1)}% of previous</span>}</span>
            </div>
            <div className="mt-1 h-3 rounded bg-white/5">
              {s.value == null ? <div className="h-full rounded border border-dashed border-line-strong" title="Unavailable" /> : <div className="h-full rounded" style={{ width: `${width}%`, background: SERIES[0], opacity: 1 - i * 0.15 }} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function PipelineView({ result }: { result: QueryResult }) {
  const rows = result.rows ?? [];
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  if (!rows.length) return <Empty />;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex h-7 overflow-hidden rounded-md" role="img" aria-label="Pipeline by stage">
        {rows.map((r, i) => <div key={r.label} title={`${r.label}: ${fmt(result, r.value)}`} style={{ width: `${total ? ((r.value ?? 0) / total) * 100 : 0}%`, background: SERIES[i % SERIES.length] }} className="border-r-2 border-panel last:border-r-0" />)}
      </div>
      <ul className="grid gap-2 text-[13px] sm:grid-cols-2">
        {rows.map((r, i) => (
          <li key={r.label} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-muted">{r.label}</span>
            <span className="tabular-nums">{fmt(result, r.value, true)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Empty({ children = "No rows for this period." }: { children?: string }) {
  return <div className="grid h-full place-items-center text-sm text-subtle">{children}</div>;
}
