import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, KeyRound, RotateCcw, Search, ShieldAlert, XCircle } from "lucide-react";
import { PLANS, PLAN_IDS, type PlanId } from "@bca/shared";
import { errorMessage, get, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/session";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, Prerequisite } from "@/components/ui/EmptyState";
import { Field, Input, Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/components/widgets/WidgetFrame";

/**
 * Platform administration console. Everything here is operational metadata; customer data is
 * only reachable through a reasoned, time-limited support grant that the customer can see.
 */
const TABS = [
  { value: "overview", label: "Overview" },
  { value: "customers", label: "Customers" },
  { value: "connectors", label: "Connector health" },
  { value: "jobs", label: "Jobs" },
  { value: "usage", label: "AI & voice usage" },
  { value: "flags", label: "Feature flags" },
  { value: "config", label: "Configuration" },
  { value: "audit", label: "Audit" },
  { value: "support", label: "Support access" },
] as const;
type Tab = (typeof TABS)[number]["value"];

const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const when = (iso: string | null | undefined) => (iso ? relativeTime(iso) : "—");

export function Admin() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get("tab"))?.value ?? "overview") as Tab;
  const open = (t: Tab, extra: Record<string, string> = {}) => setParams({ tab: t, ...extra });
  if (me.data && !me.data.user.isPlatformAdmin) {
    return <><PageHeader title="Platform administration" /><EmptyState icon={<ShieldAlert className="size-5" />} title="Platform administrators only">Platform administrator access is granted through the PLATFORM_ADMIN_EMAILS setting.</EmptyState></>;
  }
  return (
    <>
      <PageHeader title="Platform administration" eyebrow={<Badge tone="violet">Platform staff</Badge>} description="Operational status across all customers. Customer data is only visible through audited support access." />
      <Tabs className="mb-6" value={tab} onChange={(v) => open(v)} items={TABS.map((t) => ({ value: t.value, label: t.label }))} />
      {tab === "overview" && <Overview open={open} />}
      {tab === "customers" && <Customers selected={params.get("ws")} open={open} />}
      {tab === "connectors" && <Connectors />}
      {tab === "jobs" && <Jobs />}
      {tab === "usage" && <Usage />}
      {tab === "flags" && <Flags />}
      {tab === "config" && <Config />}
      {tab === "audit" && <Audit workspaceId={params.get("ws")} />}
      {tab === "support" && <Support />}
    </>
  );
}

function useAdmin<T>(path: string, key: unknown[] = [path]) {
  return useQuery({ queryKey: ["admin", ...key], queryFn: ({ signal }) => get<T>(`/admin/${path}`, signal) });
}

function Loading<T>({ q, children }: { q: { isLoading: boolean; error: unknown; data?: T; refetch: () => unknown }; children: (d: T) => ReactNode }) {
  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <>{children(q.data as T)}</>;
}

function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: "danger" | "warning" | "success"; sub?: ReactNode }) {
  return (
    <div className="panel p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn("mt-1 font-display text-2xl font-semibold tabular-nums", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "success" && "text-success")}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-subtle">{sub}</p>}
    </div>
  );
}

function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children;
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-line text-xs text-muted"><tr>{head.map((h, i) => <th key={i} scope="col" className="whitespace-nowrap px-3 py-2.5 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line/70">{rows}</tbody>
      </table>
      {Array.isArray(rows) && !rows.length && <p className="px-3 py-6 text-center text-sm text-muted">{empty ?? "Nothing here."}</p>}
    </div>
  );
}
const td = "px-3 py-2.5 align-top";

// ------------------------------------------------------------------ overview

