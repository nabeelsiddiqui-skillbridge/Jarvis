import { useState } from "react";
import { Link, useParams } from "react-router";
import { Building2, Plus, Search } from "lucide-react";
import { INDUSTRIES, ROLE_LABELS, canWorkspace } from "@bca/shared";
import { useBusinesses } from "@/lib/business";
import { useMe } from "@/lib/session";
import { BusinessAvatar } from "@/components/ui/Avatar";
import { Badge, DemoBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { CreateBusinessDialog } from "@/components/business/CreateBusinessDialog";

export function Businesses() {
  const { workspaceId } = useParams();
  const me = useMe();
  const list = useBusinesses(workspaceId);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const role = me.data?.workspaces.find((w) => w.id === workspaceId)?.role;
  const canCreate = canWorkspace(role, "business.create");
  const items = (list.data ?? []).filter((b) => b.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <PageHeader
        title="Businesses"
        description="Each business keeps its own connections, dashboards, conversations, goals and permissions."
        actions={canCreate ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New business</Button> : <span className="text-xs text-subtle">Only workspace owners can add businesses.</span>}
      />
      <div className="relative mb-5 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input aria-label="Search businesses" placeholder="Search businesses…" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : items.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((b) => (
            <li key={b.id}>
              <Link to={`/app/b/${b.id}`} className="panel flex h-full flex-col gap-4 p-5 transition-[border-color,box-shadow] hover:border-accent/40 hover:shadow-[var(--shadow-glow)]">
                <div className="flex items-center gap-3">
                  <BusinessAvatar name={b.name} logoUrl={b.logoUrl} size={40} />
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{b.name}</p>
                    <p className="truncate text-xs text-muted">{INDUSTRIES.find((i) => i.id === b.industry)?.label}</p>
                  </div>
                </div>
                <div className="mt-auto flex flex-wrap gap-1.5">
                  <Badge tone="violet">{ROLE_LABELS[b.role]}</Badge>
                  <Badge>{b.currency}</Badge>
                  <Badge>{b.timezone.split("/").pop()?.replace(/_/g, " ")}</Badge>
                  {b.isDemo && <DemoBadge />}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Building2 className="size-5" />} title={q ? "No matches" : "No businesses you can access"}
          action={canCreate && !q ? <Button variant="primary" onClick={() => setCreating(true)}>Create a business</Button> : undefined}>
          {q ? `Nothing matches “${q}”.` : canCreate ? "Create your first business to start connecting data." : "Ask a workspace owner to give you access to a business."}
        </EmptyState>
      )}
      {workspaceId && <CreateBusinessDialog open={creating} onClose={() => setCreating(false)} workspaceId={workspaceId} />}
    </>
  );
}
