import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { BUSINESS_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, can, type Goal } from "@bca/shared";
import { del, get, patch, post, put, errorMessage } from "@/lib/api";
import { keys, useBusiness } from "@/lib/business";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Prerequisite } from "@/components/ui/EmptyState";
import { Field, Input, Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { UserAvatar } from "@/components/ui/Avatar";
import { BusinessForm } from "@/components/business/BusinessForm";

export function BusinessSettings() {
  const b = useBusiness();
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
  }, []);
  return (
    <>
      <PageHeader title="Business settings" description={`Profile, goals, access and data controls for ${b.name}.`} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Profile />
        <Goals />
        <Access />
        <Activity />
        <Danger />
      </div>
    </>
  );
}

function Profile() {
  const b = useBusiness();
  const qc = useQueryClient();
  const toast = useToast();
  if (!can(b.role, "business.update")) {
    return (
      <Card title="Profile">
        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt><dd>{b.name}</dd>
          <dt className="text-muted">Website</dt><dd>{b.website ?? "—"}</dd>
          <dt className="text-muted">Timezone</dt><dd>{b.timezone}</dd>
          <dt className="text-muted">Currency</dt><dd>{b.currency}</dd>
        </dl>
        <p className="mt-4 text-xs text-subtle">Only business administrators can edit the profile.</p>
      </Card>
    );
  }
  return (
    <Card title="Profile" description="Timezone and currency define how periods and totals are reported.">
      <BusinessForm
        initial={b}
        submitLabel="Save changes"
        onSubmit={async (v) => {
          await patch(`/businesses/${b.id}`, v);
          await qc.invalidateQueries({ queryKey: keys.business(b.id) });
          await qc.invalidateQueries({ queryKey: keys.businesses(b.workspaceId) });
          toast("Business updated");
        }}
      />
    </Card>
  );
}

function Goals() {
  const b = useBusiness();
  const qc = useQueryClient();
  const toast = useToast();
  const goals = useQuery({ queryKey: keys.goals(b.id), queryFn: ({ signal }) => get<Goal[]>(`/businesses/${b.id}/goals`, signal) });
  const [draft, setDraft] = useState({ title: "", targetValue: "", period: "month" });
  const editable = can(b.role, "goals.write");
  const add = useMutation({
    mutationFn: () => post(`/businesses/${b.id}/goals`, { title: draft.title, targetValue: draft.targetValue ? Number(draft.targetValue) : null, period: draft.period }),
    onSuccess: () => {
      setDraft({ title: "", targetValue: "", period: "month" });
      qc.invalidateQueries({ queryKey: keys.goals(b.id) });
      toast("Goal added");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/businesses/${b.id}/goals/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.goals(b.id) }),
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <section id="goals" className="scroll-mt-24">
      <Card title="Goals" description="Confirmed by people on your team. The assistant may suggest goals but never saves them without confirmation.">
        {goals.isPending ? <Skeleton className="h-20" /> : (
          <ul className="divide-y divide-line">
            {goals.data?.map((g) => (
              <li key={g.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="flex-1">{g.title}</span>
                <span className="text-muted">{g.targetValue != null ? `${new Intl.NumberFormat().format(g.targetValue)} / ${g.period}` : g.period}</span>
                {editable && <Button size="sm" variant="ghost" aria-label={`Delete goal ${g.title}`} onClick={() => remove.mutate(g.id)}><Trash2 className="size-4" /></Button>}
              </li>
            ))}
            {!goals.data?.length && <li className="py-3 text-sm text-muted">No goals yet.</li>}
          </ul>
        )}
        {editable ? (
          <form className="mt-4 grid grid-cols-[1fr_1fr_auto] items-end gap-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field label="New goal" className="col-span-3">{(p) => <Input {...p} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Reach 500 orders" />}</Field>
            <Field label="Target" optional>{(p) => <Input {...p} inputMode="decimal" value={draft.targetValue} onChange={(e) => setDraft({ ...draft, targetValue: e.target.value.replace(/[^0-9.]/g, "") })} />}</Field>
            <Field label="Per">{(p) => <Select {...p} value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value })}><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></Select>}</Field>
            <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={add.isPending} disabled={!draft.title.trim()}>Add</Button>
          </form>
        ) : <p className="mt-3 text-xs text-subtle">Viewers can't change goals.</p>}
      </Card>
    </section>
  );
}

