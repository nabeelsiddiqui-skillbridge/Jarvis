import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { AlertTriangle, ArrowLeft, Check, Copy, History, Pencil, Plus, Redo2, Share2, Trash2, Undo2 } from "lucide-react";
import { can, type DashboardDetail, type DashboardSpec, type DateRangeSpec, type WidgetSpec } from "@bca/shared";
import { ApiError, get, post, put, errorMessage } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/cn";
import { Badge, DemoBadge } from "@/components/ui/Badge";
import { Button, ButtonLink, IconButton } from "@/components/ui/Button";
import { EmptyState, ErrorState } from "@/components/ui/EmptyState";
import { PageLoader } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { Widget } from "@/components/widgets/Widget";
import { WidgetEditor } from "@/components/dashboard/WidgetEditor";
import { DateRangeSelect } from "@/components/dashboard/pickers";
import { VersionsDialog } from "@/components/dashboard/VersionsDialog";
import { ShareDialog } from "@/components/dashboard/ShareDialog";
import { dashboardsKey } from "./Dashboards";

const Grid = WidthProvider(Responsive);
const ROW = 36;

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export const dashboardKey = (bid: string, did: string) => ["b", bid, "dashboard", did] as const;

export function DashboardView() {
  const b = useBusiness();
  const { dashboardId = "" } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const detail = useQuery({ queryKey: dashboardKey(b.id, dashboardId), queryFn: ({ signal }) => get<DashboardDetail>(`/businesses/${b.id}/dashboards/${dashboardId}`, signal) });

  const [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [version, setVersion] = useState(0);
  const [past, setPast] = useState<DashboardSpec[]>([]);
  const [future, setFuture] = useState<DashboardSpec[]>([]);
  const [save, setSave] = useState<SaveState>("saved");
  const [editing, setEditing] = useState(false);
  const [rangeOverride, setRangeOverride] = useState<DateRangeSpec | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; widget: WidgetSpec | null }>({ open: false, widget: null });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [breakpoint, setBreakpoint] = useState("lg");
  const specRef = useRef(spec);
  specRef.current = spec;

  // Load server state when nothing local is pending.
  useEffect(() => {
    if (!detail.data || save === "dirty" || save === "saving") return;
    setSpec(detail.data.spec);
    setVersion(detail.data.version);
  }, [detail.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = Boolean(detail.data?.canEdit);
  const canShare = Boolean(detail.data && can(b.role, "dashboard.share") && (detail.data.isOwner || b.role === "owner" || b.role === "admin"));

  /** Apply a change: records undo history and schedules an autosave. */
  const commit = useCallback((next: DashboardSpec) => {
    const cur = specRef.current;
    if (!cur) return;
    setPast((p) => [...p.slice(-49), cur]);
    setFuture([]);
    setSpec(next);
    setSave("dirty");
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length || !specRef.current) return p;
      setFuture((f) => [specRef.current!, ...f]);
      setSpec(p[p.length - 1]!);
      setSave("dirty");
      return p.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length || !specRef.current) return f;
      setPast((p) => [...p, specRef.current!]);
      setSpec(f[0]!);
      setSave("dirty");
      return f.slice(1);
    });
  }, []);

  // Autosave (debounced) with optimistic concurrency.
  useEffect(() => {
    if (save !== "dirty" || !spec) return;
    const t = setTimeout(async () => {
      setSave("saving");
      try {
        const r = await put<{ version: number }>(`/businesses/${b.id}/dashboards/${dashboardId}`, { spec, expectedVersion: version });
        setVersion(r.version);
        setSave((s) => (s === "saving" ? "saved" : s));
        qc.setQueryData(dashboardKey(b.id, dashboardId), (old: DashboardDetail | undefined) => (old ? { ...old, spec, version: r.version } : old));
        qc.invalidateQueries({ queryKey: dashboardsKey(b.id) });
      } catch (e) {
        setSave(e instanceof ApiError && e.status === 409 ? "conflict" : "error");
        if (!(e instanceof ApiError && e.status === 409)) toast(errorMessage(e), "error");
      }
    }, 900);
    return () => clearTimeout(t);
  }, [save, spec, version, b.id, dashboardId, qc, toast]);

  // Keyboard shortcuts for undo/redo while editing.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [role=dialog]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, undo, redo]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (save === "dirty" || save === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [save]);

  // lg is the stored layout; md (6 cols) is derived by halving so medium screens don't leave gaps.
  const layouts = useMemo(() => {
    const ws = spec?.widgets ?? [];
    return {
      lg: ws.map((w) => ({ i: w.id, ...w.layout, minW: 2, minH: 3 })),
      md: ws.map((w) => ({ i: w.id, x: Math.min(5, Math.floor(w.layout.x / 2)), y: w.layout.y, w: Math.max(2, Math.min(6, Math.round(w.layout.w / 2))), h: w.layout.h })),
    };
  }, [spec]);

  if (detail.isPending || (!spec && !detail.error)) return <PageLoader />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  if (!spec) return null;

  const range = rangeOverride ?? spec.dateRange;

  const onLayout = (current: Layout[]) => {
    if (!editing || breakpoint !== "lg") return;
    const byId = new Map(current.map((l) => [l.i, l]));
    let changed = false;
    const widgets = spec.widgets.map((w) => {
      const l = byId.get(w.id);
      if (!l) return w;
      const next = { x: l.x, y: l.y, w: l.w, h: l.h };
      if (next.x !== w.layout.x || next.y !== w.layout.y || next.w !== w.layout.w || next.h !== w.layout.h) changed = true;
      return { ...w, layout: next };
    });
    if (changed) commit({ ...spec, widgets });
  };

  const upsertWidget = (w: WidgetSpec) => {
    const exists = spec.widgets.some((x) => x.id === w.id);
    if (exists) commit({ ...spec, widgets: spec.widgets.map((x) => (x.id === w.id ? w : x)) });
    else {
      const bottom = spec.widgets.reduce((m, x) => Math.max(m, x.layout.y + x.layout.h), 0);
      commit({ ...spec, widgets: [...spec.widgets, { ...w, layout: { ...w.layout, x: 0, y: bottom } }] });
    }
    setEditor({ open: false, widget: null });
  };
  const duplicateWidget = (w: WidgetSpec) => {
    const copy = { ...w, id: Math.random().toString(36).slice(2, 10), title: `${w.title} (copy)`.slice(0, 120), layout: { ...w.layout, y: w.layout.y + w.layout.h } };
    commit({ ...spec, widgets: [...spec.widgets, copy] });
  };
  const removeWidget = (w: WidgetSpec) => commit({ ...spec, widgets: spec.widgets.filter((x) => x.id !== w.id) });

  const restore = async (v: number) => {
    try {
      const r = await post<{ version: number }>(`/businesses/${b.id}/dashboards/${dashboardId}/versions/${v}/restore`, { expectedVersion: version });
      setSave("saved");
      setPast([]);
      setFuture([]);
      await qc.invalidateQueries({ queryKey: dashboardKey(b.id, dashboardId) });
      setVersion(r.version);
      setVersionsOpen(false);
      toast(`Restored version ${v}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const reloadAfterConflict = async () => {
    setSave("saved");
    setPast([]);
    setFuture([]);
    await detail.refetch();
  };

  const duplicate = async () => {
    try {
      const r = await post<{ id: string }>(`/businesses/${b.id}/dashboards/${dashboardId}/duplicate`);
      qc.invalidateQueries({ queryKey: dashboardsKey(b.id) });
      nav(`/app/b/${b.id}/dashboards/${r.id}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <IconButton label="All dashboards" onClick={() => nav(`/app/b/${b.id}/dashboards`)}><ArrowLeft className="size-5" /></IconButton>
        <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
          {editing ? (
            <input aria-label="Dashboard name" value={spec.name} onChange={(e) => commit({ ...spec, name: e.target.value.slice(0, 120) || " " })}
              className="w-full max-w-md rounded-md border border-line bg-panel-2 px-2 py-1 font-display text-xl font-semibold focus:border-accent focus:outline-none" />
          ) : (
            <h1 className="line-clamp-2 text-xl font-semibold sm:text-2xl">{spec.name}</h1>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            {b.isDemo && <DemoBadge />}
            {detail.data!.visibility === "private" ? <Badge>Restricted</Badge> : null}
            {!canEdit && <Badge>View only</Badge>}
            <SaveIndicator state={save} version={version} />
          </div>
        </div>
        <DateRangeSelect value={range} onChange={(v) => {
          if (!v) return;
          if (editing) commit({ ...spec, dateRange: v });
          else setRangeOverride(v);
        }} />
        <div className="flex flex-wrap items-center gap-1">
          {editing && (
            <>
              <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!past.length}><Undo2 className="size-4" /></IconButton>
              <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!future.length}><Redo2 className="size-4" /></IconButton>
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditor({ open: true, widget: null })}>Widget</Button>
            </>
          )}
          <IconButton label="Version history" onClick={() => setVersionsOpen(true)}><History className="size-4" /></IconButton>
          {canShare && <IconButton label="Share" onClick={() => setShareOpen(true)}><Share2 className="size-4" /></IconButton>}
          {can(b.role, "dashboard.write") && <IconButton label="Duplicate dashboard" onClick={duplicate}><Copy className="size-4" /></IconButton>}
          {canEdit && (
            <Button size="sm" variant={editing ? "primary" : "secondary"} icon={editing ? <Check className="size-4" /> : <Pencil className="size-4" />} onClick={() => { setEditing(!editing); setRangeOverride(null); }}>
              {editing ? "Done" : "Edit"}
            </Button>
          )}
        </div>
      </div>

      {save === "conflict" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
          <AlertTriangle className="size-4 text-warning" />
          <span className="flex-1">Someone else saved this dashboard while you were editing. Your latest change wasn't saved.</span>
          <Button size="sm" onClick={reloadAfterConflict}>Load their version</Button>
        </div>
      )}
      {editing && breakpoint !== "lg" && <p className="text-xs text-muted">Drag and resize on a wider screen; you can still add, edit and remove widgets here.</p>}

      {spec.widgets.length ? (
        <Grid
          className={cn("-mx-2", editing && "rounded-xl outline outline-1 outline-dashed outline-line-strong")}
          layouts={layouts}
          breakpoints={{ lg: 720, md: 480, sm: 0 }}
          cols={{ lg: 12, md: 6, sm: 1 }}
          rowHeight={ROW}
          margin={[14, 14]}
          isDraggable={editing && breakpoint === "lg"}
          isResizable={editing && breakpoint === "lg"}
          draggableHandle=".widget-drag"
          draggableCancel=".widget-nodrag,button,a,input,select"
          onBreakpointChange={setBreakpoint}
          onDragStop={onLayout}
          onResizeStop={onLayout}
          compactType="vertical"
        >
          {spec.widgets.map((w) => (
            <div key={w.id}>
              <Widget widget={w} businessId={b.id} dashboardId={dashboardId} timezone={b.timezone} dashboardRange={range} editing={editing}
                actions={editing ? (
                  <span className="widget-nodrag flex items-center">
                    <IconButton size="sm" label={`Edit ${w.title}`} onClick={() => setEditor({ open: true, widget: w })}><Pencil className="size-3.5" /></IconButton>
                    <IconButton size="sm" label={`Duplicate ${w.title}`} onClick={() => duplicateWidget(w)}><Copy className="size-3.5" /></IconButton>
                    <IconButton size="sm" label={`Remove ${w.title}`} onClick={() => removeWidget(w)} className="hover:text-danger"><Trash2 className="size-3.5" /></IconButton>
                  </span>
                ) : undefined} />
            </div>
          ))}
        </Grid>
      ) : (
        <EmptyState title="This dashboard is empty" action={canEdit ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(true); setEditor({ open: true, widget: null }); }}>Add a widget</Button> : <ButtonLink to=".." relative="path">Back</ButtonLink>}>
          Add KPIs, charts, tables, funnels and more. Each widget shows its sources and freshness.
        </EmptyState>
      )}

      <WidgetEditor open={editor.open} initial={editor.widget} onClose={() => setEditor({ open: false, widget: null })} businessId={b.id} timezone={b.timezone} dashboardRange={range} onSave={upsertWidget} />
      <VersionsDialog open={versionsOpen} onClose={() => setVersionsOpen(false)} businessId={b.id} dashboardId={dashboardId} current={version} canRestore={canEdit} onRestore={restore} />
      {canShare && <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} businessId={b.id} dashboardId={dashboardId} meId={me.data?.user.id ?? ""} />}
    </div>
  );
}

function SaveIndicator({ state, version }: { state: SaveState; version: number }) {
  const text = { saved: `Saved · v${version}`, dirty: "Unsaved changes", saving: "Saving…", error: "Save failed — retrying on next change", conflict: "Not saved (conflict)" }[state];
  return <span role="status" className={cn(state === "error" || state === "conflict" ? "text-warning" : "text-subtle")}>{text}</span>;
}
