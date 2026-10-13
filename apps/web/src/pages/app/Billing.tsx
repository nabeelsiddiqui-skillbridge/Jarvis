import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, ExternalLink } from "lucide-react";
import { LIMIT_LABELS, PAID_PLANS, PLANS, type BillingSummary, type PaidPlanId, type PlanLimits } from "@bca/shared";
import { errorMessage, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/session";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { ErrorState, Prerequisite } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

type Billing = BillingSummary & { canManage: boolean };

const STATUS_LABEL: Record<string, string> = {
  trialing: "Trial", active: "Active", past_due: "Payment overdue", unpaid: "Unpaid", incomplete: "Payment incomplete",
  incomplete_expired: "Expired", canceled: "Cancelled", paused: "Paused", none: "No subscription",
};

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");

export function Billing() {
  const { workspaceId = "" } = useParams();
  const me = useMe();
  const ws = me.data?.workspaces.find((w) => w.id === workspaceId);
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const billing = useQuery({ queryKey: ["billing", workspaceId], queryFn: ({ signal }) => get<Billing>(`/workspaces/${workspaceId}/billing`, signal) });
  const go = (url: string) => window.location.assign(url);
  const checkout = useMutation({ mutationFn: (plan: PaidPlanId) => post<{ url: string }>(`/workspaces/${workspaceId}/billing/checkout`, { plan }), onSuccess: (r) => go(r.url), onError: (e) => toast(errorMessage(e), "error") });
  const portal = useMutation({ mutationFn: () => post<{ url: string }>(`/workspaces/${workspaceId}/billing/portal`), onSuccess: (r) => go(r.url), onError: (e) => toast(errorMessage(e), "error") });

  // Returning from Stripe Checkout: the webhook may land a moment later, so refresh a few times.
  const returned = params.get("checkout");
  useEffect(() => {
    if (returned !== "success") return;
    let n = 0;
    const t = setInterval(() => { qc.invalidateQueries({ queryKey: ["billing", workspaceId] }); qc.invalidateQueries({ queryKey: ["me"] }); if (++n >= 5) clearInterval(t); }, 2000);
    return () => clearInterval(t);
  }, [returned, workspaceId, qc]);

  if (billing.isLoading) return <><PageHeader title="Billing" /><div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-64" /></div></>;
  if (billing.error) return <><PageHeader title="Billing" /><ErrorState error={billing.error} onRetry={() => billing.refetch()} /></>;
  const b = billing.data!;
  const current = PLANS[b.effectivePlan];

  return (
    <>
      <PageHeader title="Billing" description={`Plan and usage for ${ws?.name ?? "this workspace"}. Limits apply to the whole workspace.`}
        actions={b.canManage && b.managedByStripe && b.stripeConfigured && <Button icon={<ExternalLink className="size-4" />} loading={portal.isPending} onClick={() => portal.mutate()}>Manage billing</Button>} />
      <div className="space-y-6">
        {returned === "success" && <Prerequisite title="Payment received" action={<Button size="sm" variant="ghost" onClick={() => setParams({})}>Dismiss</Button>}>Your plan updates here as soon as Stripe confirms the subscription (usually within a few seconds).</Prerequisite>}
        {returned === "cancelled" && <Prerequisite title="Checkout cancelled" action={<Button size="sm" variant="ghost" onClick={() => setParams({})}>Dismiss</Button>}>Nothing was charged and your plan hasn't changed.</Prerequisite>}
        {b.notice && <Prerequisite tone="warning" title="Plan notice">{b.notice}</Prerequisite>}
        {!b.canManage && <Prerequisite title="Read-only">Only workspace owners can change the plan or payment details.</Prerequisite>}

        <Card title="Current plan">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-2xl font-semibold">{current.name}</span>
                <Badge tone={b.status === "active" ? "success" : b.status === "trialing" ? "accent" : ["past_due", "unpaid"].includes(b.status) ? "danger" : "neutral"}>{b.effectivePlan === "free" && b.status !== "active" ? "Free plan" : STATUS_LABEL[b.status] ?? b.status}</Badge>
                {b.cancelAtPeriodEnd && <Badge tone="warning">Ends {date(b.currentPeriodEnd)}</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">
                {b.status === "trialing" && b.trialEndsAt && b.effectivePlan !== "free" ? `Free trial of ${PLANS[b.plan].name} until ${date(b.trialEndsAt)}. No card needed; you'll move to the Free plan unless you choose a plan.`
                  : b.managedByStripe && b.currentPeriodEnd ? `${current.priceMonthly ? `$${current.priceMonthly}/month · ` : ""}${b.cancelAtPeriodEnd ? "ends" : "renews"} ${date(b.currentPeriodEnd)}`
                  : b.effectivePlan === "free" ? "Free plan limits apply. Existing data is always kept." : `${current.name} plan granted by the platform team.`}
              </p>
            </div>
            <CreditCard className="size-8 text-subtle" aria-hidden />
          </div>
          <h3 className="mb-3 mt-6 text-sm font-medium text-muted">Usage · resets {date(b.periodEnd)}</h3>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {(Object.keys(LIMIT_LABELS) as (keyof PlanLimits)[]).map((k) => <Meter key={k} label={LIMIT_LABELS[k]} used={b.usage[k]} limit={b.limits[k]} />)}
          </ul>
        </Card>

        <section aria-labelledby="plans-h">
          <h2 id="plans-h" className="mb-3 text-[15px] font-semibold">Plans</h2>
          {!b.stripeConfigured && <div className="mb-4"><Prerequisite title="Online payments aren't set up on this platform">A platform administrator must configure Stripe (STRIPE_SECRET_KEY and a price for each plan). Until then, plans can only be granted by the platform team.</Prerequisite></div>}
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {(["free", ...PAID_PLANS] as const).map((id) => {
              const p = PLANS[id];
              const isCurrent = b.effectivePlan === id;
              const buyable = id !== "free" && b.purchasable.includes(id as PaidPlanId);
              return (
                <li key={id} className={cn("panel flex flex-col p-5", isCurrent && "border-accent/50 shadow-[0_0_0_1px_rgba(34,211,238,0.25)]")}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-display text-lg font-semibold">{p.name}</h3>
                    {isCurrent && <Badge tone="accent">Current</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{p.tagline}</p>
                  <p className="mt-3"><span className="font-display text-3xl font-semibold">${p.priceMonthly}</span><span className="text-sm text-muted"> / month</span></p>
                  <ul className="mt-4 flex-1 space-y-1.5 text-sm">
                    {p.highlights.map((h) => <li key={h} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />{h}</li>)}
                  </ul>
                  <div className="mt-5">
                    {id === "free" ? <p className="text-xs text-subtle">Applies automatically when no paid plan is active.</p>
                      : isCurrent && b.managedByStripe ? <p className="text-xs text-subtle">Change or cancel with “Manage billing”.</p>
                      : !b.canManage ? <p className="text-xs text-subtle">A workspace owner can upgrade.</p>
                      : b.managedByStripe && ["active", "trialing", "past_due"].includes(b.status) ? <Button className="w-full" variant="secondary" loading={portal.isPending} onClick={() => portal.mutate()}>Switch in billing portal</Button>
                      : buyable ? <Button className="w-full" variant={id === "growth" ? "primary" : "secondary"} loading={checkout.isPending && checkout.variables === id} onClick={() => checkout.mutate(id as PaidPlanId)}>Choose {p.name}</Button>
                      : <Button className="w-full" variant="secondary" disabled title="Online payments aren't configured for this plan">Not available yet</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-subtle">Prices in USD, billed monthly through Stripe; taxes may apply. Downgrading never deletes data — only adding beyond the new limits is blocked.</p>
        </section>
      </div>
    </>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, limit ? (used / limit) * 100 : 0);
  const tone = used >= limit ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-accent";
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className={cn("tabular-nums", used >= limit && "text-danger")}>{used.toLocaleString()} / {limit.toLocaleString()}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <div className={cn("h-full rounded-full transition-[width]", tone)} style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}
