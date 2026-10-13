import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Target } from "lucide-react";
import type { Goal } from "@bca/shared";
import { can } from "@bca/shared";
import { get } from "@/lib/api";
import { keys, useBusiness } from "@/lib/business";
import { Card, PageHeader } from "@/components/ui/Card";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Spinner";

export function CommandCenter() {
  const b = useBusiness();
  const goals = useQuery({ queryKey: keys.goals(b.id), queryFn: ({ signal }) => get<Goal[]>(`/businesses/${b.id}/goals`, signal) });
  const setup = [
    { label: "Create the business", done: true },
    { label: "Set business goals", done: (goals.data?.length ?? 0) > 0, to: "settings#goals" },
    { label: "Connect a data source", done: false, stage: 3 },
    { label: "Create your first dashboard", done: false, stage: 2 },
    { label: "Ask the assistant a question", done: false, stage: 5 },
  ];
  return (
    <>
      <PageHeader eyebrow="Command Center" title={`Good ${greeting()}`} description={`Here's where ${b.name} stands. Briefings, KPIs and alerts appear here once data sources are connected.`} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Setup" description="Finish these to get your first briefing." className="lg:col-span-1">
          <ul className="space-y-3">
            {setup.map((s) => (
              <li key={s.label} className="flex items-center gap-3 text-sm">
                {s.done ? <CheckCircle2 className="size-5 text-success" /> : <Circle className="size-5 text-subtle" />}
                <span className={s.done ? "text-muted line-through decoration-subtle" : ""}>{s.label}</span>
                {!s.done && s.stage && <span className="ml-auto text-xs text-subtle">stage {s.stage}</span>}
                {!s.done && s.to && can(b.role, "goals.write") && <ButtonLink to={s.to} size="sm" variant="ghost" className="ml-auto">Add</ButtonLink>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Goals" description="Confirmed goals for this business." className="lg:col-span-2" actions={can(b.role, "goals.write") ? <ButtonLink to="settings#goals" size="sm">Manage</ButtonLink> : undefined}>
          {goals.isPending ? (
            <div className="space-y-3"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
          ) : goals.data?.length ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {goals.data.map((g) => (
                <li key={g.id} className="rounded-xl border border-line bg-panel-2 p-4">
                  <div className="flex items-start gap-2.5">
                    <Target className="mt-0.5 size-4 text-violet" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{g.title}</p>
                      <p className="mt-1 text-xs text-muted">
                        {g.targetValue != null ? `Target ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(g.targetValue)} per ${g.period}` : `Per ${g.period}`}
                        {" · "}Progress unavailable until a data source provides the metric
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No goals yet" className="py-8">Goals give the assistant context and power goal-progress widgets.</EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
