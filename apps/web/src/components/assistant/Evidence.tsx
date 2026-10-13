import { AlertTriangle, Database, Info } from "lucide-react";
import { PROVIDERS, formatMetricValue, type Evidence, type MetricEvidence, type MetricUnit } from "@bca/shared";
import { cn } from "@/lib/cn";
import { Badge, DemoBadge } from "@/components/ui/Badge";
import { relativeTime } from "@/components/widgets/WidgetFrame";

const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const range = (r: { from: string; to: string } | null) => (r ? (r.from === r.to ? fmtDate(r.from) : `${fmtDate(r.from)} – ${fmtDate(r.to)}`) : null);

/** Inline citation chip, e.g. [E2]. */
export function CitationChip({ id, active, onClick, missing }: { id: string; active?: boolean; onClick: () => void; missing?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={active} aria-label={missing ? `Evidence ${id} (not found)` : `Show evidence ${id}`}
      className={cn("mx-0.5 inline-flex h-[18px] items-center rounded-md border px-1.5 align-[1px] text-[11px] font-semibold tabular-nums transition-colors",
        missing ? "border-warning/40 text-warning" : active ? "border-accent bg-accent/20 text-accent" : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20")}>
      {id}
    </button>
  );
}

export function EvidenceCard({ evidence, highlighted }: { evidence: Evidence; highlighted?: boolean }) {
  return (
    <div id={`evidence-${evidence.id}`} className={cn("rounded-xl border bg-panel p-3 text-[13px] transition-shadow", highlighted ? "border-accent/60 shadow-[0_0_0_3px_rgb(34_211_238/0.15)]" : "border-line")}>
      {evidence.kind === "metric" ? <MetricBody e={evidence} /> : (
        <>
          <Header id={evidence.id} title={evidence.question} />
          {evidence.connections.length ? (
            <ul className="mt-2 space-y-1.5">
              {evidence.connections.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium text-fg">{c.provider}</span><span className="text-muted">{c.name}</span>
                  <Badge tone={c.status === "active" && !c.stale ? "success" : c.status === "active" ? "warning" : "danger"}>{c.stale && c.status === "active" ? "Stale" : c.status.replace(/_/g, " ")}</Badge>
                  {c.isDemo && <DemoBadge />}
                  <span className="w-full text-xs text-subtle">Last sync {c.lastSuccessAt ? relativeTime(c.lastSuccessAt) : "never"}{c.latestDataDate ? ` · data through ${fmtDate(c.latestDataDate)}` : ""}{c.lastError ? ` · ${c.lastError}` : ""}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-muted">No data sources are connected.</p>}
        </>
      )}
    </div>
  );
}

function Header({ id, title, extra }: { id: string; title: string; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <span className="mt-px shrink-0 rounded-md border border-accent/40 bg-accent/10 px-1.5 text-[11px] font-semibold text-accent">{id}</span>
        <span className="min-w-[8rem] font-medium text-fg">{title}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">{extra}</div>
    </div>
  );
}

function MetricBody({ e }: { e: MetricEvidence }) {
  const unit = e.metric.unit as MetricUnit;
  const fmt = (v: number | null) => formatMetricValue(v, unit, e.currency);
  const tone = e.availability === "available" ? "success" : e.availability === "partial" ? "warning" : "danger";
  return (
    <>
      <Header id={e.id} title={e.question} extra={<>{e.isDemo && <DemoBadge />}<Badge tone={tone}>{e.availability === "available" ? "Complete" : e.availability === "partial" ? "Partial data" : "Unavailable"}</Badge></>} />
      {e.availability === "unavailable" ? (
        <p className="mt-2 text-muted">{e.unavailableReason ?? "No data for this period."}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {e.total != null && !e.rows && <span className="font-display text-lg font-semibold tabular-nums text-fg">{fmt(e.total)}</span>}
          {e.change != null && <span className="text-xs text-muted">{e.change >= 0 ? "+" : ""}{(Math.round(e.change * 10) / 10).toFixed(1)}% vs {fmt(e.comparisonTotal)}</span>}
          {e.comparisonPartial && <span className="text-xs text-warning">Comparison period incomplete — no % change</span>}
        </div>
      )}
      <dl className="mt-2 grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs [&_dd]:text-muted [&_dt]:text-subtle">
        <dt>Period</dt><dd>{range(e.range)} <span className="text-subtle">({e.timezone})</span></dd>
        {e.comparisonRange && <><dt>Compared with</dt><dd>{range(e.comparisonRange)}</dd></>}
        <dt>Definition</dt><dd>{e.metric.description}{e.metric.formula ? <span className="block text-subtle">Formula: {e.metric.formula}</span> : null}</dd>
      </dl>
      {e.rows && e.rows.length > 0 && (
        <table className="mt-2 w-full text-xs tabular-nums">
          <tbody>
            {e.rows.slice(0, 8).map((r, i) => (
              <tr key={i} className="border-t border-line/60"><td className="max-w-0 truncate py-1 pr-2 text-muted" title={r.label}>{r.label}</td><td className="py-1 text-right text-fg">{fmt(r.value)}</td><td className="w-12 py-1 text-right text-subtle">{r.share != null ? `${r.share.toFixed(0)}%` : ""}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-2 space-y-1 border-t border-line/60 pt-2 text-xs">
        {e.sources.length ? e.sources.map((s, i) => (
          <p key={i} className="flex flex-wrap items-center gap-x-1.5 text-subtle">
            <Database className="size-3.5" aria-hidden />
            <span className="text-muted">{PROVIDERS[s.provider as keyof typeof PROVIDERS] ?? s.provider} · {s.assetName ?? s.accountName}</span>
            <span>· synced {s.lastSyncedAt ? relativeTime(s.lastSyncedAt) : "never"}{s.latestDataDate ? `, data through ${fmtDate(s.latestDataDate)}` : ""}</span>
            {s.stale && <span className="text-warning">· stale</span>}
            {s.reportingDelay && <span className="w-full pl-5">{s.reportingDelay}</span>}
          </p>
        )) : <p className="text-subtle">No source data.</p>}
        {e.limitations.map((l, i) => (
          <p key={i} className="flex gap-1.5 text-warning/90"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{l}</p>
        ))}
      </div>
    </>
  );
}

export function EvidenceNote() {
  return <p className="flex items-center gap-1.5 text-[11px] text-subtle"><Info className="size-3" aria-hidden />Evidence is the exact data the assistant was given, not its own wording.</p>;
}
