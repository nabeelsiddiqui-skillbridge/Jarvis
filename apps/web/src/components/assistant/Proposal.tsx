import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, LayoutDashboard, Undo2, X } from "lucide-react";
import { can, type Business, type ProposalSummary } from "@bca/shared";
import { errorMessage, post } from "@/lib/api";
import { useProposal } from "@/lib/assistant";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/EmptyState";
import { PageLoader } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { Widget } from "@/components/widgets/Widget";

const STATUS: Record<ProposalSummary["status"], { label: string; tone: "accent" | "success" | "neutral" | "warning" }> = {
  pending: { label: "Ready to review", tone: "accent" },
  applied: { label: "Applied", tone: "success" },
  discarded: { label: "Discarded", tone: "neutral" },
  undone: { label: "Undone", tone: "warning" },
};

/** A dashboard the assistant proposed. Nothing is saved until the user applies it; applying can be undone. */
export function ProposalCard({ business, proposal: initial }: { business: Business; proposal: ProposalSummary }) {
  const [p, setP] = useState(initial);
  // Status can change elsewhere (another tab, a refetched conversation).
  useEffect(() => setP(initial), [initial.id, initial.status, initial.appliedVersion]);
  const [preview, setPreview] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const canWrite = can(business.role, "dashboard.write");
  const act = useMutation({
    mutationFn: (action: "apply" | "discard" | "undo") => post<ProposalSummary>(`/businesses/${business.id}/assistant/proposals/${p.id}/${action}`),
    onSuccess: (next, action) => {
      setP(next);
      setPreview(false);
      qc.invalidateQueries({ queryKey: ["b", business.id, "dashboards"] });
      qc.invalidateQueries({ queryKey: ["b", business.id, "assistant", "conversation"] });
      toast(action === "apply" ? (p.kind === "create" ? "Dashboard created" : "Dashboard updated") : action === "undo" ? "Change undone" : "Proposal discarded", action === "apply" ? "success" : "info");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const s = STATUS[p.status];
  return (
    <div className="rounded-xl border border-violet/40 bg-violet/[0.06] p-3">
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet/20 text-[#c4b5fd]"><LayoutDashboard className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-fg">{p.kind === "create" ? "New dashboard" : "Dashboard changes"}: {p.name}</p>
            <Badge tone={s.tone}>{s.label}</Badge>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">{p.summary} · {p.widgetCount} widgets</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Eye className="size-4" />} onClick={() => setPreview(true)}>Preview</Button>
        {p.status === "pending" && (canWrite ? (
          <>
            <Button size="sm" variant="primary" icon={<Check className="size-4" />} loading={act.isPending && act.variables === "apply"} onClick={() => act.mutate("apply")}>{p.kind === "create" ? "Create dashboard" : "Apply changes"}</Button>
            <Button size="sm" variant="ghost" icon={<X className="size-4" />} loading={act.isPending && act.variables === "discard"} onClick={() => act.mutate("discard")}>Discard</Button>
          </>
        ) : <span className="self-center text-xs text-subtle">Only analysts and administrators can apply dashboard changes.</span>)}
        {p.status === "applied" && p.dashboardId && (
          <>
            <ButtonLink size="sm" variant="secondary" to={`/app/b/${business.id}/dashboards/${p.dashboardId}`} icon={<LayoutDashboard className="size-4" />}>Open dashboard</ButtonLink>
            {canWrite && <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} loading={act.isPending} onClick={() => act.mutate("undo")}>Undo</Button>}
          </>
        )}
      </div>
      <PreviewDialog open={preview} onClose={() => setPreview(false)} business={business} proposal={p}
        footer={p.status === "pending" && canWrite ? (
          <>
            <Button variant="ghost" onClick={() => act.mutate("discard")}>Discard</Button>
            <Button variant="primary" loading={act.isPending} onClick={() => act.mutate("apply")}>{p.kind === "create" ? "Create dashboard" : "Apply changes"}</Button>
          </>
        ) : <Button onClick={() => setPreview(false)}>Close</Button>} />
    </div>
  );
}

function PreviewDialog({ open, onClose, business, proposal, footer }: { open: boolean; onClose: () => void; business: Business; proposal: ProposalSummary; footer: React.ReactNode }) {
  const q = useProposal(business.id, open ? proposal.id : null);
  return (
    <Dialog open={open} onClose={onClose} size="xl" title={`Preview: ${proposal.name}`} description={proposal.kind === "edit" ? "This is how the dashboard will look after the change. Live data, nothing saved yet." : "Live data, nothing saved yet."} footer={footer}>
      {q.isLoading ? <PageLoader label="Loading preview…" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:[grid-auto-rows:30px]">
          {q.data.spec.widgets.map((w) => (
            <div key={w.id} className="min-h-[200px] md:min-h-0 md:[grid-column:var(--gc)] md:[grid-row:var(--gr)]" style={{ "--gc": `${w.layout.x + 1} / span ${w.layout.w}`, "--gr": `${w.layout.y + 1} / span ${w.layout.h}` } as React.CSSProperties}>
              <Widget widget={w} businessId={business.id} timezone={business.timezone} dashboardRange={q.data!.spec.dateRange} />
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
