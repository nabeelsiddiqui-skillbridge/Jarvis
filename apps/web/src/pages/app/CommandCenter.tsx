import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bell, Bot, FlaskConical, MessageSquare, Plug, Sparkles } from "lucide-react";
import { can, type DateRangeSpec, type SourceInfo, type WidgetSpec, type WidgetType } from "@bca/shared";
import { canWorkspace } from "@bca/shared";
import { get, post, errorMessage } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { useMe } from "@/lib/session";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, Prerequisite } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { Widget } from "@/components/widgets/Widget";
import { DateRangeSelect } from "@/components/dashboard/pickers";

interface Overview {
  isDemo: boolean;
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
  const overview = useQuery({ queryKey: ["b", b.id, "overview"], queryFn: ({ signal }) => get<Overview>(`/businesses/${b.id}/overview`, signal) });
  const o = overview.data;
  const hasData = Boolean(o?.kpis.length);
  const labels: Record<string, string> = {};

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-accent/80">Command Center</p>
          <h1 className="text-2xl font-semibold sm:text-[28px]">Good {greeting()}</h1>
          <p className="mt-1 text-sm text-muted">{b.name} · reporting in {b.currency}, {b.timezone.replace(/_/g, " ")}</p>
        </div>
        {hasData && <DateRangeSelect value={range} onChange={(v) => v && setRange(v)} />}
      </div>

      {o?.isDemo && (
        <div role="note" className="flex items-start gap-3 rounded-xl border border-demo/30 bg-demo/5 px-4 py-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-demo" />
          <p><b className="text-demo">Demo business.</b> <span className="text-muted">Every figure here is generated sample data from simulated accounts. Your real businesses never include demo data.</span></p>
        </div>
      )}

      {overview.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : !hasData ? (
        <NoDataYet />
      ) : (
        <>
          <section aria-labelledby="briefing-h" className="panel flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-accent/25 to-violet/25 text-accent"><Sparkles className="size-5" /></span>
              <h2 id="briefing-h" className="text-[15px] font-semibold">Daily briefing</h2>
            </div>
            <p className="flex-1 text-sm text-muted">The AI-written daily briefing is delivered with insights and automations (build stage 7). Until then, the cards below show the figures it will be based on.</p>
          </section>

          <section aria-label="Key performance indicators" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {o!.kpis.map((k) => (
              <div key={k} className="h-44">
                <Widget widget={w(`kpi-${k}`, "kpi", labels[k] ?? kpiTitle(k), q(k))} businessId={b.id} timezone={b.timezone} dashboardRange={range} />
              </div>
            ))}
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            {o!.revenueTrend && <div className="h-80"><Widget widget={w("rev", "area", "Revenue trend", q(o!.revenueTrend))} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>}
            {o!.acquisitionTrend && <div className="h-80"><Widget widget={w("acq", "line", "Acquisition trend", q(o!.acquisitionTrend))} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>}
            {o!.salesView && (
              <div className="h-80">
                <Widget widget={w("sales", o!.salesView.type, o!.salesView.type === "pipeline" ? "Pipeline overview" : "Top products", q(o!.salesView.metric, { dimension: o!.salesView.dimension as never, granularity: "none" }))} businessId={b.id} timezone={b.timezone} dashboardRange={range} />
              </div>
            )}
            <Card title="Active alerts" description="Threshold and anomaly alerts">
              <div className="flex items-start gap-3 text-sm text-muted"><Bell className="mt-0.5 size-4 shrink-0 text-subtle" />Alerts are generated by deterministic insight rules and automations (build stage 7). No alerts are simulated here.</div>
            </Card>
          </div>

          {o!.goals.length > 0 && (
            <section aria-labelledby="goals-h">
              <h2 id="goals-h" className="mb-3 text-[15px] font-semibold">Goals</h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {o!.goals.map((g) => (
                  <div key={g.id} className="h-44"><Widget widget={w(`goal-${g.id}`, "goal", g.title, null, { options: { target: null, goalId: g.id, showComparison: false, stacked: false } })} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>
                ))}
              </div>
            </section>
          )}

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="h-72 xl:col-span-2"><Widget widget={w("fresh", "freshness", "Connection health", null)} businessId={b.id} timezone={b.timezone} dashboardRange={range} /></div>
            <Card title="Ask the assistant" description="Suggested for this business">
              <ul className="space-y-2">
                {o!.suggestedQuestions.map((s) => (
                  <li key={s}>
                    <Link to={`assistant?q=${encodeURIComponent(s)}`} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-muted transition-colors hover:border-accent/40 hover:text-fg">
                      <MessageSquare className="size-4 shrink-0 text-accent" />{s}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

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
      <div className="mt-4"><Prerequisite title="Available sources">Shopify is available now. GA4, Search Console, Google Ads and HubSpot are delivered in build stage 4.</Prerequisite></div>
    </EmptyState>
  );
}

const KPI_TITLES: Record<string, string> = { store_net_sales: "Net sales", store_orders: "Orders", aov: "Avg order value", mer: "MER", sessions: "Sessions", conversion_rate: "Conversion rate", ad_spend: "Ad spend", roas: "ROAS", organic_clicks: "Organic clicks", store_new_customers: "New customers", crm_won_value: "Won value", crm_open_pipeline: "Open pipeline", crm_qualified_leads: "Qualified leads", win_rate: "Win rate", key_events: "Key events", cpa: "Cost per conversion" };
const kpiTitle = (k: string) => KPI_TITLES[k] ?? k;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