interface AccessRow { userId: string; name: string; email: string; workspaceRole: string; role: string | null }

function Access() {
  const b = useBusiness();
  const qc = useQueryClient();
  const toast = useToast();
  const rows = useQuery({ queryKey: keys.access(b.id), queryFn: ({ signal }) => get<AccessRow[]>(`/businesses/${b.id}/access`, signal) });
  const manage = can(b.role, "business.members.manage");
  const change = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string | null }) => put(`/businesses/${b.id}/access/${userId}`, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.access(b.id) });
      toast("Access updated");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <Card title="Access" description="Who can see this business. Invite new people from Workspace › Team.">
      {rows.isPending ? <Skeleton className="h-24" /> : (
        <ul className="divide-y divide-line">
          {rows.data?.map((r) => (
            <li key={r.userId} className="flex flex-wrap items-center gap-3 py-2.5">
              <UserAvatar name={r.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="truncate text-xs text-muted">{r.email}</p>
              </div>
              {r.role === "owner" ? (
                <Badge tone="violet">{ROLE_LABELS.owner}</Badge>
              ) : manage ? (
                <select aria-label={`Access for ${r.name}`} value={r.role ?? ""} onChange={(e) => change.mutate({ userId: r.userId, role: e.target.value || null })}
                  className="h-8 rounded-md border border-line bg-panel-2 px-2 text-sm">
                  <option value="">No access</option>
                  {BUSINESS_ROLES.map((role) => <option key={role} value={role} disabled={role === "admin" && b.role !== "owner"}>{ROLE_LABELS[role]}</option>)}
                </select>
              ) : (
                <Badge>{r.role ? ROLE_LABELS[r.role as keyof typeof ROLE_LABELS] : "No access"}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-4 text-xs text-muted">
        <summary className="cursor-pointer text-subtle hover:text-fg">What can each role do?</summary>
        <ul className="mt-2 space-y-1">{(["owner", "admin", "analyst", "viewer"] as const).map((r) => <li key={r}><b className="text-fg">{ROLE_LABELS[r]}:</b> {ROLE_DESCRIPTIONS[r]}</li>)}</ul>
      </details>
    </Card>
  );
}

function Activity() {
  const b = useBusiness();
  const allowed = can(b.role, "audit.read");
  const rows = useQuery({
    queryKey: keys.audit(b.id),
    queryFn: ({ signal }) => get<{ id: number; action: string; actorName: string | null; actorType: string; createdAt: string; metadata: any }[]>(`/businesses/${b.id}/audit`, signal),
    enabled: allowed,
  });
  return (
    <Card title="Activity log" description="Audited changes to this business.">
      {!allowed ? (
        <p className="text-sm text-muted">Only business administrators can view the activity log.</p>
      ) : rows.isPending ? <Skeleton className="h-24" /> : (
        <ol className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {rows.data?.map((r) => (
            <li key={r.id} className="flex gap-3 text-sm">
              <time className="w-32 shrink-0 text-xs text-subtle" dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString()}</time>
              <span className="min-w-0"><b className="font-medium">{r.actorName ?? (r.actorType === "system" ? "System" : "Unknown")}</b> <span className="text-muted">{r.action.replace(/[._]/g, " ")}</span></span>
            </li>
          ))}
          {!rows.data?.length && <li className="text-sm text-muted">No activity yet.</li>}
        </ol>
      )}
    </Card>
  );
}

function Danger() {
  const b = useBusiness();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can(b.role, "business.delete")) return null;
  return (
    <Card title="Delete business" className="border-danger/25">
      <Prerequisite tone="warning" title="Deletes everything for this business">
        Connections are disconnected and all imported data, dashboards, conversations, goals and automations for {b.name} are permanently erased.
      </Prerequisite>
      <Button variant="danger" className="mt-4" onClick={() => setOpen(true)}>Delete {b.name}…</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Delete ${b.name}?`} size="sm"
        footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={confirm !== b.name} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await del(`/businesses/${b.id}`, { confirmName: confirm });
              await qc.invalidateQueries();
              toast(`${b.name} deleted`);
              nav("/app", { replace: true });
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}>Delete permanently</Button>
        </>}>
        <Field label={`Type “${b.name}” to confirm`} error={error}>{(p) => <Input {...p} data-autofocus value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
      </Dialog>
    </Card>
  );
}
