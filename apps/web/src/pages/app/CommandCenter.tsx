import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, CheckCircle2, Circle, FlaskConical, Plug, Sparkles } from "lucide-react";
import { can, type DateRangeSpec, type SourceInfo, type WidgetSpec, type WidgetType } from "@bca/shared";
import { canWorkspace } from "@bca/shared";
import { get, patch, post, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useBusiness } from "@/lib/business";
import { useMe } from "@/lib/session";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, Prerequisite } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { Widget } from "@/components/widgets/Widget";
import { DateRangeSelect } from "@/components/dashboard/pickers";
import { CitationChip, EvidenceCard } from "@/components/assistant/Evidence";
import { Markdown } from "@/components/assistant/Markdown";
import { useLatestBriefing } from "@/lib/insights";
import { Chat } from "@/components/assistant/Chat";
import { loadConversation, saveConversation } from "@/components/shell/AssistantPanel";
import { Agenda, Alerts, Diagnostics, Modules, Signal, StatusStrip } from "@/components/deck/Deck";

interface Overview {
  isDemo: boolean;
  setup: { connected: boolean; dataImported: boolean; dashboard: boolean; asked: boolean; goals: boolean; automation: boolean };
  kpis: string[];
  revenueTrend: string | null;
  acquisitionTrend: string | null;
  salesView: { type: WidgetType; metric: string; dimension: string } | null;
  sources: SourceInfo[];
  goals: { id: string; title: string; metricKey: string | null; targetValue: number | null; period: string; trackable: boolean }[];
  activity: { action: string; at: string; actor: string | null }[];
  suggestedQuestions: string[];
}

const w = (id: string, type: WidgetType, title: string, query: WidgetSpec["query"], extra: Partial<WidgetSpec> = {}): WidgetSpec => ({
  id, type, title, query, options: { target: null, goalId: null, showComparison: true, stacked: false }, refresh: { mode: "on_new_data" }, layout: { x: 0, y: 0, w: 3, h: 4 }, ...extra,
});
const q = (metric: string, extra: Partial<NonNullable<WidgetSpec["query"]>> = {}): NonNullable<WidgetSpec["query"]> => ({
  metric, metrics: [], dimension: null, granularity: "day", dateRange: null, comparison: "previous_period", filters: [], sources: [], limit: 8, sort: "value_desc", ...extra,
});

