import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AlertTriangle, Clock, Database, Info, Plug, RefreshCw } from "lucide-react";
import { formatRange, type QueryResult } from "@bca/shared";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { Popover } from "@/components/ui/Popover";
import { Skeleton } from "@/components/ui/Spinner";

const PROVIDER_NAMES: Record<string, string> = { shopify: "Shopify", ga4: "GA4", gsc: "Search Console", google_ads: "Google Ads", hubspot: "HubSpot", csv: "CSV" };

export function relativeTime(iso: string | null) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Shared chrome for every widget: title, status chips, source/freshness footer and all data states. */
export function WidgetFrame({ title, result, loading, error, onRetry, actions, children, businessId, bodyClassName, dragHandle }: {
  title: string;
  result?: QueryResult | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  actions?: ReactNode;
  children?: ReactNode;
  businessId: string;
  bodyClassName?: string;
  dragHandle?: boolean;
}) {
  const [info, setInfo] = useState(false);
  const infoRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const providers = [...new Set(result?.sources.map((s) => PROVIDER_NAMES[s.provider] ?? s.provider) ?? [])];

  let body: ReactNode = children;
  if (loading && !result) {
    body = (
      <div className="flex h-full flex-col gap-3 p-1" aria-busy="true">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="w-full flex-1" />
      </div>
    );
  } else if (error && !result) {
    body = (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm">
        <AlertTriangle className="size-5 text-danger" />
        <p className="text-muted">{error instanceof Error ? error.message : "Couldn't load this widget."}</p>
        {onRetry && <button onClick={onRetry} className="inline-flex items-center gap-1 text-accent hover:underline"><RefreshCw className="size-3.5" />Retry</button>}
      </div>
    );
  } else if (result?.availability === "unavailable") {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
        <Plug className="size-5 text-subtle" />
        <p className="text-sm font-medium">Data unavailable</p>
        <p className="max-w-xs text-xs text-muted">{result.unavailableReason}</p>
        <Link to={`/app/b/${businessId}/connections`} className="text-xs font-medium text-accent hover:underline">Go to connections</Link>
      </div>
    );
  }

  return (
    <section aria-labelledby={titleId} className="panel flex h-full flex-col overflow-hidden">
      <header className={cn("flex items-center gap-2 px-4 pb-1 pt-3", dragHandle && "widget-drag cursor-grab active:cursor-grabbing")}>
        <h3 id={titleId} className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg/90">{title}</h3>
        {result?.availability === "partial" && <Badge tone="warning" icon={<AlertTriangle className="size-3" />}>Partial</Badge>}
        {result?.freshness.stale && <Badge tone="warning" icon={<Clock className="size-3" />}>Stale</Badge>}
        {result && (
          <>
            <button ref={infoRef} aria-expanded={info} aria-label={`About ${title}: sources, definition and freshness`} onClick={() => setInfo(!info)}
              className="widget-nodrag grid size-7 place-items-center rounded-md text-subtle hover:bg-white/5 hover:text-fg">
              <Info className="size-3.5" />
            </button>
            <Popover open={info} onClose={() => setInfo(false)} anchor={infoRef} align="end" className="w-80 p-4 text-sm">
              <MetricInfo result={result} />
            </Popover>
          </>
        )}
        {actions}
      </header>
      <div className={cn("widget-nodrag min-h-0 flex-1 px-4 py-2", bodyClassName)}>{body}</div>
      {result && result.availability !== "unavailable" && (
        <footer className="flex items-center gap-2 truncate border-t border-line/70 px-4 py-1.5 text-[11px] text-subtle">
          <Database className="size-3 shrink-0" />
          <span className="max-w-[60%] shrink-0 truncate">{providers.join(" · ") || "No source"}</span>
          {result.isDemo && <span className="shrink-0 font-medium text-demo">Demo data</span>}
          <span aria-hidden>·</span>
          <span className="truncate">{formatRange(result.range)}</span>
          {result.freshness.lastSyncedAt && !result.isDemo && <span className="ml-auto shrink-0">Synced {relativeTime(result.freshness.lastSyncedAt)}</span>}
        </footer>
      )}
    </section>
  );
}

export function MetricInfo({ result }: { result: QueryResult }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-semibold">{result.metric.label}</p>
        <p className="mt-1 text-xs text-muted">{result.metric.description}</p>
        {result.metric.formula && <p className="mt-1.5 rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] text-accent">{result.metric.formula}</p>}
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-subtle">Period</dt><dd>{formatRange(result.range)} ({result.timezone})</dd>
        {result.comparisonRange && <><dt className="text-subtle">Compared to</dt><dd>{formatRange(result.comparisonRange)}</dd></>}
        <dt className="text-subtle">Currency</dt><dd>{result.currency}</dd>
        <dt className="text-subtle">Latest data</dt><dd>{result.freshness.latestDataDate ?? "—"}</dd>
      </dl>
      <div>
        <p className="mb-1 text-xs font-medium text-subtle">Sources</p>
        <ul className="space-y-1.5">
          {result.sources.map((s) => (
            <li key={s.connectionId} className="text-xs">
              <span className="font-medium">{s.accountName}</span>
              {s.assetName && <span className="text-muted"> — {s.assetName}</span>}
              <div className="text-subtle">
                {s.isDemo ? "Demo data" : `Last sync ${relativeTime(s.lastSyncedAt)}`}{s.stale && " · stale"}{s.reportingDelay && ` · ${s.reportingDelay}`}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {result.limitations.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-warning">Limitations</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted">{result.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
