import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Clock, ShieldCheck, X, Zap } from "lucide-react";
import { ACTION_STATUS_LABEL, can, type ActionProposal, type Business } from "@bca/shared";
import { cn } from "@/lib/cn";
import { errorMessage, post } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/components/widgets/WidgetFrame";

const STATUS_TONE: Record<ActionProposal["status"], "neutral" | "accent" | "success" | "danger" | "warning" | "violet"> = {
  pending_approval: "violet", approved: "accent", executing: "accent", needs_check: "warning", succeeded: "success", failed: "danger", rejected: "neutral", expired: "neutral", superseded: "neutral", cancelled: "neutral",
};
const RISK_TONE = { low: "neutral", medium: "warning", high: "danger" } as const;

/**
 * Review card for an external action: business, account, affected record, current →
 * proposed values, expected effect and who must approve — shown before anything runs.
 */
export function ActionCard({ business, action: a, me, compact }: { business: Business; action: ActionProposal; me: string; compact?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(!compact);
  const [comment, setComment] = useState("");
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => { qc.invalidateQueries({ queryKey: ["b", business.id, "actions"] }); qc.invalidateQueries({ queryKey: ["b", business.id, "assistant", "conversation"] }); };
  const decide = useMutation({
    mutationFn: (d: "approve" | "reject") => post(`/businesses/${business.id}/actions/${a.id}/${d}`, { payloadHash: a.payloadHash, comment: comment || undefined }),
    onSuccess: (_r, d) => { setConfirm(false); refresh(); toast(d === "approve" ? "Approved — the change runs in the background" : "Rejected — nothing will change", d === "approve" ? "success" : "info"); },
    onError: (e) => { toast(errorMessage(e), "error"); refresh(); },
  });
  const cancel = useMutation({ mutationFn: () => post(`/businesses/${business.id}/actions/${a.id}/cancel`), onSuccess: () => { refresh(); toast("Proposal cancelled"); }, onError: (e) => toast(errorMessage(e), "error") });
  const canApprove = can(business.role, "action.approve");
  const selfBlocked = a.risk === "high" && a.proposedById === me;
  const pending = a.status === "pending_approval";

  return (
    <article className={cn("rounded-xl border p-4", pending ? "border-violet/40 bg-violet/[0.05]" : "border-line bg-panel")} aria-labelledby={`act-${a.id}`}>
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet/15 text-[#c4b5fd]"><Zap className="size-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[a.status]}>{ACTION_STATUS_LABEL[a.status]}</Badge>
            <Badge tone={RISK_TONE[a.risk]}>{a.risk} risk</Badge>
            {a.source === "assistant" && <Badge>Proposed by the assistant</Badge>}
          </div>
          <h3 id={`act-${a.id}`} className="mt-1.5 font-semibold text-fg">{a.actionLabel}: {a.target.name}</h3>
          <p className="text-xs text-subtle">{a.businessName} · {a.providerName} · {a.connectionName}{a.assetName ? ` · ${a.assetName}` : ""}</p>
        </div>
        {compact && <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Hide details" : "Show details"} className="rounded-md p-1 text-subtle hover:text-fg"><ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} /></button>}
      </div>

      <div className="mt-3 space-y-3 sm:pl-11">
        <ul className="space-y-1.5">
          {a.changes.map((c) => (
            <li key={c.label} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-28 shrink-0 text-subtle">{c.label}</span>
              <span className="rounded-md bg-white/[0.04] px-2 py-0.5 text-muted line-through decoration-white/30">{c.current}</span>
              <ArrowRight className="size-4 text-subtle" aria-label="to" />
              <span className="rounded-md bg-accent/10 px-2 py-0.5 font-medium text-fg">{c.proposed}</span>
            </li>
          ))}
        </ul>
        {open && (
          <>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[120px_minmax(0,1fr)]">
              <dt className="text-subtle">Expected effect</dt><dd className="text-[#dbe4ef]">{a.expectedEffect}</dd>
              <dt className="text-subtle">Approval</dt><dd className="flex items-start gap-1.5 text-[#dbe4ef]"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />{a.approvalRequirement}</dd>
              <dt className="text-subtle">Proposed</dt><dd className="text-muted">{a.proposedBy ?? "—"} · {relativeTime(a.createdAt)}{pending ? ` · expires ${new Date(a.expiresAt).toLocaleString()}` : ""}</dd>
              {a.decidedBy && <><dt className="text-subtle">{a.decision === "rejected" ? "Rejected" : "Approved"}</dt><dd className="text-muted">{a.decidedBy}{a.decidedAt ? ` · ${relativeTime(a.decidedAt)}` : ""}{a.comment ? ` — “${a.comment}”` : ""}</dd></>}
              {a.executedAt && <><dt className="text-subtle">Executed</dt><dd className="text-muted">{new Date(a.executedAt).toLocaleString()}</dd></>}
            </dl>
            {a.error && <p className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#fecaca]"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{a.error}</p>}
            {a.attempts.length > 0 && (
              <details className="text-xs text-subtle">
                <summary className="cursor-pointer select-none">Execution log ({a.attempts.length})</summary>
                <ol className="mt-2 space-y-1">
                  {a.attempts.map((t, i) => (
                    <li key={i} className="flex gap-2"><Clock className="mt-0.5 size-3 shrink-0" /><span>{new Date(t.createdAt).toLocaleTimeString()} · attempt {t.attempt} · {t.kind === "status_check" ? "checked current value" : "sent change"} → <b className="font-medium text-muted">{t.outcome.replace(/_/g, " ")}</b></span></li>
                  ))}
                </ol>
                {a.providerResponse != null && <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-black/30 p-2 text-[11px]">{JSON.stringify(a.providerResponse, null, 2)}</pre>}
              </details>
            )}
            <p className="font-mono text-[10px] text-subtle" title="Approval is bound to this fingerprint of the exact change">Fingerprint {a.payloadHash.slice(0, 16)}…</p>
          </>
        )}
        {pending && (
          <div className="flex flex-wrap items-center gap-2">
            {canApprove ? (
              <>
                <Button size="sm" variant="primary" icon={<Check className="size-4" />} disabled={selfBlocked} onClick={() => setConfirm(true)} title={selfBlocked ? "High-risk: needs a different administrator" : undefined}>Review and approve</Button>
                <Button size="sm" variant="ghost" icon={<X className="size-4" />} loading={decide.isPending && decide.variables === "reject"} onClick={() => decide.mutate("reject")}>Reject</Button>
                {selfBlocked && <span className="text-xs text-subtle">You proposed this high-risk change; another administrator must approve it.</span>}
              </>
            ) : <span className="text-xs text-subtle">Waiting for a business owner or administrator to approve.</span>}
            {(a.proposedById === me || canApprove) && <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>}
          </div>
        )}
      </div>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Approve this change?" description={`It will be made in ${a.providerName} (${a.connectionName}) for ${a.businessName}.`}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Back</Button><Button variant="primary" loading={decide.isPending && decide.variables === "approve"} onClick={() => decide.mutate("approve")}>Approve and run</Button></>}>
        <div className="space-y-3 text-sm">
          <p className="font-medium">{a.actionLabel}: {a.target.name}</p>
          <ul className="space-y-1">{a.changes.map((c) => <li key={c.label}>{c.label}: <span className="text-muted">{c.current}</span> → <b>{c.proposed}</b></li>)}</ul>
          <p className="text-muted">{a.expectedEffect}</p>
          <label className="block"><span className="text-[13px] text-subtle">Comment (optional)</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} className="mt-1 h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-sm outline-none focus:border-accent/50" /></label>
          <p className="text-xs text-subtle">The platform re-checks the current value first. If it changed since this was proposed, nothing is changed and you'll be asked to review again.</p>
        </div>
      </Dialog>
    </article>
  );
}
