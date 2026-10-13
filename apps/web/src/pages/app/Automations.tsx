import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarClock, Check, History, Pencil, Play, Plus, RotateCcw, ShieldCheck, Trash2, X, Zap } from "lucide-react";
import { AUTOMATION_KINDS, can, type Automation, type AutomationInput, type AutomationKind, type AutomationRun } from "@bca/shared";
import { ApiError, del, errorMessage, get, post, put } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { cn } from "@/lib/cn";
import { k, useAutomations, useMembers, useRun, useRuns } from "@/lib/insights";
import { useCatalog } from "@/lib/metrics";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorState, Prerequisite } from "@/components/ui/EmptyState";
import { Field, Input, Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/components/widgets/WidgetFrame";
import { MetricSelect } from "@/components/dashboard/pickers";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RUN_TONE: Record<AutomationRun["status"], "neutral" | "accent" | "success" | "danger" | "warning" | "violet"> = {
  queued: "neutral", running: "accent", succeeded: "success", failed: "danger", skipped: "neutral", awaiting_approval: "violet", rejected: "warning",
};
const RUN_LABEL: Record<AutomationRun["status"], string> = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", skipped: "Skipped", awaiting_approval: "Awaiting approval", rejected: "Rejected" };

function describeTrigger(a: Pick<Automation, "trigger" | "timezone">) {
  const t = a.trigger;
  if (t.type === "event") return t.event === "connection_failed" ? "When a connection fails" : "When new insights are detected";
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  if (t.frequency === "hourly") return `Every hour at :${String(t.minute).padStart(2, "0")}`;
  return `${t.frequency === "weekly" ? `Every ${WEEKDAYS[t.weekday]}` : "Every day"} at ${time} (${a.timezone.replace(/_/g, " ")})`;
}

const DEFAULTS: Record<AutomationKind, AutomationInput> = {
  daily_briefing: { name: "Daily briefing", kind: "daily_briefing", trigger: { type: "schedule", frequency: "daily", hour: 8, minute: 0 } },
  weekly_report: { name: "Weekly report", kind: "weekly_report", trigger: { type: "schedule", frequency: "weekly", weekday: 1, hour: 8, minute: 0 } },
  threshold_alert: { name: "Sales alert", kind: "threshold_alert", trigger: { type: "schedule", frequency: "daily", hour: 7, minute: 0 }, conditions: { metric: "", window: "yesterday", test: "below", value: 0 } },
  connection_alert: { name: "Connection failure alerts", kind: "connection_alert", trigger: { type: "event", event: "connection_failed" } },
  insight_tasks: { name: "Tasks from insights", kind: "insight_tasks", trigger: { type: "event", event: "insights_detected" }, conditions: { minSeverity: "warning" }, actions: { task: { assigneeId: null } } },
};

export function Automations() {
  const b = useBusiness();
  const list = useAutomations(b.id);
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<{ open: boolean; automation: Automation | null; kind: AutomationKind | null }>({ open: false, automation: null, kind: null });
  const [historyFor, setHistoryFor] = useState<Automation | null>(null);
  const runParam = params.get("run");
  const write = can(b.role, "automation.write");
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: k.automations(b.id) });
  const runNow = useMutation({
    mutationFn: (id: string) => post<{ runId: string | null; duplicate: boolean }>(`/businesses/${b.id}/automations/${id}/run`),
    onSuccess: (r, id) => { toast(r.duplicate ? "Already running — one manual run per minute." : "Run started"); refresh(); qc.invalidateQueries({ queryKey: k.runs(b.id, id) }); setHistoryFor(list.data?.automations.find((a) => a.id === id) ?? null); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const toggle = useMutation({
    mutationFn: (a: Automation) => put(`/businesses/${b.id}/automations/${a.id}`, { ...toInput(a), enabled: !a.enabled }),
    onSuccess: refresh, onError: (e) => toast(errorMessage(e), "error"),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/businesses/${b.id}/automations/${id}`), onSuccess: () => { refresh(); toast("Automation deleted"); }, onError: (e) => toast(errorMessage(e), "error") });
  const existingKinds = new Set(list.data?.automations.map((a) => a.kind));

  return (
    <>
      <PageHeader title="Automations" description={`Scheduled briefings and reports, alerts and task creation for ${b.name}. Every run is recorded; duplicates are prevented.`}
        actions={write && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ open: true, automation: null, kind: null })}>New automation</Button>} />
      {list.isLoading ? <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-28" />)}</div>
        : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : (
          <div className="space-y-6">
            {list.data!.automations.length > 0 && (
              <ul className="grid gap-3 lg:grid-cols-2">
                {list.data!.automations.map((a) => (
                  <li key={a.id} className={cn("panel p-4", !a.enabled && "opacity-70")}>
                    <div className="flex items-start gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">{a.trigger.type === "event" ? <Zap className="size-4" /> : <CalendarClock className="size-4" />}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold">{a.name}</h3>
                          <Badge>{AUTOMATION_KINDS[a.kind].label}</Badge>
                          {!a.enabled && <Badge tone="warning">Paused</Badge>}
                          {a.approvalPolicy === "approval_required" && <Badge tone="violet" icon={<ShieldCheck className="size-3" />}>Needs approval</Badge>}
                        </div>
                        <p className="mt-1 text-sm text-muted">{describeTrigger(a)}</p>
                        <p className="mt-1 text-xs text-subtle">
                          {a.lastRun ? <>Last run {relativeTime(a.lastRun.createdAt)}: <span className={cn(a.lastRun.status === "failed" && "text-danger")}>{RUN_LABEL[a.lastRun.status]}</span>{a.lastRun.output.summary ? ` — ${a.lastRun.output.summary}` : ""}</> : "Not run yet"}
                          {a.enabled && a.nextRunAt && <> · next {new Date(a.nextRunAt).toLocaleString()}</>}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 pl-12">
                      <Button size="sm" variant="secondary" icon={<History className="size-4" />} onClick={() => setHistoryFor(a)}>Run history</Button>
                      {write && a.trigger.type === "schedule" && <Button size="sm" variant="secondary" icon={<Play className="size-4" />} loading={runNow.isPending && runNow.variables === a.id} onClick={() => runNow.mutate(a.id)}>Run now</Button>}
                      {write && <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing({ open: true, automation: a, kind: a.kind })}>Edit</Button>}
                      {write && <Button size="sm" variant="ghost" onClick={() => toggle.mutate(a)}>{a.enabled ? "Pause" : "Resume"}</Button>}
                      {write && <IconButton label={`Delete ${a.name}`} size="sm" onClick={() => { if (confirm(`Delete "${a.name}"? Its run history is deleted too.`)) remove.mutate(a.id); }}><Trash2 className="size-4" /></IconButton>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <section aria-labelledby="recommended-h">
              <h2 id="recommended-h" className="mb-3 text-[15px] font-semibold">{list.data!.automations.length ? "Add another" : "Start with a recommended automation"}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(Object.keys(AUTOMATION_KINDS) as AutomationKind[]).map((kind) => (
                  <li key={kind} className="panel flex flex-col p-4">
                    <p className="font-medium">{AUTOMATION_KINDS[kind].label}{existingKinds.has(kind) && <span className="ml-2 text-xs text-subtle">(already set up)</span>}</p>
                    <p className="mt-1 flex-1 text-sm text-muted">{AUTOMATION_KINDS[kind].description}</p>
                    {write ? <Button size="sm" variant="secondary" className="mt-3 self-start" icon={<Plus className="size-4" />} onClick={() => setEditing({ open: true, automation: null, kind })}>Set up</Button>
                      : <p className="mt-3 text-xs text-subtle">Analysts and administrators can set this up.</p>}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      {editing.open && <AutomationEditor initial={editing.automation} kind={editing.kind} emailConfigured={list.data?.emailConfigured ?? false} timezone={list.data?.timezone ?? b.timezone} onClose={() => setEditing({ open: false, automation: null, kind: null })} onSaved={() => { refresh(); setEditing({ open: false, automation: null, kind: null }); }} />}
      <HistoryDialog automation={historyFor} onClose={() => setHistoryFor(null)} />
      <RunDialog runId={runParam} onClose={() => setParams({})} />
    </>
  );
}

function toInput(a: Automation): AutomationInput {
  return { name: a.name, kind: a.kind, enabled: a.enabled, trigger: a.trigger, conditions: a.conditions, scope: a.scope, actions: a.actions, timezone: a.timezone, approvalPolicy: a.approvalPolicy };
}

function AutomationEditor({ initial, kind: kind0, emailConfigured, timezone, onClose, onSaved }: { initial: Automation | null; kind: AutomationKind | null; emailConfigured: boolean; timezone: string; onClose: () => void; onSaved: () => void }) {
  const b = useBusiness();
  const toast = useToast();
  const catalog = useCatalog(b.id);
  const members = useMembers(b.id);
  const connections = useQuery({ queryKey: ["b", b.id, "connections"], queryFn: ({ signal }) => get<any[]>(`/businesses/${b.id}/connections`, signal) });
  const [kind, setKind] = useState<AutomationKind | null>(initial?.kind ?? kind0);
  const [f, setF] = useState<AutomationInput | null>(initial ? toInput(initial) : kind0 ? { ...DEFAULTS[kind0], timezone } : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (kind && !f) setF({ ...DEFAULTS[kind], timezone }); }, [kind]);
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf("timeZone") as string[]; } catch { return [timezone]; } }, [timezone]);
  const save = useMutation({
    mutationFn: () => (initial ? put(`/businesses/${b.id}/automations/${initial.id}`, f) : post(`/businesses/${b.id}/automations`, f)),
    onSuccess: () => { toast(initial ? "Automation saved" : "Automation created", "success"); onSaved(); },
    onError: (e) => setError(e instanceof ApiError && e.details ? `${e.message} ${formatIssues(e.details)}` : errorMessage(e)),
  });

  if (!kind || !f) {
    return (
      <Dialog open onClose={onClose} title="New automation" description="Choose what it should do.">
        <ul className="grid gap-2">
          {(Object.keys(AUTOMATION_KINDS) as AutomationKind[]).map((k2) => (
            <li key={k2}><button type="button" onClick={() => { setKind(k2); setF({ ...DEFAULTS[k2], timezone }); }} className="w-full rounded-lg border border-line p-3 text-left hover:border-accent/40"><span className="font-medium">{AUTOMATION_KINDS[k2].label}</span><span className="block text-sm text-muted">{AUTOMATION_KINDS[k2].description}</span></button></li>
          ))}
        </ul>
      </Dialog>
    );
  }
  const t = f.trigger;
  const cond = (f.conditions ?? {}) as Record<string, any>;
  const actions = f.actions ?? { notify: { userIds: [], email: false }, task: null };
  const notify = actions.notify ?? { userIds: [], email: false };
  const set = (patch: Partial<AutomationInput>) => setF({ ...f, ...patch });
  const setCond = (patch: Record<string, unknown>) => set({ conditions: { ...cond, ...patch } });
  const setActions = (patch: Partial<NonNullable<AutomationInput["actions"]>>) => set({ actions: { ...actions, ...patch } as any });
  const scheduleOptions = kind === "daily_briefing" ? ["daily"] : kind === "weekly_report" ? ["weekly"] : ["hourly", "daily", "weekly"];

  return (
    <Dialog open onClose={onClose} size="lg" title={initial ? `Edit ${initial.name}` : `New ${AUTOMATION_KINDS[kind].label.toLowerCase()}`} description={AUTOMATION_KINDS[kind].description}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(null); save.mutate(); }}>{initial ? "Save" : "Create automation"}</Button></>}>
      <div className="space-y-5">
        {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#fecaca]">{error}</p>}
        <Field label="Name">{(p) => <Input {...p} data-autofocus value={f.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />}</Field>

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold">Trigger</legend>
          {t.type === "event" ? (
            <p className="text-sm text-muted">{t.event === "connection_failed" ? "Runs when one of this business's connections fails or needs to be reconnected." : "Runs when the daily or post-sync check finds new insights."}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Repeats">{(p) => <Select {...p} value={t.frequency} onChange={(e) => set({ trigger: { ...t, frequency: e.target.value as any } })}>{scheduleOptions.map((o) => <option key={o} value={o}>{o === "hourly" ? "Hourly" : o === "daily" ? "Daily" : "Weekly"}</option>)}</Select>}</Field>
              {t.frequency === "weekly" && <Field label="Day">{(p) => <Select {...p} value={t.weekday ?? 1} onChange={(e) => set({ trigger: { ...t, weekday: Number(e.target.value) } })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>}</Field>}
              {t.frequency !== "hourly" && <Field label="Hour">{(p) => <Select {...p} value={t.hour ?? 8} onChange={(e) => set({ trigger: { ...t, hour: Number(e.target.value) } })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</Select>}</Field>}
              <Field label="Minute">{(p) => <Select {...p} value={t.minute ?? 0} onChange={(e) => set({ trigger: { ...t, minute: Number(e.target.value) } })}>{[0, 15, 30, 45].map((m) => <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>)}</Select>}</Field>
              <Field label="Timezone" className="sm:col-span-4">{(p) => <Select {...p} value={f.timezone ?? timezone} onChange={(e) => set({ timezone: e.target.value })}>{[...new Set([timezone, ...zones])].map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select>}</Field>
            </div>
          )}
        </fieldset>

        {kind === "threshold_alert" && (
          <fieldset className="space-y-3">
            <legend className="text-[13px] font-semibold">Condition</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Metric">{(p) => <MetricSelect {...p} catalog={catalog.data} value={cond.metric ?? ""} allowEmpty onChange={(v) => setCond({ metric: v })} />}</Field>
              <Field label="Period">{(p) => <Select {...p} value={cond.window ?? "yesterday"} onChange={(e) => setCond({ window: e.target.value })}><option value="yesterday">Yesterday</option><option value="last_7_days">Last 7 days</option><option value="last_30_days">Last 30 days</option><option value="month_to_date">Month to date</option></Select>}</Field>
              <Field label="Alert when">{(p) => <Select {...p} value={cond.test ?? "below"} onChange={(e) => setCond({ test: e.target.value })}><option value="below">Value is below</option><option value="above">Value is above</option><option value="change_down_pct">Falls by at least (%)</option><option value="change_up_pct">Rises by at least (%)</option></Select>}</Field>
              <Field label={String(cond.test).startsWith("change") ? "Percent vs previous period" : "Value"}>{(p) => <Input {...p} type="number" step="any" value={cond.value ?? 0} onChange={(e) => setCond({ value: Number(e.target.value) })} />}</Field>
            </div>
            <p className="text-xs text-subtle">Evaluated only over complete data: if the period is missing or partly covered, the run records "not evaluated" instead of alerting.</p>
          </fieldset>
        )}
        {kind === "insight_tasks" && (
          <Field label="Minimum severity">{(p) => <Select {...p} value={cond.minSeverity ?? "warning"} onChange={(e) => setCond({ minSeverity: e.target.value })}><option value="warning">Needs attention or critical</option><option value="critical">Critical only</option></Select>}</Field>
        )}

        {(kind === "threshold_alert" || kind === "connection_alert") && (
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-semibold">Scope</legend>
            {kind === "connection_alert" ? (
              connections.data?.length ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-subtle">Leave all unticked to cover every connection.</p>
                  {connections.data.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[#22d3ee]" checked={(f.scope?.connectionIds ?? []).includes(c.id)}
                      onChange={(e) => { const ids = new Set(f.scope?.connectionIds ?? []); e.target.checked ? ids.add(c.id) : ids.delete(c.id); set({ scope: { sources: f.scope?.sources ?? [], connectionIds: [...ids] } }); }} />{c.providerName ?? c.provider} · {c.accountName ?? c.displayName}</label>
                  ))}
                </div>
              ) : <p className="text-sm text-muted">Applies to every connection added to this business.</p>
            ) : <p className="text-sm text-muted">Uses the business's preferred source for the metric (sources are never added together).</p>}
          </fieldset>
        )}

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold">Actions</legend>
          {kind !== "insight_tasks" && (
            <div className="space-y-2">
              <p className="text-sm">In-app notification to:</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {members.data?.map((m) => (
                  <label key={m.userId} className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[#22d3ee]" checked={notify.userIds?.includes(m.userId) ?? false}
                    onChange={(e) => { const ids = new Set(notify.userIds ?? []); e.target.checked ? ids.add(m.userId) : ids.delete(m.userId); setActions({ notify: { ...notify, userIds: [...ids] } }); }} />{m.name} <span className="text-subtle">({m.role})</span></label>
                ))}
              </div>
              <p className="text-xs text-subtle">Nobody ticked = the business's owners and administrators.</p>
              <label className={cn("flex items-center gap-2 text-sm", !emailConfigured && "opacity-60")}><input type="checkbox" className="accent-[#22d3ee]" disabled={!emailConfigured && !notify.email} checked={notify.email ?? false} onChange={(e) => setActions({ notify: { ...notify, email: e.target.checked } })} />Also send by email</label>
              {!emailConfigured && <p className="text-xs text-subtle">Email needs the platform operator to configure SMTP (SMTP_URL). Until then only in-app notifications are sent.</p>}
            </div>
          )}
          {kind !== "daily_briefing" && kind !== "weekly_report" && (
            <div className="space-y-2">
              {kind !== "insight_tasks" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[#22d3ee]" checked={Boolean(actions.task)} onChange={(e) => setActions({ task: e.target.checked ? { assigneeId: null } : null })} />Create an internal task</label>}
              {actions.task && (
                <Field label="Assign tasks to">{(p) => <Select {...p} value={actions.task?.assigneeId ?? ""} onChange={(e) => setActions({ task: { assigneeId: e.target.value || null } })}><option value="">Unassigned</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select>}</Field>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold">Approval</legend>
          <label className="flex items-start gap-2 text-sm"><input type="radio" name="approval" className="mt-1 accent-[#22d3ee]" checked={f.approvalPolicy !== "approval_required"} onChange={() => set({ approvalPolicy: "auto" })} /><span>Run automatically<span className="block text-xs text-subtle">Notifications, emails and tasks go out as soon as the run finishes.</span></span></label>
          <label className="flex items-start gap-2 text-sm"><input type="radio" name="approval" className="mt-1 accent-[#22d3ee]" checked={f.approvalPolicy === "approval_required"} onChange={() => set({ approvalPolicy: "approval_required" })} /><span>Require approval<span className="block text-xs text-subtle">The run prepares everything (reports are still created), then waits for an administrator to approve before anything is sent.</span></span></label>
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[#22d3ee]" checked={f.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
      </div>
    </Dialog>
  );
}

const formatIssues = (d: unknown) => Array.isArray(d) ? d.map((i: any) => i.message).join("; ") : "";

function RunRow({ run, onOpen }: { run: AutomationRun; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5">
        <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
        <span className="min-w-0 flex-1 text-sm"><span className="block text-muted">{run.output.summary ?? run.error ?? (run.triggerInfo.manual ? "Manual run" : "Scheduled run")}</span><span className="text-xs text-subtle">{new Date(run.createdAt).toLocaleString()}{run.attempts > 1 ? ` · ${run.attempts} attempts` : ""}</span></span>
      </button>
    </li>
  );
}

function HistoryDialog({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const b = useBusiness();
  const runs = useRuns(b.id, automation?.id ?? null);
  const [, setParams] = useSearchParams();
  return (
    <Dialog open={Boolean(automation)} onClose={onClose} title={`Run history · ${automation?.name ?? ""}`} description="Every run, its trigger and result. Runs retry automatically on temporary failures.">
      {runs.isLoading ? <Skeleton className="h-24" /> : !runs.data?.length ? <p className="text-sm text-muted">No runs yet.</p> : (
        <ul className="-mx-2 max-h-[60vh] space-y-0.5 overflow-y-auto">{runs.data.map((r) => <RunRow key={r.id} run={r} onOpen={() => { onClose(); setParams({ run: r.id }); }} />)}</ul>
      )}
    </Dialog>
  );
}

function RunDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const b = useBusiness();
  const run = useRun(b.id, runId);
  const qc = useQueryClient();
  const toast = useToast();
  const act = useMutation({
    mutationFn: (a: "approve" | "reject" | "retry") => post(`/businesses/${b.id}/automation-runs/${runId}/${a}`),
    onSuccess: (_r, a) => { toast(a === "approve" ? "Approved — actions sent" : a === "reject" ? "Rejected — nothing was sent" : "Retry queued"); qc.invalidateQueries({ queryKey: ["b", b.id, "automations"] }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const r = run.data;
  const pending = (r?.pendingActions ?? {}) as { notify?: { userIds: string[]; title: string }; email?: { subject: string }; tasks?: { title: string }[] };
  return (
    <Dialog open={Boolean(runId)} onClose={onClose} title="Automation run" footer={
      r?.status === "awaiting_approval" && can(b.role, "action.approve") ? <><Button variant="ghost" icon={<X className="size-4" />} loading={act.isPending && act.variables === "reject"} onClick={() => act.mutate("reject")}>Reject</Button><Button variant="primary" icon={<Check className="size-4" />} loading={act.isPending && act.variables === "approve"} onClick={() => act.mutate("approve")}>Approve and send</Button></>
        : r?.status === "failed" && can(b.role, "automation.write") ? <Button variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => act.mutate("retry")}>Retry</Button>
        : <Button onClick={onClose}>Close</Button>}>
      {run.isLoading ? <Skeleton className="h-24" /> : run.error ? <ErrorState error={run.error} /> : r && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge><span className="text-subtle">{new Date(r.createdAt).toLocaleString()} · {r.attempts} attempt{r.attempts === 1 ? "" : "s"}</span></div>
          {r.output.summary && <p>{r.output.summary}</p>}
          {r.error && <p className="text-danger">{r.error}</p>}
          {r.output.reportId && <Link className="text-accent underline" to={`/app/b/${b.id}/reports/${r.output.reportId}`}>Open the report</Link>}
          {r.output.emailSkipped && <p className="text-xs text-subtle">{r.output.emailSkipped}</p>}
          {r.status === "awaiting_approval" && (
            <Prerequisite title="Waiting for approval">
              <ul className="list-disc space-y-1 pl-5">
                {pending.notify && <li>In-app notification "{pending.notify.title}" to {pending.notify.userIds.length} people</li>}
                {pending.email && <li>Email "{pending.email.subject}"</li>}
                {pending.tasks?.map((t) => <li key={t.title}>Create task "{t.title}"</li>)}
              </ul>
              {!can(b.role, "action.approve") && <p className="mt-2">Only administrators can approve.</p>}
            </Prerequisite>
          )}
          {r.decidedBy && <p className="text-xs text-subtle">{r.status === "rejected" ? "Rejected" : "Approved"} by {r.decidedBy} {r.decidedAt ? relativeTime(r.decidedAt) : ""}</p>}
          {typeof r.output.notified === "number" && <p className="flex items-center gap-1.5 text-xs text-subtle"><Bell className="size-3.5" />{r.output.notified} notification{r.output.notified === 1 ? "" : "s"} sent{r.output.taskIds?.length ? ` · ${r.output.taskIds.length} task(s) created` : ""}</p>}
        </div>
      )}
    </Dialog>
  );
}