export function CommandCenter() {
  const b = useBusiness();
  const [range, setRange] = useState<DateRangeSpec>({ preset: "last_30_days" });
  const [deckConversation, setDeckConversation] = useState<string | null>(() => loadConversation(b.id));
  const overview = useQuery({ queryKey: ["b", b.id, "overview"], queryFn: ({ signal }) => get<Overview>(`/businesses/${b.id}/overview`, signal) });
  const o = overview.data;
  const hasData = Boolean(o?.kpis.length);
  const labels: Record<string, string> = {};

  const sources = o?.sources ?? [];
  const fresh = sources.filter((s) => !s.stale && s.status !== "error" && s.status !== "reauth_required").length;
  const deckGreeting = `Good ${greeting()}. ${sources.length ? (fresh === sources.length ? `All ${sources.length} data source${sources.length === 1 ? " is" : "s are"} up to date.` : `${fresh} of ${sources.length} data sources are up to date.`) : "No data sources are connected yet."}`;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Command Center — {b.name}</h1>

      {o?.isDemo && (
        <div role="note" className="flex items-start gap-3 rounded-xl border border-demo/30 bg-demo/5 px-4 py-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-demo" />
          <p><b className="text-demo">Demo business.</b> <span className="text-muted">Every figure here is generated sample data from simulated accounts. Your real businesses never include demo data.</span></p>
        </div>
      )}

      {o && !o.isDemo && !b.support && <GettingStarted setup={o.setup} />}

      {/* The command deck: JARVIS at the centre, live business systems around it. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(250px,290px)_minmax(0,1fr)_minmax(270px,310px)]">
        <div className="order-2 min-w-0 space-y-4 xl:order-1">
          <Diagnostics sources={sources} />
          <Modules sources={sources} />
        </div>
        <section aria-label="JARVIS" className="panel hud order-1 flex h-[82dvh] min-w-0 min-h-[600px] flex-col overflow-hidden xl:order-2 xl:h-[min(880px,calc(100dvh-8rem))]">
          {b.support ? (
            <p className="m-auto max-w-sm p-6 text-center text-sm text-muted">The assistant isn't available during read-only support access.</p>
          ) : (
            <Chat key={b.id} business={b} conversationId={deckConversation} onConversation={(id) => { setDeckConversation(id); saveConversation(b.id, id); }} onMissing={() => { setDeckConversation(null); saveConversation(b.id, null); }} deck={{ greeting: deckGreeting }} />
          )}
        </section>
        <div className="order-3 min-w-0 space-y-4">
          <Agenda />
          <Alerts />
          <Signal metric={o?.revenueTrend ?? o?.kpis[0] ?? null} />
        </div>
      </div>
      <StatusStrip sources={sources} />

      {hasData && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <h2 className="hud-title">Performance</h2>
          <DateRangeSelect value={range} onChange={(v) => v && setRange(v)} />
        </div>
      )}

      {overview.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : !hasData ? (
        <NoDataYet />
      ) : (
        <>
          <BriefingCard />

          <section aria-label="Key performance indicators" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
            {o!.kpis.map((k) => (
              <div key={k} className="h-44">
                <Widget widget={w(`kpi-${k}`, "kpi", labels[k] ?? kpiTitle(k), q(k))} businessId={b.id} timezone={b.timezone} dashboardRange={range} />
              </div>
            ))}
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 [&>*]:min-w-0">
            {o!.revenueTrend && <div className="h-80"><Widget widget={w("rev", "area", "Revenue trend", q(o!.revenueTrend))} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>}
            {o!.acquisitionTrend && <div className="h-80"><Widget widget={w("acq", "line", "Acquisition trend", q(o!.acquisitionTrend))} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>}
            {o!.salesView && (
              <div className="h-80">
                <Widget widget={w("sales", o!.salesView.type, o!.salesView.type === "pipeline" ? "Pipeline overview" : "Top products", q(o!.salesView.metric, { dimension: o!.salesView.dimension as never, granularity: "none" }))} businessId={b.id} timezone={b.timezone} dashboardRange={range} />
              </div>
            )}
          </div>

          {o!.goals.length > 0 && (
            <section aria-labelledby="goals-h">
              <h2 id="goals-h" className="mb-3 text-[15px] font-semibold">Goals</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
                {o!.goals.map((g) => (
                  <div key={g.id} className="h-44"><Widget widget={w(`goal-${g.id}`, "goal", g.title, null, { options: { target: null, goalId: g.id, showComparison: false, stacked: false } })} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>
                ))}
              </div>
            </section>
          )}

          <div className="h-72"><Widget widget={w("fresh", "freshness", "Connection health", null)} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>

          {o!.activity.length > 0 && (
            <Card title="Recent activity">
              <ol className="space-y-2">
                {o!.activity.map((a, i) => (
                  <li key={i} className="flex gap-3 text-sm"><Activity className="mt-0.5 size-4 shrink-0 text-subtle" /><span><b className="font-medium">{a.actor ?? "System"}</b> <span className="text-muted">{a.action.replace(/[._]/g, " ")}</span></span><time className="ml-auto shrink-0 text-xs text-subtle">{new Date(a.at).toLocaleString()}</time></li>
                ))}
              </ol>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function BriefingCard() {
  const b = useBusiness();
  const q = useLatestBriefing(b.id);
  const qc = useQueryClient();
  const toast = useToast();
  const gen = useMutation({
    mutationFn: () => post<{ id: string }>(`/businesses/${b.id}/reports`, { kind: "daily_briefing" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["b", b.id, "reports"] }),
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const r = q.data?.report;
  const evidence = new Map((r?.content.headline ?? []).map((e) => [e.id, e]));
  const [open, setOpen] = useState<string | null>(null);
  const cite = (id: string, key: string) => <CitationChip key={key} id={id} active={open === id} missing={!evidence.has(id)} onClick={() => setOpen(open === id ? null : id)} />;
  return (
    <section aria-labelledby="briefing-h" className="panel p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-accent/25 to-violet/25 text-accent"><Sparkles className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="briefing-h" className="text-[15px] font-semibold">Daily briefing</h2>
          <p className="text-xs text-subtle">{r ? <>{r.period.from} · created {new Date(r.createdAt).toLocaleString()}{r.narrativeStatus === "ready" ? " · AI summary of the figures, check the evidence" : ""}</> : "Not generated yet"}</p>
        </div>
        <div className="flex gap-2">
          {r && <ButtonLink size="sm" variant="secondary" to={`reports/${r.id}`}>Full briefing</ButtonLink>}
          {can(b.role, "report.write") && <Button size="sm" variant={r ? "ghost" : "primary"} loading={gen.isPending} onClick={() => gen.mutate()}>{r ? "Refresh" : "Generate today's briefing"}</Button>}
        </div>
      </div>
      {q.isLoading ? <Skeleton className="mt-4 h-16" /> : r ? (
        <div className="mt-3 text-sm leading-relaxed text-[#dbe4ef]">
          {r.narrative ? <Markdown text={r.narrative} renderCitation={cite} /> : <ul className="space-y-1">{r.content.deterministicSummary.slice(0, 4).map((l, i) => <li key={i}><Markdown text={l} renderCitation={cite} /></li>)}</ul>}
          {open && evidence.get(open) && <div className="mt-3"><EvidenceCard evidence={evidence.get(open)!} highlighted /></div>}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">
          A morning summary of yesterday's figures, open alerts and data health.{" "}
          {q.data?.automation ? "It's scheduled; the first one appears after its next run." : <><Link to="automations" className="text-accent underline">Schedule a daily briefing</Link> or generate one now.</>}
        </p>
      )}
    </section>
  );
}

function NoDataYet() {
  const b = useBusiness();
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const owner = canWorkspace(me.data?.workspaces.find((x) => x.id === b.workspaceId)?.role, "business.create");
  const openDemo = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: string }>(`/workspaces/${b.workspaceId}/demo-business`, { currency: b.currency, timezone: b.timezone });
      await qc.invalidateQueries({ queryKey: ["ws", b.workspaceId] });
      nav(`/app/b/${r.id}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <EmptyState icon={<Plug className="size-5" />} title={`No data connected to ${b.name} yet`}
      action={<>
        {can(b.role, "connection.manage") && <ButtonLink to="connections" variant="primary">Connect a data source</ButtonLink>}
        {owner && <Button loading={busy} icon={<FlaskConical className="size-4" />} onClick={openDemo}>Explore a demo business</Button>}
        <ButtonLink to="assistant" variant="ghost" icon={<Bot className="size-4" />}>Assistant</ButtonLink>
      </>}>
      KPIs, trends and alerts appear once a source is connected. The demo opens a <b className="text-fg">separate, labelled</b> business with sample data — nothing is added to {b.name}.
      <div className="mt-4"><Prerequisite title="Available sources">Shopify, Google Analytics 4, Search Console, Google Ads and HubSpot can be connected once the platform operator has added each provider's app credentials. The Connections page shows which are ready.</Prerequisite></div>
    </EmptyState>
  );
}

const KPI_TITLES: Record<string, string> = { store_net_sales: "Net sales", store_orders: "Orders", aov: "Avg order value", mer: "MER", sessions: "Sessions", conversion_rate: "Conversion rate", ad_spend: "Ad spend", roas: "ROAS", organic_clicks: "Organic clicks", store_new_customers: "New customers", crm_won_value: "Won value", crm_open_pipeline: "Open pipeline", crm_qualified_leads: "Qualified leads", win_rate: "Win rate", key_events: "Key events", cpa: "Cost per conversion" };
const kpiTitle = (k: string) => KPI_TITLES[k] ?? k;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

/** Remaining setup steps for a real business; hidden when done or dismissed. */
function GettingStarted({ setup }: { setup: Overview["setup"] }) {
  const b = useBusiness();
  const me = useMe();
  const qc = useQueryClient();
  const key = `checklist:${b.id}`;
  const dismissed = Boolean(me.data?.preferences.onboarding?.[key]);
  const steps = [
    { done: setup.connected, label: "Connect a data source", to: "connections", cta: "Connect" },
    { done: setup.dataImported, label: "Finish the first import", to: "connections", cta: "View progress", hidden: !setup.connected },
    { done: setup.dashboard, label: "Create your first dashboard", to: "dashboards", cta: "Create" },
    { done: setup.asked, label: "Ask the assistant a question", to: "assistant", cta: "Ask" },
    { done: setup.goals, label: "Set business goals", to: "settings", cta: "Add goals" },
    { done: setup.automation, label: "Schedule a daily briefing", to: "automations", cta: "Set up" },
  ].filter((s) => !s.hidden);
  const left = steps.filter((s) => !s.done).length;
  if (dismissed || !left) return null;
  return (
    <Card title="Getting started" description={`${steps.length - left} of ${steps.length} done`}
      actions={<Button size="sm" variant="ghost" onClick={async () => { await patch("/auth/me/preferences", { onboarding: { [key]: true } }).catch(() => undefined); qc.invalidateQueries({ queryKey: ["me"] }); }}>Dismiss</Button>}>
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((s) => (
          <li key={s.label} className={cn("flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm", s.done ? "border-line text-muted" : "border-line-strong")}>
            {s.done ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="size-4 shrink-0 text-subtle" aria-label="Not done" />}
            <span className={cn("flex-1", s.done && "line-through decoration-white/20")}>{s.label}</span>
            {!s.done && <Link to={`/app/b/${b.id}/${s.to}`} className="text-xs font-medium text-accent hover:underline">{s.cta}</Link>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
