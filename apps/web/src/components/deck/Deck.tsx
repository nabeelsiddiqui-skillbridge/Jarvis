import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatMetricValue, todayIn, type ActionProposal, type MetricUnit, type SourceInfo, type WidgetSpec } from "@bca/shared";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useBusiness } from "@/lib/business";
import { useAssistantStatus } from "@/lib/assistant";
import { useAutomations, useInsights, useTasks } from "@/lib/insights";
import { useMetricQuery } from "@/lib/metrics";
import { PROVIDER_NAMES, relativeTime } from "@/components/widgets/WidgetFrame";

/**
 * Command-deck panels around the JARVIS core. Every figure here is real: data freshness
 * from the business's connections, module states from the platform, today's schedule,
 * open alerts and a live metric trend. Nothing is decorative.
 */

export function DeckPanel({ title, right, warn, children, className }: { title: string; right?: ReactNode; warn?: boolean; children: ReactNode; className?: string }) {
  return (
    <section className={cn("panel hud p-4", warn && "hud-warn border-amber/40 bg-amber/[0.06]", className)}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className={cn("hud-title", warn && "text-amber")}>{title}</h2>
        {right && <span className={cn("hud-label text-[10.5px]", warn ? "text-amber" : "text-muted")}>{right}</span>}
      </header>
      {children}
    </section>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** "System diagnostics": how fresh each connected source is (bar = time since the last successful sync, over 24h). */
export function Diagnostics({ sources }: { sources: SourceInfo[] }) {
  return (
    <DeckPanel title="Data diagnostics" right={sources.length ? "Live" : "No sources"}>
      {sources.length ? (
        <ul className="space-y-3.5">
          {sources.map((s) => {
            const ageH = s.lastSyncedAt ? (Date.now() - new Date(s.lastSyncedAt).getTime()) / 3_600_000 : 48;
            const pct = Math.round(Math.max(6, Math.min(100, 100 - (ageH / 24) * 100)));
            const failing = s.status === "error" || s.status === "reauth_required";
            const color = failing ? "bg-danger" : s.stale ? "bg-amber" : ageH < 2 ? "bg-success" : "bg-accent";
            return (
              <li key={s.connectionId}>
                <div className="flex items-baseline justify-between gap-2 font-mono text-[11.5px] uppercase tracking-wider">
                  <span className="min-w-0 truncate text-fg/90" title={`${s.accountName}${s.assetName ? ` · ${s.assetName}` : ""}`}>{PROVIDER_NAMES[s.provider] ?? s.provider}{s.assetName ? ` · ${s.assetName}` : ""}</span>
                  <span className={cn("shrink-0", failing ? "text-danger" : s.stale ? "text-amber" : "text-muted")}>{failing ? "Error" : s.stale ? "Stale" : ago(s.lastSyncedAt) === "now" ? "Just now" : `${ago(s.lastSyncedAt)} ago`}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="meter" aria-label={`${PROVIDER_NAMES[s.provider] ?? s.provider} freshness`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <div className={cn("h-full rounded-full shadow-[0_0_10px_currentColor]", color)} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1 font-mono text-[10.5px] text-subtle">Data through {s.latestDataDate ?? "—"}{s.isDemo ? " · demo" : ""}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">No data sources yet. <Link to="connections" className="text-accent hover:underline">Connect one</Link> and its freshness appears here.</p>
      )}
    </DeckPanel>
  );
}

type ModuleState = { label: string; status: string; tone: "on" | "warn" | "off" | "bad"; to: string };

/** "Active modules": the platform capabilities for this business and their real state. */
export function Modules({ sources }: { sources: SourceInfo[] }) {
  const b = useBusiness();
  const status = useAssistantStatus(b.id);
  const automations = useAutomations(b.id);
  const actions = useQuery({ queryKey: ["b", b.id, "actions", "list"], queryFn: ({ signal }) => get<ActionProposal[]>(`/businesses/${b.id}/actions`, signal), staleTime: 60_000 });
  const enabled = automations.data?.automations.filter((a) => a.enabled).length ?? 0;
  const pending = actions.data?.filter((a) => a.status === "pending_approval").length ?? 0;
  const failing = sources.filter((s) => s.status === "error" || s.status === "reauth_required").length;
  const syncing = sources.some((s) => s.status === "syncing");
  const items: ModuleState[] = [
    { label: "Assistant", ...(status.data ? (status.data.configured ? { status: "Active", tone: "on" } : { status: "Offline", tone: "off" }) : { status: "…", tone: "off" }), to: "assistant" } as ModuleState,
    { label: "Voice", ...(status.data?.configured && status.data.voice ? { status: "Ready", tone: "on" } : { status: "Off", tone: "off" }), to: "assistant" } as ModuleState,
    { label: "Data sync", ...(!sources.length ? { status: "Standby", tone: "off" } : failing ? { status: `${failing} failing`, tone: "bad" } : syncing ? { status: "Syncing", tone: "warn" } : { status: "Live", tone: "on" }), to: "connections" } as ModuleState,
    { label: "Insight engine", ...(sources.length ? { status: "Active", tone: "on" } : { status: "Standby", tone: "off" }), to: "insights" } as ModuleState,
    { label: "Automations", ...(enabled ? { status: `${enabled} active`, tone: "on" } : { status: "Standby", tone: "off" }), to: "automations" } as ModuleState,
    { label: "Approvals", ...(pending ? { status: `${pending} pending`, tone: "warn" } : { status: "Clear", tone: "on" }), to: "automations?tab=actions" } as ModuleState,
  ];
  const dot = { on: "bg-success shadow-[0_0_8px] shadow-success", warn: "bg-amber shadow-[0_0_8px] shadow-amber", off: "bg-subtle", bad: "bg-danger shadow-[0_0_8px] shadow-danger" };
  return (
    <DeckPanel title="Active modules">
      <ul className="space-y-2">
        {items.map((m) => (
          <li key={m.label}>
            <Link to={m.to} className="flex items-center gap-3 rounded-[4px] border border-line bg-panel-2/70 px-3 py-2.5 transition-colors hover:border-accent/40">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot[m.tone])} />
              <span className="flex-1 text-sm tracking-wide">{m.label}</span>
              <span className={cn("hud-label text-[10.5px]", m.tone === "warn" ? "text-amber" : m.tone === "bad" ? "text-danger" : "text-muted")}>{m.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </DeckPanel>
  );
}

/** "Today's agenda": scheduled automation runs, tasks due and approvals waiting — in the business's timezone. */
export function Agenda() {
  const b = useBusiness();
  const automations = useAutomations(b.id);
  const tasks = useTasks(b.id, "open");
  const actions = useQuery({ queryKey: ["b", b.id, "actions", "list"], queryFn: ({ signal }) => get<ActionProposal[]>(`/businesses/${b.id}/actions`, signal), staleTime: 60_000 });
  const today = todayIn(b.timezone);
  const time = new Intl.DateTimeFormat(undefined, { timeZone: b.timezone, hour: "2-digit", minute: "2-digit", hour12: false });
  const items: { key: string; at: string; title: string; sub: string; to: string; sort: number; tone?: "warn" }[] = [];
  for (const a of automations.data?.automations ?? []) {
    if (a.enabled && a.nextRunAt && todayIn(b.timezone, new Date(a.nextRunAt)) === today) {
      items.push({ key: a.id, at: time.format(new Date(a.nextRunAt)), title: a.name, sub: "Scheduled automation", to: "automations", sort: new Date(a.nextRunAt).getTime() });
    }
  }
  for (const t of tasks.data ?? []) {
    if (t.dueDate && t.dueDate <= today) items.push({ key: t.id, at: t.dueDate < today ? "LATE" : "DUE", title: t.title, sub: `Task${t.assigneeName ? ` · ${t.assigneeName}` : ""}`, to: "insights?tab=tasks", sort: 0, tone: t.dueDate < today ? "warn" : undefined });
  }
  for (const a of actions.data ?? []) {
    if (a.status === "pending_approval") items.push({ key: a.id, at: "NOW", title: `Approve: ${a.target.name}`, sub: a.actionLabel, to: `automations?tab=actions&action=${a.id}`, sort: 1, tone: "warn" });
  }
  items.sort((x, y) => x.sort - y.sort);
  return (
    <DeckPanel title="Today's agenda" right={b.timezone.split("/").pop()?.replace(/_/g, " ")}>
      {items.length ? (
        <ul className="space-y-3">
          {items.slice(0, 6).map((i) => (
            <li key={i.key}>
              <Link to={i.to} className="group flex gap-4">
                <span className={cn("w-12 shrink-0 font-mono text-[13px]", i.tone === "warn" ? "text-amber" : "text-accent")}>{i.at}</span>
                <span className="min-w-0 flex-1 border-b border-line pb-2.5 group-last:border-0">
                  <span className="block truncate text-sm text-fg group-hover:text-accent">{i.title}</span>
                  <span className="block truncate font-mono text-[11px] text-subtle">{i.sub}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing scheduled for today. <Link to="automations" className="text-accent hover:underline">Schedule a briefing</Link>.</p>
      )}
    </DeckPanel>
  );
}

/** Open critical and warning insights. */
export function Alerts() {
  const b = useBusiness();
  const list = useInsights(b.id, "open");
  const items = (list.data?.insights ?? []).filter((i) => i.severity === "critical" || i.severity === "warning");
  return (
    <DeckPanel title="Alerts" warn={items.length > 0} right={items.length ? `${items.length} open` : "All clear"}>
      {items.length ? (
        <ul className="space-y-2.5">
          {items.slice(0, 4).map((i) => (
            <li key={i.id}><Link to="insights" className={cn("block text-sm hover:underline", i.severity === "critical" ? "text-[#fecaca]" : "text-fg")}>{i.title}</Link></li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{list.isLoading ? "Checking…" : "No open alerts."}</p>
      )}
    </DeckPanel>
  );
}

/** A live trend for the business's headline metric (the deck's "network" panel). */
export function Signal({ metric }: { metric: string | null }) {
  const b = useBusiness();
  const query: WidgetSpec["query"] | null = metric
    ? { metric, metrics: [], dimension: null, granularity: "day", dateRange: { preset: "last_28_days" }, comparison: "previous_period", filters: [], sources: [], limit: 8, sort: "value_desc" }
    : null;
  const q = useMetricQuery(b.id, query);
  const r = q.data;
  const series = r?.series ?? [];
  const values = series.flatMap((p) => [p.value, p.comparison]).filter((v): v is number => v != null);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const pts = (key: "value" | "comparison") => series.map((p, i) => (p[key] == null ? null : `${(i / Math.max(1, series.length - 1)) * 300},${80 - ((p[key]! - min) / (max - min || 1)) * 72}`)).filter(Boolean).join(" ");
  const fmt = (v: number | null) => formatMetricValue(v, (r?.metric.unit ?? "count") as MetricUnit, r?.currency ?? b.currency, { compact: true });
  return (
    <DeckPanel title={r?.metric.label ?? "Signal"} right={r ? (r.freshness.stale ? "Stale" : "28 days") : undefined}>
      {!metric ? <p className="text-sm text-muted">A trend appears once a source has imported data.</p> : !r ? <div className="h-24 skeleton" /> : r.availability === "unavailable" ? (
        <p className="text-sm text-muted">{r.unavailableReason}</p>
      ) : (
        <>
          <svg viewBox="0 0 300 84" className="h-24 w-full" role="img" aria-label={`${r.metric.label}, last 28 days`} preserveAspectRatio="none">
            <polyline points={pts("comparison")} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="3 3" strokeOpacity="0.8" vectorEffect="non-scaling-stroke" />
            <polyline points={pts("value")} fill="none" stroke="#22d3ee" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[12px]">
            <span className="text-accent">{fmt(r.total)}</span>
            <span className="text-amber">prev {fmt(r.comparisonTotal)}</span>
            <span className={cn(r.change == null ? "text-subtle" : r.change >= 0 === r.metric.higherIsBetter ? "text-success" : "text-danger")}>{r.change == null ? "—" : `${r.change >= 0 ? "+" : ""}${r.change.toFixed(1)}%`}</span>
          </div>
        </>
      )}
    </DeckPanel>
  );
}

/** Bottom status strip: location in time, encryption, and the newest sync. */
export function StatusStrip({ sources }: { sources: SourceInfo[] }) {
  const b = useBusiness();
  const latest = sources.map((s) => s.lastSyncedAt).filter(Boolean).sort().pop() ?? null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
      <span>TZ {b.timezone.replace(/_/g, " ")} · {b.currency}</span>
      <span>Encryption AES-256 · {sources.length} source{sources.length === 1 ? "" : "s"} linked</span>
      <span>Last sync {latest ? relativeTime(latest) : "—"}</span>
    </div>
  );
}

/** Live clock for the top bar, in the active business's timezone. */
export function DeckClock({ timezone }: { timezone?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const tz = timezone ? { timeZone: timezone } : {};
  return (
    <div className="hidden text-right leading-tight md:block" aria-label="Current time">
      <div className="font-mono text-[19px] tabular-nums tracking-[0.12em] text-fg">{now.toLocaleTimeString([], { ...tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</div>
      <div className="hud-label text-[9.5px] text-subtle">{now.toLocaleDateString([], { ...tz, weekday: "short", day: "2-digit", month: "short", year: "numeric" })}</div>
    </div>
  );
}

/** Online indicator (browser connectivity). */
export function OnlineBadge() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return (
    <span className={cn("hidden items-center gap-2 rounded-[4px] border px-3 py-1.5 sm:inline-flex", online ? "border-success/40 text-success" : "border-danger/40 text-danger")} role="status">
      <span aria-hidden className={cn("size-1.5 rounded-full", online ? "bg-success jv-blink" : "bg-danger")} />
      <span className="hud-label text-[10.5px]">{online ? "Online" : "Offline"}</span>
    </span>
  );
}