function Overview({ open }: { open: (t: Tab, extra?: Record<string, string>) => void }) {
  const q = useAdmin<any>("overview");
  return (
    <Loading q={q}>{(o) => {
      const usage = (k: string) => o.usage30d.find((u: any) => u.kind === k);
      return (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Workspaces" value={num(o.counts.workspaces)} sub={`${num(o.counts.users)} users · ${num(o.counts.active_users_30d)} active in 30 days`} />
            <Stat label="Businesses" value={num(o.counts.businesses)} sub={`${num(o.counts.demo_businesses)} demo businesses not counted`} />
            <Stat label="Connected accounts" value={num(o.counts.connections)} sub={<button className="underline-offset-2 hover:underline" onClick={() => open("connectors")}>{num(o.counts.failing_connections)} failing</button>} tone={o.counts.failing_connections ? "warning" : undefined} />
            <Stat label="Jobs" value={num(o.counts.jobs_due)} sub={<>due now · oldest {o.counts.oldest_due_seconds ? `${Math.round(o.counts.oldest_due_seconds / 60)} min` : "—"} · <button className="underline-offset-2 hover:underline" onClick={() => open("jobs")}>{num(o.counts.jobs_failed_24h)} failed in 24h</button></>} tone={o.counts.jobs_failed_24h ? "warning" : undefined} />
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Subscriptions" description="Effective plan per workspace (ended trials count as Free).">
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {PLAN_IDS.map((p) => <li key={p} className="rounded-lg border border-line p-3"><p className="text-xs text-muted">{PLANS[p].name}</p><p className="font-display text-xl font-semibold tabular-nums">{num(o.subscriptions.byPlan[p])}</p></li>)}
              </ul>
              <p className="mt-3 text-sm text-muted">List-price MRR from paying Stripe subscriptions: <span className="font-medium text-fg">${num(o.subscriptions.listMrr)}</span> <span className="text-xs text-subtle">(before discounts and tax — Stripe is the source of truth)</span></p>
              <p className="mt-1 text-xs text-subtle">By status: {Object.entries(o.subscriptions.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</p>
            </Card>
            <Card title="AI and voice, last 30 days">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-muted">Assistant questions</dt><dd className="font-display text-xl font-semibold tabular-nums">{num(usage("ai_message")?.quantity)}</dd></div>
                <div><dt className="text-muted">Background AI calls</dt><dd className="font-display text-xl font-semibold tabular-nums">{num(usage("ai_background")?.quantity)}</dd></div>
                <div><dt className="text-muted">Tokens in / out</dt><dd className="tabular-nums">{num((usage("ai_message")?.input_tokens ?? 0) + (usage("ai_background")?.input_tokens ?? 0))} / {num((usage("ai_message")?.output_tokens ?? 0) + (usage("ai_background")?.output_tokens ?? 0))}</dd></div>
                <div><dt className="text-muted">Voice conversations · TTS characters</dt><dd className="tabular-nums">{num(usage("voice_session")?.quantity)} · {num(usage("tts_characters")?.quantity)}</dd></div>
              </dl>
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => open("usage")}>Usage details</Button>
            </Card>
          </div>
          {o.counts.active_support_grants > 0 && <Prerequisite title={`${o.counts.active_support_grants} active support access grant(s)`} action={<Button size="sm" onClick={() => open("support")}>Review</Button>}>Support access is time-limited and visible to the affected customers.</Prerequisite>}
        </div>
      );
    }}</Loading>
  );
}

// ------------------------------------------------------------------ customers

function Customers({ selected, open }: { selected: string | null; open: (t: Tab, extra?: Record<string, string>) => void }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const list = useAdmin<any[]>(`workspaces?q=${encodeURIComponent(term)}`, ["workspaces", term]);
  if (selected) return <WorkspaceDetail id={selected} open={open} />;
  return (
    <div className="space-y-4">
      <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(q); }} role="search">
        <Input aria-label="Search workspaces, owners or members" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" icon={<Search className="size-4" />}>Search</Button>
      </form>
      <Loading q={list}>{(rows) => (
        <Table head={["Workspace", "Owner", "Plan", "Businesses", "Accounts", "Members", "Questions this month", "Created"]} empty="No workspaces match.">
          {rows.map((w) => (
            <tr key={w.id} className="hover:bg-white/[0.02]">
              <td className={td}><button className="font-medium text-accent hover:underline" onClick={() => open("customers", { ws: w.id })}>{w.name}</button></td>
              <td className={cn(td, "text-muted")}>{w.owner_email ?? "—"}</td>
              <td className={td}><PlanBadge plan={w.effectivePlan} status={w.status} stripe={Boolean(w.stripe_subscription_id)} /></td>
              <td className={cn(td, "tabular-nums")}>{w.businesses}</td>
              <td className={cn(td, "tabular-nums")}>{w.connections}{w.failing_connections > 0 && <Badge tone="warning" className="ml-1.5">{w.failing_connections} failing</Badge>}</td>
              <td className={cn(td, "tabular-nums")}>{w.members}</td>
              <td className={cn(td, "tabular-nums")}>{num(w.ai_messages_month)}</td>
              <td className={cn(td, "text-muted")}>{when(w.created_at)}</td>
            </tr>
          ))}
        </Table>
      )}</Loading>
    </div>
  );
}

function PlanBadge({ plan, status, stripe }: { plan: PlanId; status: string; stripe: boolean }) {
  return <span className="inline-flex flex-wrap gap-1"><Badge tone={plan === "free" ? "neutral" : "accent"}>{PLANS[plan]?.name ?? plan}</Badge>{status && status !== "active" && <Badge tone={["past_due", "unpaid"].includes(status) ? "danger" : "neutral"}>{status.replace("_", " ")}</Badge>}{stripe && <Badge tone="violet">Stripe</Badge>}</span>;
}

