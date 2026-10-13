import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, ArrowRight, Bot, Check, ChevronDown, ClipboardList, EyeOff, Info, LayoutDashboard, Sparkles, TrendingUp } from "lucide-react";
import { DIMENSIONS, SEVERITY_LABEL, can, formatMetricValue, type Business, type Insight, type InsightSeverity, type MetricUnit } from "@bca/shared";
import { cn } from "@/lib/cn";
import { errorMessage, patch, post } from "@/lib/api";
import { Badge, DemoBadge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { EvidenceCard } from "@/components/assistant/Evidence";
import { relativeTime } from "@/components/widgets/WidgetFrame";

export const SEVERITY_STYLE: Record<InsightSeverity, { tone: "danger" | "warning" | "accent" | "success"; icon: typeof Info; ring: string }> = {
  critical: { tone: "danger", icon: AlertOctagon, ring: "border-danger/40" },
  warning: { tone: "warning", icon: AlertTriangle, ring: "border-warning/35" },
  info: { tone: "accent", icon: Info, ring: "border-line" },
  positive: { tone: "success", icon: TrendingUp, ring: "border-success/35" },
};

const fmtRange = (r: { from: string; to: string } | null) => (r ? (r.from === r.to ? r.from : `${r.from} – ${r.to}`) : null);

/** An insight: finding, evidence, period, severity, impact, next step, dashboard link — plus an optional, labelled AI explanation. */
export function InsightCard({ business, insight: i, compact }: { business: Business; insight: Insight; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can(business.role, "insight.manage");
  const s = SEVERITY_STYLE[i.severity];
  const Icon = s.icon;
  const refresh = () => qc.invalidateQueries({ queryKey: ["b", business.id, "insights"] });
  const setStatus = useMutation({ mutationFn: (status: Insight["status"]) => patch(`/businesses/${business.id}/insights/${i.id}`, { status }), onSuccess: refresh, onError: (e) => toast(errorMessage(e), "error") });
  const task = useMutation({
    mutationFn: () => post(`/businesses/${business.id}/tasks`, { title: i.title, description: [i.finding, i.nextStep && `Next step: ${i.nextStep}`].filter(Boolean).join("\n\n"), insightId: i.id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["b", business.id, "tasks"] }); toast("Task created", "success"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const explain = useMutation({ mutationFn: () => post(`/businesses/${business.id}/insights/${i.id}/explain`), onSuccess: () => { refresh(); toast("Explanation requested"); }, onError: (e) => toast(errorMessage(e), "error") });
  const metricEvidence = i.evidence.find((e) => e.kind === "metric");
  const unit = metricEvidence?.kind === "metric" ? (metricEvidence.metric.unit as MetricUnit) : "number";
  const currency = metricEvidence?.kind === "metric" ? metricEvidence.currency : business.currency;
  const ask = `/app/b/${business.id}/assistant?q=${encodeURIComponent(`Help me understand this: ${i.title}. What's driving it?`)}`;

  return (
    <article className={cn("panel border p-4", s.ring, i.status !== "open" && "opacity-80")} aria-labelledby={`ins-${i.id}`}>
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg", { danger: "bg-danger/15 text-danger", warning: "bg-warning/15 text-warning", accent: "bg-accent/15 text-accent", success: "bg-success/15 text-success" }[s.tone])}><Icon className="size-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.tone}>{SEVERITY_LABEL[i.severity]}</Badge>
            {i.isDemo && <DemoBadge />}
            {i.status !== "open" && <Badge>{i.status}</Badge>}
            {i.period && <span className="text-xs text-subtle">{fmtRange(i.period)}{i.comparison ? ` vs ${fmtRange(i.comparison)}` : ""}</span>}
          </div>
          <h3 id={`ins-${i.id}`} className="mt-1.5 text-[15px] font-semibold text-fg">{i.title}</h3>
          <p className="mt-1 text-sm text-muted">{i.finding}</p>
        </div>
        {compact && <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Hide details" : "Show details"} className="rounded-md p-1 text-subtle hover:text-fg"><ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} /></button>}
      </div>

      {open && (
        <div className="mt-3 space-y-3 pl-11">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[120px_minmax(0,1fr)]">
            {i.impact && <><dt className="text-subtle">Possible impact</dt><dd className="text-[#dbe4ef]">{i.impact}</dd></>}
            {i.nextStep && <><dt className="text-subtle">Suggested next step</dt><dd className="text-[#dbe4ef]">{i.nextStep}</dd></>}
            {i.drivers.length > 0 && (
              <><dt className="text-subtle">Largest contributors</dt>
                <dd><ul className="space-y-0.5">{i.drivers.map((d) => <li key={d.label} className="tabular-nums text-[#dbe4ef]">{d.label} <span className="text-subtle">({DIMENSIONS[d.dimension as keyof typeof DIMENSIONS]?.toLowerCase() ?? d.dimension})</span>: {d.delta > 0 ? "+" : "−"}{formatMetricValue(Math.abs(d.delta), unit, currency)} <span className="text-subtle">({formatMetricValue(d.previous, unit, currency)} → {formatMetricValue(d.current, unit, currency)})</span></li>)}</ul></dd></>
            )}
          </dl>
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-subtle">Evidence</p>
            {i.evidence.map((e) => <EvidenceCard key={e.id} evidence={e} />)}
          </div>
          {i.explanationStatus === "ready" && i.explanation ? (
            <div className="rounded-xl border border-violet/30 bg-violet/[0.05] p-3 text-sm">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[#c4b5fd]"><Sparkles className="size-3.5" />AI explanation · possible causes, not verified</p>
              <p className="whitespace-pre-wrap text-[#dbe4ef]">{i.explanation}</p>
            </div>
          ) : i.explanationStatus === "pending" ? (
            <p className="text-xs text-subtle">Writing an AI explanation…</p>
          ) : i.explanationStatus === "failed" ? (
            <p className="text-xs text-warning">The AI explanation couldn't be written. {manage && <button className="underline" onClick={() => explain.mutate()}>Try again</button>}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {i.dashboardId ? <ButtonLink size="sm" variant="secondary" to={`/app/b/${business.id}/dashboards/${i.dashboardId}`} icon={<LayoutDashboard className="size-4" />}>Open dashboard</ButtonLink>
              : i.metricKey && <ButtonLink size="sm" variant="secondary" to={`/app/b/${business.id}/dashboards`} icon={<LayoutDashboard className="size-4" />} title="No dashboard shows this metric yet">Dashboards</ButtonLink>}
            {i.rule === "data_health" && <ButtonLink size="sm" variant="secondary" to={`/app/b/${business.id}/connections`} icon={<ArrowRight className="size-4" />}>Open Connections</ButtonLink>}
            <ButtonLink size="sm" variant="ghost" to={ask} icon={<Bot className="size-4" />}>Ask the assistant</ButtonLink>
            {manage && i.explanationStatus !== "ready" && i.explanationStatus !== "pending" && i.rule !== "data_health" && (
              <Button size="sm" variant="ghost" icon={<Sparkles className="size-4" />} loading={explain.isPending} onClick={() => explain.mutate()}>Explain with AI</Button>
            )}
            {manage && <Button size="sm" variant="ghost" icon={<ClipboardList className="size-4" />} loading={task.isPending} onClick={() => task.mutate()}>Create task</Button>}
            {manage && i.status === "open" && (
              <>
                <Button size="sm" variant="ghost" icon={<Check className="size-4" />} onClick={() => setStatus.mutate("acknowledged")}>Acknowledge</Button>
                <Button size="sm" variant="ghost" icon={<EyeOff className="size-4" />} onClick={() => setStatus.mutate("dismissed")}>Dismiss</Button>
              </>
            )}
            {manage && i.status !== "open" && <Button size="sm" variant="ghost" onClick={() => setStatus.mutate("open")}>Reopen</Button>}
          </div>
          <p className="text-[11px] text-subtle">Detected {relativeTime(i.detectedAt)}{i.updatedAt !== i.detectedAt ? ` · updated ${relativeTime(i.updatedAt)}` : ""}{i.statusBy ? ` · ${i.status} by ${i.statusBy}` : ""}. Figures come from deterministic rules over your connected data.</p>
        </div>
      )}
    </article>
  );
}
