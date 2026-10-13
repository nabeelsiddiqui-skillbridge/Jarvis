import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, ClipboardList, Lightbulb, Plus, RefreshCw, Trash2 } from "lucide-react";
import { can, type Task } from "@bca/shared";
import { del, errorMessage, patch, post } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { cn } from "@/lib/cn";
import { useInsights, useMembers, useTasks } from "@/lib/insights";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState } from "@/components/ui/EmptyState";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/components/widgets/WidgetFrame";
import { InsightCard } from "@/components/insights/InsightCard";

export function Insights() {
  const b = useBusiness();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "tasks" ? "tasks" : "insights";
  return (
    <>
      <PageHeader title="Insights" description={`Findings from ${b.name}'s connected data, computed by fixed rules. AI only adds clearly labelled explanations.`}
        actions={<Tabs value={tab} onChange={(v) => setParams(v === "tasks" ? { tab: "tasks" } : {})} items={[{ value: "insights", label: "Insights" }, { value: "tasks", label: "Tasks" }]} />} />
      {tab === "insights" ? <InsightList /> : <TaskList />}
    </>
  );
}

function InsightList() {
  const b = useBusiness();
  const [status, setStatus] = useState("open");
  const list = useInsights(b.id, status);
  const qc = useQueryClient();
  const toast = useToast();
  const detect = useMutation({
    mutationFn: () => post<{ created: number; resolved: number; candidates: number }>(`/businesses/${b.id}/insights/detect`),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["b", b.id, "insights"] }); toast(r.created ? `${r.created} new insight${r.created > 1 ? "s" : ""}` : "No new insights — existing ones were refreshed", r.created ? "success" : "info"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const counts = list.data?.counts ?? {};
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={status} onChange={setStatus} items={[
          { value: "open", label: `Open${counts.open ? ` (${counts.open})` : ""}` },
          { value: "acknowledged", label: "Acknowledged" },
          { value: "resolved", label: "Resolved" },
          { value: "dismissed", label: "Dismissed" },
          { value: "all", label: "All" },
        ]} />
        <div className="flex items-center gap-3">
          {list.data?.lastDetectedAt && <span className="text-xs text-subtle">Last checked {relativeTime(list.data.lastDetectedAt)}</span>}
          {can(b.role, "insight.manage") && <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={detect.isPending} onClick={() => detect.mutate()}>Check now</Button>}
        </div>
      </div>
      {list.isLoading ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}</div>
        : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : !list.data?.insights.length ? (
          <EmptyState icon={<Lightbulb className="size-5" />} title={status === "open" ? "No open insights" : "Nothing here"}>
            Insights appear when the rules find a significant change over complete periods (for example a 15%+ week-over-week move with enough volume), an unusual day, a goal off pace, or a data connection problem. They're checked daily and after each sync.
          </EmptyState>
        ) : (
          <div className="space-y-3">{list.data.insights.map((i) => <InsightCard key={i.id} business={b} insight={i} compact={list.data!.insights.length > 3} />)}</div>
        )}
      {list.data && !list.data.aiConfigured && <p className="text-xs text-subtle">AI explanations are off: the platform has no AI provider key (ANTHROPIC_API_KEY). Findings are complete without them.</p>}
    </div>
  );
}

function TaskList() {
  const b = useBusiness();
  const [status, setStatus] = useState("open");
  const tasks = useTasks(b.id, status);
  const members = useMembers(b.id);
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can(b.role, "insight.manage");
  const refresh = () => qc.invalidateQueries({ queryKey: ["b", b.id, "tasks"] });
  const update = useMutation({ mutationFn: ({ id, ...body }: { id: string; status?: string; assigneeId?: string | null }) => patch(`/businesses/${b.id}/tasks/${id}`, body), onSuccess: refresh, onError: (e) => toast(errorMessage(e), "error") });
  const remove = useMutation({ mutationFn: (id: string) => del(`/businesses/${b.id}/tasks/${id}`), onSuccess: refresh, onError: (e) => toast(errorMessage(e), "error") });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={status} onChange={setStatus} items={[{ value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "all", label: "All" }]} />
        {manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New task</Button>}
      </div>
      {tasks.isLoading ? <Skeleton className="h-40" /> : tasks.error ? <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
        : !tasks.data?.length ? (
          <EmptyState icon={<ClipboardList className="size-5" />} title={status === "open" ? "No open tasks" : "No tasks"}>
            Tasks are created from insights ("Create task"), by the "Tasks from insights" automation, by threshold and connection alerts, or manually.
          </EmptyState>
        ) : (
          <ul className="panel divide-y divide-line">
            {tasks.data.map((t: Task) => (
              <li key={t.id} className="flex items-start gap-3 p-4">
                <button type="button" onClick={() => update.mutate({ id: t.id, status: t.status === "done" ? "open" : "done" })} aria-label={t.status === "done" ? `Reopen "${t.title}"` : `Mark "${t.title}" done`} className="mt-0.5 text-subtle hover:text-success">
                  {t.status === "done" ? <CheckCircle2 className="size-5 text-success" /> : <Circle className="size-5" />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className={cn("font-medium", t.status === "done" && "text-muted line-through")}>{t.title}</p>
                  {t.description && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-sm text-muted">{t.description}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-subtle">
                    <Badge>{t.source === "automation" ? "From automation" : t.source === "insight" ? "From insight" : "Manual"}</Badge>
                    {t.dueDate && <span>Due {t.dueDate}</span>}
                    <span>Created {relativeTime(t.createdAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {manage ? (
                    <Select aria-label={`Assignee for "${t.title}"`} value={t.assigneeId ?? ""} onChange={(e) => update.mutate({ id: t.id, assigneeId: e.target.value || null })} className="h-8 w-40 text-xs">
                      <option value="">Unassigned</option>
                      {members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                    </Select>
                  ) : <span className="text-xs text-muted">{t.assigneeName ?? "Unassigned"}</span>}
                  {manage && <IconButton label={`Delete "${t.title}"`} size="sm" onClick={() => remove.mutate(t.id)}><Trash2 className="size-4" /></IconButton>}
                </div>
              </li>
            ))}
          </ul>
        )}
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function NewTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const b = useBusiness();
  const members = useMembers(b.id);
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ title: "", description: "", assigneeId: "", dueDate: "" });
  const create = useMutation({
    mutationFn: () => post(`/businesses/${b.id}/tasks`, { title: f.title, description: f.description, assigneeId: f.assigneeId || null, dueDate: f.dueDate || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["b", b.id, "tasks"] }); setF({ title: "", description: "", assigneeId: "", dueDate: "" }); onClose(); toast("Task created", "success"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <Dialog open={open} onClose={onClose} title="New task" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!f.title.trim()} onClick={() => create.mutate()}>Create task</Button></>}>
      <div className="space-y-4">
        <Field label="Title">{(p) => <Input {...p} data-autofocus value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
        <Field label="Details" optional>{(p) => <Textarea {...p} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assignee" optional>{(p) => <Select {...p} value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}><option value="">Unassigned</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select>}</Field>
          <Field label="Due date" optional>{(p) => <Input {...p} type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}
