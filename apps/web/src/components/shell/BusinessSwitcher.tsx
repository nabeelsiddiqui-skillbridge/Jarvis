import { useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Check, ChevronsUpDown, Clock, Plus, Search } from "lucide-react";
import type { Business } from "@bca/shared";
import { canWorkspace } from "@bca/shared";
import { cn } from "@/lib/cn";
import { rememberBusiness, useBusinesses } from "@/lib/business";
import { useMe } from "@/lib/session";
import { BusinessAvatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Popover } from "@/components/ui/Popover";
import { Spinner } from "@/components/ui/Spinner";
import { CreateBusinessDialog } from "@/components/business/CreateBusinessDialog";

/** Pages that exist for every business; deeper paths (e.g. a specific dashboard) fall back to their section. */
function targetPath(pathname: string, businessId: string) {
  const m = pathname.match(/^\/app\/b\/[^/]+\/?([^/]*)/);
  const section = m?.[1] ?? "";
  return `/app/b/${businessId}${section ? `/${section}` : ""}`;
}

export function BusinessSwitcher({ workspaceId, active }: { workspaceId: string; active: Business | null }) {
  const me = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useBusinesses(workspaceId);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const role = me.data?.workspaces.find((w) => w.id === workspaceId)?.role;
  const workspaces = me.data?.workspaces ?? [];

  const { recent, filtered } = useMemo(() => {
    const all = list.data ?? [];
    const term = q.trim().toLowerCase();
    const filtered = term ? all.filter((b) => b.name.toLowerCase().includes(term) || b.industry.includes(term)) : all;
    const recentIds = me.data?.preferences.recentBusinessIds ?? [];
    const recent = term ? [] : recentIds.map((id) => all.find((b) => b.id === id)).filter((b): b is Business => Boolean(b) && b!.id !== active?.id).slice(0, 3);
    return { recent, filtered };
  }, [list.data, q, me.data, active?.id]);

  const choose = (b: Business) => {
    setOpen(false);
    setQ("");
    if (b.id === active?.id) return;
    rememberBusiness(b.id, b.workspaceId);
    nav(targetPath(loc.pathname, b.id));
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-option]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, -1);
    if (next === -1) (listRef.current?.querySelector("input") as HTMLElement | null)?.focus();
    else items[next]?.focus();
  };

  const Option = ({ b }: { b: Business }) => (
    <button data-option role="option" aria-selected={b.id === active?.id} onClick={() => choose(b)}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-white/5 focus:bg-white/5 focus:outline-none">
      <BusinessAvatar name={b.name} logoUrl={b.logoUrl} size={26} />
      <span className="min-w-0 flex-1 truncate">{b.name}</span>
      {b.isDemo && <Badge tone="demo">Demo</Badge>}
      {b.id === active?.id && <Check className="size-4 text-accent" />}
    </button>
  );

  return (
    <div className="relative">
      <button ref={triggerRef} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}
        className={cn("flex w-full items-center gap-3 rounded-xl border border-line bg-panel-2 p-2.5 text-left transition-colors hover:border-line-strong", open && "border-accent/40")}>
        {active ? <BusinessAvatar name={active.name} logoUrl={active.logoUrl} size={34} /> : <span className="grid size-[34px] place-items-center rounded-lg border border-dashed border-line-strong text-subtle"><Plus className="size-4" /></span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{active?.name ?? "Select a business"}</span>
          <span className="block truncate text-xs text-muted">{workspaces.find((w) => w.id === workspaceId)?.name}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-subtle" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={triggerRef} className="w-[min(320px,calc(100vw-2rem))]">
        <div ref={listRef} onKeyDown={onListKey}>
          {workspaces.length > 1 && (
            <div className="border-b border-line p-2">
              <label className="sr-only" htmlFor="ws-select">Workspace</label>
              <select id="ws-select" value={workspaceId} onChange={(e) => { setOpen(false); nav(`/app/w/${e.target.value}/businesses`); }}
                className="w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs text-muted">
                {workspaces.map((w) => <option key={w.id} value={w.id}>Workspace: {w.name}</option>)}
              </select>
            </div>
          )}
          <div className="relative border-b border-line p-2">
            <Search className="pointer-events-none absolute left-4.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search businesses…" aria-label="Search businesses"
              className="h-9 w-full rounded-md bg-panel-2 pl-8 pr-2 text-sm placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent/30" />
          </div>
          <div role="listbox" aria-label="Businesses" className="max-h-80 overflow-y-auto p-1.5">
            {list.isPending && <div className="p-3"><Spinner className="size-4" /></div>}
            {recent.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle"><Clock className="size-3" /> Recent</div>
                {recent.map((b) => <Option key={`r-${b.id}`} b={b} />)}
                <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-subtle">All businesses</div>
              </>
            )}
            {filtered.map((b) => <Option key={b.id} b={b} />)}
            {list.data && !filtered.length && <p className="px-3 py-4 text-center text-sm text-muted">No businesses match “{q}”.</p>}
          </div>
          <div className="border-t border-line p-1.5">
            {canWorkspace(role, "business.create") ? (
              <button data-option onClick={() => { setOpen(false); setCreating(true); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-accent hover:bg-white/5 focus:bg-white/5 focus:outline-none">
                <Plus className="size-4" /> New business
              </button>
            ) : (
              <p className="px-2.5 py-2 text-xs text-subtle">Only workspace owners can create businesses.</p>
            )}
          </div>
        </div>
      </Popover>
      <CreateBusinessDialog open={creating} onClose={() => setCreating(false)} workspaceId={workspaceId} />
    </div>
  );
}
