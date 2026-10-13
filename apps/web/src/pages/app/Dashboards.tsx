import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, LayoutDashboard, Lock, Plus, Trash2, Users } from "lucide-react";
import { can, type DashboardSummary } from "@bca/shared";
import { del, get, post, errorMessage } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState } from "@/components/ui/EmptyState";
import { Field, Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

interface TemplateInfo { id: string; name: string; description: string; recommended: boolean; widgetCount: number; omitted: { title: string; missing: string[] }[] }

export const dashboardsKey = (bid: string) => ["b", bid, "dashboards"] as const;

export function Dashboards() {
  const b = useBusiness();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: dashboardsKey(b.id), queryFn: ({ signal }) => get<DashboardSummary[]>(`/businesses/${b.id}/dashboards`, signal) });
  const canWrite = can(b.role, "dashboard.write");

  const duplicate = useMutation({
    mutationFn: (id: string) => post<{ id: string }>(`/businesses/${b.id}/dashboards/${id}/duplicate`),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: dashboardsKey(b.id) }); nav(r.id); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/businesses/${b.id}/dashboards/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: dashboardsKey(b.id) }); toast("Dashboard deleted"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  return (
    <>
      <PageHeader title="Dashboards" description={`Live dashboards for ${b.name}. Every widget is backed by a validated metric definition.`}
        actions={canWrite ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New dashboard</Button> : <span className="text-xs text-subtle">Viewers can open dashboards but not create them.</span>} />
      {list.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.map((d) => (
            <li key={d.id} className="panel group flex flex-col p-5 transition-[border-color,box-shadow] hover:border-accent/40">
              <Link to={d.id} className="flex-1 focus:outline-none">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent/20 to-violet/20 text-accent"><LayoutDashboard className="size-5" /></span>
                  <div className="min-w-0">
                    <p className="truncate font-semibold group-hover:text-accent">{d.name}</p>
                    <p className="line-clamp-2 text-xs text-muted">{d.description || `${d.widgetCount} widgets`}</p>
                  </div>
                </div>
              </Link>
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <Badge>{d.widgetCount} widgets</Badge>
                {d.visibility === "private" ? <Badge icon={<Lock className="size-3" />}>Private</Badge> : <Badge icon={<Users className="size-3" />}>Business</Badge>}
                {!d.canEdit && <Badge icon={<Eye className="size-3" />}>View only</Badge>}
                <span className="ml-auto text-[11px] text-subtle">v{d.version} · {new Date(d.updatedAt).toLocaleDateString()}</span>
              </div>
              {canWrite && (
                <div className="mt-3 flex gap-1 border-t border-line pt-3">
                  <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => duplicate.mutate(d.id)}>Duplicate</Button>
                  {(d.isOwner || b.role === "owner" || b.role === "admin") && (
                    <Button size="sm" variant="ghost" className="ml-auto text-danger/80 hover:text-danger" icon={<Trash2 className="size-3.5" />}
                      onClick={() => confirm(`Delete “${d.name}”? Its version history is deleted too.`) && remove.mutate(d.id)}>Delete</Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<LayoutDashboard className="size-5" />} title="No dashboards yet" action={canWrite ? <Button variant="primary" onClick={() => setCreating(true)}>Create a dashboard</Button> : undefined}>
          Start from a template — it only includes widgets your connected data can actually fill.
        </EmptyState>
      )}
      <NewDashboardDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function NewDashboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const b = useBusiness();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const templates = useQuery({ queryKey: ["b", b.id, "templates"], queryFn: ({ signal }) => get<TemplateInfo[]>(`/businesses/${b.id}/dashboard-templates`, signal), enabled: open });
  const [template, setTemplate] = useState<string>("blank");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"business" | "private">("business");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = templates.data?.find((t) => t.id === template);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: string; omitted: { title: string }[] }>(`/businesses/${b.id}/dashboards`, {
        name: name.trim() || chosen?.name || "Untitled dashboard",
        template: template === "blank" ? undefined : template,
        visibility,
      });
      await qc.invalidateQueries({ queryKey: dashboardsKey(b.id) });
      if (r.omitted.length) toast(`${r.omitted.length} template widget(s) skipped — their data isn't connected yet.`, "info");
      onClose();
      nav(`/app/b/${b.id}/dashboards/${r.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New dashboard" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create dashboard</Button></>}>
      <div className="space-y-5">
        <Field label="Name">{(p) => <Input {...p} data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.name ?? "Sales team"} />}</Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Start from</legend>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
            <TemplateOption selected={template === "blank"} onSelect={() => setTemplate("blank")} title="Blank" body="Add widgets yourself." />
            {templates.isPending && <Skeleton className="h-20" />}
            {templates.data?.map((t) => (
              <TemplateOption key={t.id} selected={template === t.id} onSelect={() => setTemplate(t.id)} title={t.name} body={t.description}
                meta={t.widgetCount ? `${t.widgetCount} widgets with data${t.omitted.length ? ` · ${t.omitted.length} need a connection` : ""}` : "No matching data connected yet"} recommended={t.recommended} disabled={!t.widgetCount} />
            ))}
          </div>
        </fieldset>
        {chosen && chosen.omitted.length > 0 && (
          <p className="text-xs text-muted">Skipped until connected: {chosen.omitted.map((o) => o.title).join(", ")}.</p>
        )}
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Who can see it</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="vis" checked={visibility === "business"} onChange={() => setVisibility("business")} className="accent-[#22d3ee]" />Everyone with access to {b.name}</label>
            <label className="flex items-center gap-2"><input type="radio" name="vis" checked={visibility === "private"} onChange={() => setVisibility("private")} className="accent-[#22d3ee]" />Only me (share later)</label>
          </div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function TemplateOption({ selected, onSelect, title, body, meta, recommended, disabled }: { selected: boolean; onSelect: () => void; title: string; body: string; meta?: string; recommended?: boolean; disabled?: boolean }) {
  return (
    <button role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}
      className={cn("rounded-xl border p-3 text-left transition-colors disabled:opacity-50", selected ? "border-accent bg-accent/10" : "border-line hover:border-line-strong")}>
      <span className="flex items-center gap-2 text-sm font-medium">{title}{recommended && <Badge tone="accent">Suggested</Badge>}</span>
      <span className="mt-0.5 block text-xs text-muted">{body}</span>
      {meta && <span className="mt-1.5 block text-[11px] text-subtle">{meta}</span>}
    </button>
  );
}