function WorkspaceDetail({ id, open }: { id: string; open: (t: Tab, extra?: Record<string, string>) => void }) {
  const q = useAdmin<any>(`workspaces/${id}`, ["workspace", id]);
  const qc = useQueryClient();
  const toast = useToast();
  const [grantPlan, setGrantPlan] = useState(false);
  const [disable, setDisable] = useState<any>(null);
  const [support, setSupport] = useState(false);
  return (
    <Loading q={q}>{(d) => (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => open("customers")}>← All customers</Button>
          <h2 className="font-display text-xl font-semibold">{d.workspace.name}</h2>
          {d.subscription && <PlanBadge plan={d.subscription.effectivePlan} status={d.subscription.status} stripe={Boolean(d.subscription.stripe_subscription_id)} />}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setGrantPlan(true)}>Change plan…</Button>
            <Button size="sm" icon={<KeyRound className="size-4" />} onClick={() => setSupport(true)}>Request support access…</Button>
            <Button size="sm" variant="ghost" onClick={() => open("audit", { ws: id })}>Audit log</Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {(["businesses", "connections", "members", "aiMessages", "voiceSessions"] as const).map((k) => (
            <Stat key={k} label={{ businesses: "Businesses", connections: "Accounts", members: "Members + invites", aiMessages: "Questions this month", voiceSessions: "Voice this month" }[k]} value={`${num(d.usage[k])} / ${num(d.limits[k])}`} tone={d.usage[k] >= d.limits[k] ? "warning" : undefined} />
          ))}
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Members">
            <ul className="divide-y divide-line/70 text-sm">
              {d.members.map((m: any) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 break-words"><span className="font-medium">{m.name}</span> <span className="text-muted">{m.email}</span></span>
                  <Badge>{m.role}</Badge>
                  {m.disabled_at && <Badge tone="danger">Disabled</Badge>}
                  <span className="text-xs text-subtle">last sign-in {when(m.last_login_at)}</span>
                  <Button size="sm" variant="ghost" onClick={() => setDisable(m)}>{m.disabled_at ? "Enable" : "Disable"}</Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Subscription">
            {d.subscription ? (
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted">Plan on record</dt><dd>{PLANS[d.subscription.plan as PlanId]?.name ?? d.subscription.plan} ({d.subscription.status})</dd>
                <dt className="text-muted">Limits applied</dt><dd>{PLANS[d.subscription.effectivePlan as PlanId].name}</dd>
                <dt className="text-muted">Trial ends</dt><dd>{d.subscription.trial_ends_at ? new Date(d.subscription.trial_ends_at).toLocaleDateString() : "—"}</dd>
                <dt className="text-muted">Period ends</dt><dd>{d.subscription.current_period_end ? new Date(d.subscription.current_period_end).toLocaleDateString() : "—"}{d.subscription.cancel_at_period_end ? " (cancelling)" : ""}</dd>
                <dt className="text-muted">Stripe customer</dt><dd className="break-all font-mono text-xs">{d.subscription.stripe_customer_id ?? "—"}</dd>
              </dl>
            ) : <p className="text-sm text-muted">No subscription record.</p>}
            {d.billingEvents.length > 0 && <p className="mt-3 text-xs text-subtle">Last billing events: {d.billingEvents.map((e: any) => `${e.type} (${e.status}, ${when(e.received_at)})`).join(" · ")}</p>}
          </Card>
          <Card title="Businesses">
            <ul className="divide-y divide-line/70 text-sm">
              {d.businesses.map((b: any) => <li key={b.id} className="flex flex-wrap gap-2 py-2"><span className="flex-1 font-medium">{b.name}</span><span className="text-muted">{b.industry}</span>{b.is_demo && <Badge tone="demo">Demo</Badge>}{b.archived_at && <Badge>Archived</Badge>}</li>)}
            </ul>
          </Card>
          <Card title="Connected accounts">
            {d.connections.length ? (
              <ul className="divide-y divide-line/70 text-sm">
                {d.connections.map((c: any) => (
                  <li key={c.id} className="py-2">
                    <div className="flex flex-wrap items-center gap-2"><span className="flex-1 font-medium">{c.display_name}</span><StatusBadge status={c.status} /></div>
                    <p className="text-xs text-muted">{c.provider} · {c.business_name} · last success {when(c.last_success_at)}</p>
                    {c.last_error && <p className="mt-0.5 break-words text-xs text-danger">{c.last_error}</p>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No connected accounts.</p>}
          </Card>
        </div>
        <Card title="Support access history">
          {d.supportGrants.length ? <ul className="space-y-1 text-sm">{d.supportGrants.map((g: any) => <li key={g.id} className="break-words"><span className="text-muted">{when(g.created_at)} · {g.admin_email}:</span> {g.reason} {g.revoked_at ? <Badge>Revoked</Badge> : new Date(g.expires_at) > new Date() ? <Badge tone="warning">Active</Badge> : <Badge>Expired</Badge>}</li>)}</ul> : <p className="text-sm text-muted">Never accessed by platform staff.</p>}
        </Card>
        <PlanDialog open={grantPlan} onClose={() => setGrantPlan(false)} workspaceId={id} onDone={() => { qc.invalidateQueries({ queryKey: ["admin"] }); toast("Plan updated"); }} />
        <SupportDialog open={support} onClose={() => setSupport(false)} workspaceId={id} name={d.workspace.name} onDone={() => { qc.invalidateQueries({ queryKey: ["admin"] }); open("support"); }} />
        <ReasonDialog open={Boolean(disable)} onClose={() => setDisable(null)} title={disable?.disabled_at ? `Enable ${disable?.email}?` : `Disable ${disable?.email}?`}
          description={disable?.disabled_at ? undefined : "They are signed out everywhere and can't sign in until re-enabled."} confirm={disable?.disabled_at ? "Enable account" : "Disable account"} danger={!disable?.disabled_at}
          onConfirm={async (reason) => { await post(`/admin/users/${disable.id}/disabled`, { disabled: !disable.disabled_at, reason }); qc.invalidateQueries({ queryKey: ["admin"] }); toast("Account updated"); }} />
      </div>
    )}</Loading>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "active" ? "success" : ["error", "reauth_required"].includes(status) ? "danger" : "neutral";
  return <Badge tone={tone}>{status.replace("_", " ")}</Badge>;
}

function ReasonDialog({ open, onClose, title, description, confirm, danger, onConfirm }: { open: boolean; onClose: () => void; title: string; description?: string; confirm: string; danger?: boolean; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} loading={busy} disabled={reason.trim().length < 5} onClick={async () => {
        setBusy(true); setErr(null);
        try { await onConfirm(reason.trim()); setReason(""); onClose(); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
      }}>{confirm}</Button></>}>
      <Field label="Reason (recorded in the audit log)" error={err}>{(p) => <Input {...p} data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Dialog>
  );
}

function PlanDialog({ open, onClose, workspaceId, onDone }: { open: boolean; onClose: () => void; workspaceId: string; onDone: () => void }) {
  const [plan, setPlan] = useState<PlanId>("growth");
  const [status, setStatus] = useState<"active" | "trialing">("trialing");
  const [days, setDays] = useState("14");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => post(`/admin/workspaces/${workspaceId}/subscription`, { plan, status, trialDays: status === "trialing" ? Number(days) : undefined, reason }),
    onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Change plan without Stripe" description="For pilots, extended trials and complimentary plans. Workspaces with a live Stripe subscription must be changed in Stripe."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={reason.trim().length < 5} onClick={() => m.mutate()}>Apply</Button></>}>
      <div className="space-y-4">
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <Field label="Plan">{(p) => <Select {...p} value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}>{PLAN_IDS.map((x) => <option key={x} value={x}>{PLANS[x].name}</option>)}</Select>}</Field>
        <Field label="Type">{(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as any)}><option value="trialing">Trial (ends automatically)</option><option value="active">Granted until changed</option></Select>}</Field>
        {status === "trialing" && <Field label="Trial length (days)">{(p) => <Input {...p} type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />}</Field>}
        <Field label="Reason (recorded in the customer's audit log)">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function SupportDialog({ open, onClose, workspaceId, name, onDone }: { open: boolean; onClose: () => void; workspaceId: string; name: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({ mutationFn: () => post("/admin/support-access", { workspaceId, reason: reason.trim(), minutes: Number(minutes) }), onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr(errorMessage(e)) });
  return (
    <Dialog open={open} onClose={onClose} title={`Support access to ${name}`} description="Read-only access to this workspace's businesses for a limited time. The workspace owners are notified, see your reason, can end it at any time, and every page you open is recorded in their audit log."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={reason.trim().length < 10} onClick={() => m.mutate()}>Open read-only access</Button></>}>
      <div className="space-y-4">
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <Field label="Reason shown to the customer" hint="At least 10 characters, e.g. the ticket and what you need to check.">{(p) => <Input {...p} data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Field label="Duration">{(p) => <Select {...p} value={minutes} onChange={(e) => setMinutes(e.target.value)}>{[15, 30, 60, 120, 240].map((x) => <option key={x} value={x}>{x < 60 ? `${x} minutes` : `${x / 60} hour${x > 60 ? "s" : ""}`}</option>)}</Select>}</Field>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ connectors

function Connectors() {
  const q = useAdmin<any>("connectors");
  return (
    <Loading q={q}>{(d) => (
      <div className="space-y-6">
        <Table head={["Connector", "Configuration", "Accounts", "Failing", "Syncs (24h)", "Webhooks (24h)"]}>
          {d.providers.map((p: any) => (
            <tr key={p.id}>
              <td className={cn(td, "font-medium")}>{p.name}</td>
              <td className={td}>{p.config === "available" ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Configured</Badge> : <span title={p.missingConfig.join(", ")}><Badge tone="warning">{p.config.replace("_", " ")}</Badge></span>}{p.missingConfig?.length > 0 && <p className="mt-1 text-xs text-subtle">Missing: {p.missingConfig.join(", ")}</p>}</td>
              <td className={cn(td, "tabular-nums")}>{p.connections} <span className="text-muted">({p.active} active)</span></td>
              <td className={cn(td, "tabular-nums", p.failing && "text-danger")}>{p.failing}{p.reauth > 0 && <span className="text-xs text-muted"> · {p.reauth} need reconnect</span>}</td>
              <td className={cn(td, "tabular-nums")}><span className="text-success">{p.syncs24h.succeeded} ok</span> · <span className={cn(p.syncs24h.failed && "text-danger")}>{p.syncs24h.failed} failed</span>{p.syncs24h.running + p.syncs24h.queued > 0 && <span className="text-muted"> · {p.syncs24h.running + p.syncs24h.queued} pending</span>}</td>
              <td className={cn(td, "tabular-nums text-muted")}>{Object.entries(p.webhooks24h).filter(([k]) => k !== "lastAt").map(([k, v]) => `${v} ${k}`).join(" · ") || "—"}</td>
            </tr>
          ))}
        </Table>
        <section>
          <h2 className="mb-3 text-[15px] font-semibold">Sync failures</h2>
          <Table head={["Account", "Customer", "Status", "Error", "Failures", "Last success"]} empty="No failing connections.">
            {d.failures.map((c: any) => (
              <tr key={c.id}>
                <td className={td}><span className="font-medium">{c.display_name}</span><p className="text-xs text-muted">{c.provider}</p></td>
                <td className={td}>{c.workspace_name}<p className="text-xs text-muted">{c.business_name}</p></td>
                <td className={td}><StatusBadge status={c.status} /></td>
                <td className={cn(td, "max-w-[320px] break-words text-danger")}>{c.last_error ?? "—"}<p className="text-xs text-subtle">{when(c.last_error_at)}</p></td>
                <td className={cn(td, "tabular-nums")}>{c.consecutive_failures}</td>
                <td className={cn(td, "text-muted")}>{when(c.last_success_at)}</td>
              </tr>
            ))}
          </Table>
        </section>
      </div>
    )}</Loading>
  );
}

// ------------------------------------------------------------------ jobs

function Jobs() {
  const [status, setStatus] = useState("failed");
  const q = useAdmin<any>(`jobs${status ? `?status=${status}` : ""}`, ["jobs", status]);
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({ mutationFn: (id: string) => post(`/admin/jobs/${id}/retry`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin"] }); toast("Job queued again"); }, onError: (e) => toast(errorMessage(e), "error") });
  return (
    <div className="space-y-4">
      <Loading q={q}>{(d) => {
        const types = [...new Set(d.summary.map((s: any) => s.type))] as string[];
        const n = (t: string, s: string) => d.summary.find((x: any) => x.type === t && x.status === s)?.n ?? 0;
        return (
          <>
            <Table head={["Job type", "Queued", "Running", "Succeeded (24h)", "Failed (24h)"]} empty="No jobs in the last 24 hours.">
              {types.map((t) => <tr key={t}><td className={cn(td, "font-mono text-xs")}>{t}</td><td className={cn(td, "tabular-nums")}>{n(t, "queued")}</td><td className={cn(td, "tabular-nums")}>{n(t, "running")}</td><td className={cn(td, "tabular-nums text-success")}>{n(t, "succeeded")}</td><td className={cn(td, "tabular-nums", n(t, "failed") && "text-danger")}>{n(t, "failed")}</td></tr>)}
            </Table>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-[15px] font-semibold">Recent jobs</h2>
              <Tabs value={status} onChange={setStatus} items={[{ value: "failed", label: "Failed" }, { value: "running", label: "Running" }, { value: "queued", label: "Queued" }, { value: "", label: "All" }]} />
            </div>
            <Table head={["Type", "Customer", "Status", "Attempts", "Error", "Created", ""]} empty="No jobs.">
              {d.jobs.map((j: any) => (
                <tr key={j.id}>
                  <td className={cn(td, "font-mono text-xs")}>{j.type}</td>
                  <td className={td}>{j.workspace_name ?? <span className="text-muted">Platform</span>}<p className="text-xs text-muted">{j.business_name}</p></td>
                  <td className={td}><Badge tone={j.status === "failed" ? "danger" : j.status === "succeeded" ? "success" : "neutral"}>{j.status}</Badge></td>
                  <td className={cn(td, "tabular-nums")}>{j.attempts}/{j.max_attempts}</td>
                  <td className={cn(td, "max-w-[320px] break-words text-xs text-danger")}>{j.last_error ?? ""}</td>
                  <td className={cn(td, "text-muted")}>{when(j.created_at)}</td>
                  <td className={td}>{j.status === "failed" && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} loading={retry.isPending && retry.variables === j.id} onClick={() => retry.mutate(j.id)}>Retry</Button>}</td>
                </tr>
              ))}
            </Table>
          </>
        );
      }}</Loading>
    </div>
  );
}

// ------------------------------------------------------------------ usage

function Usage() {
  const [days, setDays] = useState("30");
  const q = useAdmin<any>(`usage?days=${days}`, ["usage", days]);
  return (
    <div className="space-y-4">
      <Tabs value={days} onChange={setDays} items={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
      <Loading q={q}>{(d) => {
        const byDay = new Map<string, Record<string, number>>();
        for (const r of d.daily) byDay.set(r.day, { ...(byDay.get(r.day) ?? {}), [r.kind]: r.quantity });
        const series = [...byDay.entries()];
        const max = Math.max(1, ...series.map(([, v]) => v.ai_message ?? 0));
        return (
          <>
            <Card title="Assistant questions per day">
              {series.length ? (
                <div className="flex h-32 items-end gap-1" role="img" aria-label="Assistant questions per day">
                  {series.map(([day, v]) => <div key={day} title={`${day}: ${v.ai_message ?? 0} questions, ${v.voice_session ?? 0} voice conversations`} className="min-w-[4px] flex-1 rounded-t bg-accent/70" style={{ height: `${((v.ai_message ?? 0) / max) * 100}%` }} />)}
                </div>
              ) : <p className="text-sm text-muted">No usage in this period.</p>}
            </Card>
            <div className="grid gap-6 xl:grid-cols-2">
              <section>
                <h2 className="mb-3 text-[15px] font-semibold">By workspace</h2>
                <Table head={["Workspace", "Questions", "Background AI", "Tokens in / out", "Voice", "TTS chars"]} empty="No usage.">
                  {d.byWorkspace.map((w: any) => <tr key={w.id}><td className={cn(td, "font-medium")}>{w.name}</td><td className={cn(td, "tabular-nums")}>{num(w.ai_messages)}</td><td className={cn(td, "tabular-nums")}>{num(w.ai_background)}</td><td className={cn(td, "tabular-nums")}>{num(w.input_tokens)} / {num(w.output_tokens)}</td><td className={cn(td, "tabular-nums")}>{num(w.voice_sessions)}</td><td className={cn(td, "tabular-nums")}>{num(w.tts_characters)}</td></tr>)}
                </Table>
              </section>
              <section>
                <h2 className="mb-3 text-[15px] font-semibold">By AI feature</h2>
                <Table head={["Feature", "Calls", "Tokens in", "Tokens out"]} empty="No AI calls.">
                  {d.byFeature.map((f: any) => <tr key={f.feature}><td className={cn(td, "font-mono text-xs")}>{f.feature === "ai_message" ? "assistant" : f.feature}</td><td className={cn(td, "tabular-nums")}>{num(f.calls)}</td><td className={cn(td, "tabular-nums")}>{num(f.input_tokens)}</td><td className={cn(td, "tabular-nums")}>{num(f.output_tokens)}</td></tr>)}
                </Table>
              </section>
            </div>
          </>
        );
      }}</Loading>
    </div>
  );
}

// ------------------------------------------------------------------ flags

function Flags() {
  const q = useAdmin<any[]>("flags");
  const ws = useAdmin<any[]>("workspaces?limit=200", ["workspaces", "all"]);
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (f: { key: string; enabled: boolean; overrides: Record<string, boolean> }) => put(`/admin/flags/${f.key}`, { enabled: f.enabled, overrides: f.overrides }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "flags"] }); qc.invalidateQueries({ queryKey: ["me"] }); toast("Flag saved"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const [addFor, setAddFor] = useState<Record<string, string>>({});
  const name = (id: string) => ws.data?.find((w) => w.id === id)?.name ?? id.slice(0, 8);
  return (
    <Loading q={q}>{(flags) => (
      <div className="space-y-4">
        <Prerequisite title="Enforced on the server">Turning a flag off blocks the feature for the affected workspaces immediately — including approved actions that haven't run yet — and the app explains why.</Prerequisite>
        {flags.map((f) => (
          <Card key={f.key} title={<span className="font-mono text-sm">{f.key}</span>} description={f.description}
            actions={<label className="inline-flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-[#22d3ee]" checked={f.enabled} onChange={(e) => { const on = e.target.checked; if (!on && !confirm(`Turn "${f.key}" off for every workspace without an override? It takes effect immediately.`)) return; save.mutate({ key: f.key, enabled: on, overrides: f.overrides }); }} /> On for everyone</label>}>
            <p className="mb-2 text-xs text-muted">Per-workspace overrides (win over the global setting):</p>
            <ul className="flex flex-wrap gap-2">
              {Object.entries(f.overrides as Record<string, boolean>).map(([id, on]) => (
                <li key={id}><Badge tone={on ? "success" : "danger"}>{name(id)}: {on ? "on" : "off"} <button aria-label={`Remove override for ${name(id)}`} className="ml-1" onClick={() => { const o = { ...f.overrides }; delete o[id]; save.mutate({ key: f.key, enabled: f.enabled, overrides: o }); }}><XCircle className="size-3" /></button></Badge></li>
              ))}
              {!Object.keys(f.overrides).length && <li className="text-xs text-subtle">None</li>}
            </ul>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Select aria-label={`Workspace for ${f.key} override`} className="max-w-xs" value={addFor[f.key] ?? ""} onChange={(e) => setAddFor({ ...addFor, [f.key]: e.target.value })}>
                <option value="">Choose a workspace…</option>
                {ws.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
              <Button size="sm" disabled={!addFor[f.key]} onClick={() => save.mutate({ key: f.key, enabled: f.enabled, overrides: { ...f.overrides, [addFor[f.key]!]: false } })}>Turn off for it</Button>
              <Button size="sm" variant="ghost" disabled={!addFor[f.key]} onClick={() => save.mutate({ key: f.key, enabled: f.enabled, overrides: { ...f.overrides, [addFor[f.key]!]: true } })}>Force on</Button>
            </div>
          </Card>
        ))}
      </div>
    )}</Loading>
  );
}

// ------------------------------------------------------------------ config

function Config() {
  const q = useAdmin<any>("config");
  return (
    <Loading q={q}>{(c) => (
      <div className="space-y-6">
        <Prerequisite title="Values are never shown">This page reports whether each secret is set. Secrets are only read on the server.</Prerequisite>
        <Table head={["Setting", "Status", "Needed for"]}>
          {c.secrets.map((s: any) => (
            <tr key={s.key}>
              <td className={td}><span className="font-mono text-xs">{s.key}</span><p className="text-xs text-muted">{s.label}</p></td>
              <td className={td}>{s.configured ? <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>Set</Badge> : <Badge tone="warning">Not set</Badge>}</td>
              <td className={cn(td, "text-muted")}>{s.requiredFor}</td>
            </tr>
          ))}
        </Table>
        <Card title="URLs to register with providers" description={`Environment: ${c.environment} · App ${c.appUrl} · API ${c.apiUrl}`}>
          <ul className="space-y-3 text-sm">
            {c.connectors.map((x: any) => (
              <li key={x.id}>
                <span className="font-medium">{x.name}</span> <Badge tone={x.status === "available" ? "success" : "warning"}>{x.status.replace("_", " ")}</Badge>
                <p className="break-all font-mono text-xs text-muted">OAuth redirect: {x.redirectUri}</p>
                {x.webhookUrl && <p className="break-all font-mono text-xs text-muted">Webhooks: {x.webhookUrl}</p>}
              </li>
            ))}
            <li>
              <span className="font-medium">Stripe</span> <Badge tone={c.billing.stripeConfigured && c.billing.webhookConfigured ? "success" : "warning"}>{c.billing.stripeConfigured ? (c.billing.webhookConfigured ? "configured" : "webhook secret missing") : "not configured"}</Badge>
              <p className="break-all font-mono text-xs text-muted">Webhook endpoint: {c.billing.webhookUrl} (events: checkout.session.completed, customer.subscription.*, invoice.payment_failed)</p>
              <p className="text-xs text-muted">Prices: {c.billing.prices.map((p: any) => `${p.plan} ${p.configured ? "✓" : "missing"}`).join(" · ")}</p>
            </li>
          </ul>
        </Card>
      </div>
    )}</Loading>
  );
}

// ------------------------------------------------------------------ audit

function Audit({ workspaceId }: { workspaceId: string | null }) {
  const [actorType, setActorType] = useState("");
  const [action, setAction] = useState("");
  const qs = new URLSearchParams({ ...(workspaceId ? { workspaceId } : {}), ...(actorType ? { actorType } : {}), ...(action ? { action } : {}) }).toString();
  const q = useAdmin<any[]>(`audit?${qs}`, ["audit", qs]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Actor">{(p) => <Select {...p} value={actorType} onChange={(e) => setActorType(e.target.value)}><option value="">Everyone</option><option value="user">Customers</option><option value="support">Platform staff</option><option value="system">System</option></Select>}</Field>
        <Field label="Action starts with">{(p) => <Input {...p} placeholder="e.g. support. or billing." value={action} onChange={(e) => setAction(e.target.value)} />}</Field>
        {workspaceId && <Link to="?tab=audit" className="pb-2 text-sm text-accent hover:underline">Clear workspace filter</Link>}
      </div>
      <Loading q={q}>{(rows) => (
        <Table head={["When", "Actor", "Action", "Customer", "Details"]} empty="No audit entries match.">
          {rows.map((a) => (
            <tr key={a.id}>
              <td className={cn(td, "whitespace-nowrap text-muted")} title={a.created_at}>{when(a.created_at)}</td>
              <td className={td}>{a.actor_email ?? <span className="text-muted">{a.actor_type}</span>}{a.actor_type === "support" && <Badge tone="violet" className="ml-1.5">staff</Badge>}</td>
              <td className={cn(td, "font-mono text-xs")}>{a.action}</td>
              <td className={td}>{a.workspace_name ?? "—"}<p className="text-xs text-muted">{a.business_name}</p></td>
              <td className={cn(td, "max-w-[360px] break-words font-mono text-[11px] text-muted")}>{Object.keys(a.metadata ?? {}).length ? JSON.stringify(a.metadata) : a.target_type ? `${a.target_type} ${a.target_id ?? ""}` : ""}</td>
            </tr>
          ))}
        </Table>
      )}</Loading>
    </div>
  );
}

// ------------------------------------------------------------------ support access

function Support() {
  const q = useAdmin<any[]>("support-access");
  const qc = useQueryClient();
  const toast = useToast();
  const revoke = useMutation({ mutationFn: (id: string) => post(`/admin/support-access/${id}/revoke`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin"] }); toast("Access ended"); }, onError: (e) => toast(errorMessage(e), "error") });
  return (
    <div className="space-y-4">
      <Prerequisite title="How support access works">Open it from a customer's page with a reason. You get read-only access to that workspace's businesses until it expires (at most 4 hours). The owners are notified, can end it, and every page you open is written to their audit log. The assistant, exports and all changes stay blocked.</Prerequisite>
      <Loading q={q}>{(rows) => (
        <Table head={["Customer", "Staff", "Reason", "Status", "Open", ""]} empty="No support access has been requested.">
          {rows.map((g) => {
            const active = !g.revoked_at && new Date(g.expires_at) > new Date();
            return (
              <tr key={g.id}>
                <td className={cn(td, "font-medium")}>{g.workspace_name}</td>
                <td className={cn(td, "text-muted")}>{g.admin_email}</td>
                <td className={cn(td, "max-w-[280px] break-words")}>{g.reason}</td>
                <td className={td}>{active ? <Badge tone="warning">Active · until {new Date(g.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Badge> : <Badge>{g.revoked_at ? "Revoked" : "Expired"}</Badge>}</td>
                <td className={td}>{active && g.mine && (g.businesses ?? []).map((b: any) => <Link key={b.id} to={`/app/b/${b.id}`} className="mr-2 inline-flex items-center gap-1 text-sm text-accent hover:underline">{b.name}<ExternalLink className="size-3" /></Link>)}</td>
                <td className={td}>{active && <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === g.id} onClick={() => revoke.mutate(g.id)}>End now</Button>}</td>
              </tr>
            );
          })}
        </Table>
      )}</Loading>
    </div>
  );
}

