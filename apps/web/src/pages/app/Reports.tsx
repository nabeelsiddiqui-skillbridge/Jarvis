import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FileText, Plus, Printer, Sparkles, Trash2 } from "lucide-react";
import { SEVERITY_LABEL, addDays, can, formatMetricValue, todayIn, type MetricUnit, type Report, type ReportSummary } from "@bca/shared";
import { del, errorMessage, post } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { k, useReport, useReports } from "@/lib/insights";
import { Badge, DemoBadge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState } from "@/components/ui/EmptyState";
import { Field, Input, Select } from "@/components/ui/Field";
import { PageLoader, Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/components/widgets/WidgetFrame";
import { CitationChip, EvidenceCard } from "@/components/assistant/Evidence";
import { Markdown } from "@/components/assistant/Markdown";
import { SEVERITY_STYLE } from "@/components/insights/InsightCard";

const KIND_LABEL: Record<ReportSummary["kind"], string> = { daily_briefing: "Daily briefing", weekly_report: "Weekly report", custom: "Custom report" };

export function Reports() {
  const b = useBusiness();
  const list = useReports(b.id);
  const [kind, setKind] = useState<"all" | ReportSummary["kind"]>("all");
  const [creating, setCreating] = useState(false);
  const rows = (list.data ?? []).filter((r) => kind === "all" || r.kind === kind);
  return (
    <>
      <PageHeader title="Reports" description={`Briefings and reports for ${b.name}. Figures come from connected data with sources; the AI summary only restates them.`}
        actions={<>
          <ButtonLink to={`/app/b/${b.id}/automations`} variant="ghost">Schedule…</ButtonLink>
          {can(b.role, "report.write") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Generate report</Button>}
        </>} />
      <div className="mb-4 flex flex-wrap gap-2">
        {(["all", "daily_briefing", "weekly_report", "custom"] as const).map((x) => (
          <button key={x} type="button" onClick={() => setKind(x)} aria-pressed={kind === x} className={`rounded-full border px-3 py-1 text-[13px] ${kind === x ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg"}`}>{x === "all" ? "All" : KIND_LABEL[x]}</button>
        ))}
      </div>
      {list.isLoading ? <Skeleton className="h-48" /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? (
        <EmptyState icon={<FileText className="size-5" />} title="No reports yet"
          action={can(b.role, "report.write") ? <Button variant="primary" onClick={() => setCreating(true)}>Generate a report</Button> : undefined}>
          Generate one now, or set up a daily briefing or weekly report in Automations to have them created on a schedule.
        </EmptyState>
      ) : (
        <ul className="panel divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to={r.id} className="flex flex-wrap items-center gap-3 p-4 hover:bg-white/[0.02]">
                <FileText className="size-4 shrink-0 text-accent" />
                <span className="min-w-0 flex-1"><span className="block font-medium">{r.title}</span><span className="text-xs text-subtle">{KIND_LABEL[r.kind]} · {r.createdBy ?? "—"} · {relativeTime(r.createdAt)}</span></span>
                {r.isDemo && <DemoBadge />}
                {r.narrativeStatus === "ready" && <Badge tone="violet" icon={<Sparkles className="size-3" />}>AI summary</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <GenerateDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function GenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const b = useBusiness();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const y = addDays(todayIn(b.timezone), -1);
  const [kind, setKind] = useState<ReportSummary["kind"]>("weekly_report");
  const [from, setFrom] = useState(addDays(y, -27));
  const [to, setTo] = useState(y);
  const gen = useMutation({
    mutationFn: () => post<{ id: string }>(`/businesses/${b.id}/reports`, kind === "custom" ? { kind, period: { from, to } } : { kind }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: k.reports(b.id) }); onClose(); nav(`/app/b/${b.id}/reports/${r.id}`); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Generate a report" description="Built now from the latest synced data."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={gen.isPending} onClick={() => gen.mutate()}>{gen.isPending ? "Building…" : "Generate"}</Button></>}>
      <div className="space-y-4">
        <Field label="Report">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="daily_briefing">Daily briefing (yesterday)</option><option value="weekly_report">Weekly report (last 7 days)</option><option value="custom">Custom period</option></Select>}</Field>
        {kind === "custom" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From">{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="To">{(p) => <Input {...p} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
        )}
        <p className="text-xs text-subtle">Each figure is compared with the preceding period of the same length. Incomplete comparisons show no % change.</p>
      </div>
    </Dialog>
  );
}

export function ReportView() {
  const b = useBusiness();
  const { reportId } = useParams();
  const r = useReport(b.id, reportId!);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const remove = useMutation({ mutationFn: () => del(`/businesses/${b.id}/reports/${reportId}`), onSuccess: () => { qc.invalidateQueries({ queryKey: k.reports(b.id) }); nav(`/app/b/${b.id}/reports`); toast("Report deleted"); }, onError: (e) => toast(errorMessage(e), "error") });
  if (r.isLoading) return <PageLoader />;
  if (r.error || !r.data) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  return <ReportBody report={r.data} actions={
    <div className="flex flex-wrap gap-2 print:hidden">
      <ButtonLink to={`/app/b/${b.id}/reports`} variant="ghost" icon={<ArrowLeft className="size-4" />}>Reports</ButtonLink>
      <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()}>Print / PDF</Button>
      {can(b.role, "data.export") && <a className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-raised px-4 text-sm font-medium hover:border-line-strong" href={`/api/businesses/${b.id}/reports/${reportId}/export.csv`} download><Download className="size-4" />Export CSV</a>}
      {can(b.role, "report.write") && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => { if (confirm("Delete this report?")) remove.mutate(); }}>Delete</Button>}
    </div>} />;
}

export function ReportBody({ report: r, actions }: { report: Report; actions?: React.ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const evidence = new Map(r.content.headline.map((e) => [e.id, e]));
  const cite = (id: string, key: string) => <CitationChip key={key} id={id} active={open === id} missing={!evidence.has(id)} onClick={() => setOpen(open === id ? null : id)} />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-accent/80">{KIND_LABEL[r.kind]}</p>
          <h1 className="text-2xl font-semibold">{r.title}</h1>
          <p className="mt-1 text-sm text-muted">Period {r.period.from === r.period.to ? r.period.from : `${r.period.from} – ${r.period.to}`}{r.comparison ? ` · compared with ${r.comparison.from === r.comparison.to ? r.comparison.from : `${r.comparison.from} – ${r.comparison.to}`}` : ""} · created {new Date(r.createdAt).toLocaleString()}</p>
          {r.isDemo && <p className="mt-2"><DemoBadge /> <span className="text-xs text-muted">Sample data from the demo business.</span></p>}
        </div>
        {actions}
      </div>

      {r.narrative ? (
        <Card title="Summary" description="Written by AI from the figures below — check the evidence before acting." actions={<Badge tone="violet" icon={<Sparkles className="size-3" />}>AI</Badge>}>
          <div className="text-sm leading-relaxed text-[#dbe4ef]"><Markdown text={r.narrative} renderCitation={cite} /></div>
          {open && evidence.get(open) && <div className="mt-3"><EvidenceCard evidence={evidence.get(open)!} highlighted /></div>}
        </Card>
      ) : (
        <Card title="Summary">
          <ul className="space-y-1.5 text-sm">{r.content.deterministicSummary.map((l, i) => <li key={i}><Markdown text={l} renderCitation={cite} /></li>)}</ul>
          {open && evidence.get(open) && <div className="mt-3"><EvidenceCard evidence={evidence.get(open)!} highlighted /></div>}
          <p className="mt-3 text-xs text-subtle">{r.narrativeStatus === "failed" ? "The AI summary couldn't be written for this report; the figures are complete." : r.narrativeStatus === "unavailable" ? "AI summaries are off (no AI provider key configured)." : ""}</p>
        </Card>
      )}

      <section aria-labelledby="figures-h">
        <h2 id="figures-h" className="mb-3 text-[15px] font-semibold">Figures</h2>
        {r.content.headline.length ? (
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">{r.content.headline.map((e) => <EvidenceCard key={e.id} evidence={e} highlighted={open === e.id} />)}</div>
        ) : <p className="text-sm text-muted">No connected data for this business yet.</p>}
      </section>

      {r.content.movers.length > 0 && (
        <Card title="Biggest movers" description={`vs ${r.content.comparisonLabel}`}>
          <ul className="space-y-1 text-sm">{r.content.movers.map((m) => <li key={m.metric}>{m.label}: <b className={m.change >= 0 ? "text-success" : "text-danger"}>{m.change >= 0 ? "+" : "−"}{Math.abs(m.change).toFixed(1)}%</b> {cite(m.evidenceId, m.metric)}</li>)}</ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Open insights">
          {r.content.insights.length ? (
            <ul className="space-y-2 text-sm">{r.content.insights.map((i) => <li key={i.id} className="flex gap-2"><Badge tone={SEVERITY_STYLE[i.severity].tone}>{SEVERITY_LABEL[i.severity]}</Badge><span><b className="font-medium">{i.title}</b><span className="block text-muted">{i.finding}</span></span></li>)}</ul>
          ) : <p className="text-sm text-muted">No open insights when this report was created.</p>}
        </Card>
        <Card title="Goals and data health">
          {r.content.goals.length > 0 && (
            <ul className="mb-3 space-y-1 text-sm">{r.content.goals.map((g) => <li key={g.title}>{g.title}: {g.value == null ? <span className="text-subtle">not trackable</span> : <>{formatMetricValue(g.value, (g.unit ?? "number") as MetricUnit, g.currency ?? undefined)} of {formatMetricValue(g.target, (g.unit ?? "number") as MetricUnit, g.currency ?? undefined)}{g.pacePct != null && <span className="text-subtle"> ({g.pacePct.toFixed(0)}% of target so far)</span>}</>}</li>)}</ul>
          )}
          <ul className="space-y-1 text-sm">{r.content.dataHealth.map((d, i) => <li key={i} className="flex items-center gap-2"><span className={`size-2 rounded-full ${d.stale || d.status !== "active" ? "bg-warning" : "bg-success"}`} />{d.provider} · {d.name}<span className="text-subtle">{d.stale ? "stale" : d.status !== "active" ? d.status.replace(/_/g, " ") : d.lastSuccessAt ? `synced ${relativeTime(d.lastSuccessAt)}` : ""}</span></li>)}</ul>
          {!r.content.dataHealth.length && <p className="text-sm text-muted">No data sources connected.</p>}
        </Card>
      </div>
      {r.content.limitations.length > 0 && (
        <Card title="Limitations"><ul className="list-disc space-y-1 pl-5 text-sm text-muted">{r.content.limitations.map((l) => <li key={l}>{l}</li>)}</ul></Card>
      )}
    </div>
  );
}
