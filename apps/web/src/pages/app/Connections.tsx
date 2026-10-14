import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Download, ExternalLink, FileUp, History, KeyRound, Loader2, Plug, RefreshCw, Settings2, ShieldCheck, Unplug, Upload, XCircle } from "lucide-react";
import { can } from "@bca/shared";
import { del, get, post, put, errorMessage } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { cn } from "@/lib/cn";
import { Badge, DemoBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, Prerequisite } from "@/components/ui/EmptyState";
import { Field, Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/components/widgets/WidgetFrame";
import { Tabs } from "@/components/ui/Tabs";

interface CatalogEntry {
  id: string; name: string; category: string; description: string;
  status: "available" | "config_required" | "access_pending" | "planned";
  statusNote: string; missingConfig: string[]; accessRequirements: string[];
  scopes: { scope: string; reason: string; optional?: boolean }[];
  metrics: string[]; actions: string[]; reportingDelay: string | null;
  connectFields?: { key: string; label: string; placeholder?: string; help?: string }[];
  supportsWebhooks: boolean;
  /** Has a provider sign-in flow. */
  oauth: boolean;
  /** Connect by pasting an access token created in the provider (works without platform OAuth credentials). */
  tokenConnect: { fields: { key: string; label: string; placeholder?: string; help?: string; secret?: boolean; optional?: boolean }[]; instructions: string[] } | null;
}

/** Display order of catalog categories. */
const CATEGORY_ORDER = ["Commerce", "Payments", "Advertising", "Analytics", "Search", "Social", "Email", "CRM", "Support", "Accounting", "Inventory", "Data import"];
/** CSV files are uploaded from the browser rather than connected. */
const isUpload = (e: { id: string }) => e.id === "csv";

/** Whether a catalog entry can be connected right now, by either method. */
const connectable = (e: CatalogEntry) => e.status === "available" || (Boolean(e.tokenConnect) && e.status !== "planned");

interface Asset { id: string; name: string; kind: string; selected: boolean; currency: string | null; timezone: string | null; latestDataDate: string | null; lastSyncedAt: string | null; coveredFrom: string | null }
interface Connection {
  id: string; provider: string; providerName: string; accountName: string; externalAccountId: string | null;
  status: "pending" | "selecting_assets" | "syncing" | "active" | "error" | "reauth_required" | "disconnected";
  isDemo: boolean; scopes: string[]; requestedScopes: { scope: string; reason: string; optional?: boolean }[];
  assets: Asset[]; lastSuccessAt: string | null; lastSyncStartedAt: string | null; lastError: string | null; lastErrorAt: string | null;
  consecutiveFailures: number; webhookTopics: string[]; reportingDelay: string | null; authMode: "oauth" | "token";
  latestJob: { id: string; status: string; attempts: number; lastError: string | null; createdAt: string; finishedAt: string | null; nextAttemptAt: string | null; result: any } | null;
  connectedAt: string; disconnectedAt: string | null;
}

const STATUS_LABEL: Record<CatalogEntry["status"], { label: string; tone: "success" | "warning" | "violet" | "neutral" }> = {
  available: { label: "Available", tone: "success" },
  config_required: { label: "Configuration required", tone: "warning" },
  access_pending: { label: "Provider access pending", tone: "violet" },
  planned: { label: "Planned", tone: "neutral" },
};

export const connectionsKey = (bid: string) => ["b", bid, "connections"] as const;

export function Connections() {
  const b = useBusiness();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const manage = can(b.role, "connection.manage");
  const catalog = useQuery({ queryKey: ["b", b.id, "connectors"], queryFn: ({ signal }) => get<CatalogEntry[]>(`/businesses/${b.id}/connectors`, signal) });
  const connections = useQuery({
    queryKey: connectionsKey(b.id),
    queryFn: ({ signal }) => get<Connection[]>(`/businesses/${b.id}/connections`, signal),
    // Poll while something is syncing (SSE also pushes updates).
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === "syncing" || c.latestJob?.status === "running" || c.latestJob?.status === "queued") ? 4000 : false),
  });
  const [connecting, setConnecting] = useState<CatalogEntry | null>(null);
  const [assetsFor, setAssetsFor] = useState<Connection | null>(null);
  const oauthError = params.get("oauth_error");

  // Returning from the provider: open account selection or confirm reconnection.
  useEffect(() => {
    const id = params.get("connection");
    if (!id || !connections.data) return;
    const c = connections.data.find((x) => x.id === id);
    if (params.get("step") === "assets" && c) setAssetsFor(c);
    if (params.get("reconnected")) toast(`${c?.providerName ?? "Account"} reconnected`);
    setParams({}, { replace: true });
  }, [params, connections.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = (connections.data ?? []).filter((c) => c.status !== "disconnected");
  const disconnected = (connections.data ?? []).filter((c) => c.status === "disconnected");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ connectionId?: string } | null>(null);
  const categories = useMemo(() => [...new Set((catalog.data ?? []).map((e) => e.category))].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)), [catalog.data]);
  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const m = new Map<string, CatalogEntry[]>();
    for (const e of catalog.data ?? []) {
      if (category && e.category !== category) continue;
      if (term && !`${e.name} ${e.category} ${e.description}`.toLowerCase().includes(term)) continue;
      m.set(e.category, [...(m.get(e.category) ?? []), e]);
    }
    return [...m.entries()].sort(([a], [b]) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  }, [catalog.data, search, category]);
  const openEntry = (e: CatalogEntry) => (isUpload(e) ? setUploading({}) : setConnecting(e));

  return (
    <>
      <PageHeader title="Connections" description={`Accounts connected to ${b.name}. Credentials stay encrypted on our servers and are never sent to your browser.`} />
      {oauthError && (
        <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
          <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="flex-1">{oauthError}</span>
          <button className="text-xs text-muted hover:text-fg" onClick={() => setParams({}, { replace: true })}>Dismiss</button>
        </div>
      )}
      {b.isDemo && <div className="mb-5"><Prerequisite title="Demo business">These connections are simulated and can't sync or be changed. Create a real business to connect your own accounts.</Prerequisite></div>}
      {!manage && !b.isDemo && <div className="mb-5"><Prerequisite title="View only">Only business administrators can connect or disconnect accounts.</Prerequisite></div>}

      <section aria-labelledby="connected-h" className="mb-10">
        <h2 id="connected-h" className="mb-3 text-[15px] font-semibold">Connected accounts</h2>
        {connections.isPending ? <Skeleton className="h-40" /> : connections.error ? <ErrorState error={connections.error} onRetry={() => connections.refetch()} /> : active.length ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {active.map((c) => <ConnectionCard key={c.id} c={c} manage={manage && !c.isDemo} onChooseAssets={() => setAssetsFor(c)} onReconnect={() => setConnecting(catalog.data?.find((e) => e.id === c.provider) ?? null)} onUpload={c.provider === "csv" ? () => setUploading({ connectionId: c.id }) : undefined} />)}
          </div>
        ) : (
          <EmptyState icon={<Plug className="size-5" />} title="Nothing connected yet">Connect a source below. Imports run in the background; you can keep working while data arrives.</EmptyState>
        )}
        {disconnected.length > 0 && (
          <details className="mt-4 text-sm text-muted">
            <summary className="cursor-pointer">{disconnected.length} disconnected</summary>
            <ul className="mt-2 space-y-1">{disconnected.map((c) => <li key={c.id}>{c.providerName} · {c.accountName} — disconnected {relativeTime(c.disconnectedAt)}. Imported data was kept; remove it by disconnecting from a connected state with “delete data”.</li>)}</ul>
          </details>
        )}
      </section>

      <section aria-labelledby="catalog-h">
        <h2 id="catalog-h" className="mb-1 text-[15px] font-semibold">Add a source</h2>
        <p className="mb-4 text-sm text-muted">Connectors marked <b className="text-success">Available</b> are working integrations. Many connect with an API key or access token from your own account — you enter it here and it's encrypted on our servers.</p>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <Input aria-label="Search connectors" placeholder="Search connectors…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-64" />
          <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-1.5">
            {[null, ...categories].map((c) => (
              <button key={c ?? "all"} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}
                className={cn("rounded-[4px] border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors", category === c ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg")}>
                {c ?? "All"}
              </button>
            ))}
          </div>
        </div>
        {catalog.isPending ? <Skeleton className="h-60" /> : !groups.length ? <p className="text-sm text-muted">No connectors match “{search}”.</p> : groups.map(([cat, entries]) => (
          <div key={cat} className="mb-6">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-subtle">{cat}</h3>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {entries.map((e) => (
                <li key={e.id} className={cn("panel flex flex-col gap-3 p-4", e.status === "planned" && "opacity-70")}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">{e.name}</p>
                    {e.status === "config_required" && e.tokenConnect ? <Badge tone="success">Available · token</Badge> : e.status === "available" && isUpload(e) ? <Badge tone="success">Available · upload</Badge> : <Badge tone={STATUS_LABEL[e.status].tone}>{STATUS_LABEL[e.status].label}</Badge>}
                  </div>
                  <p className="text-sm text-muted">{e.description}</p>
                  <p className="text-xs text-subtle">{e.statusNote}</p>
                  {e.status !== "planned" && (
                    <Button size="sm" variant={connectable(e) ? "primary" : "secondary"} className="mt-auto self-start" disabled={!manage || b.isDemo} onClick={() => openEntry(e)}>
                      {isUpload(e) ? "Upload CSV" : connectable(e) ? "Connect" : "Details"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <ConnectDialog entry={connecting} onClose={() => setConnecting(null)} reconnectId={connecting ? active.find((c) => c.provider === connecting.id && c.status === "reauth_required")?.id : undefined}
        onConnected={async (id) => {
          setConnecting(null);
          const list = await qc.fetchQuery({ queryKey: connectionsKey(b.id), queryFn: () => get<Connection[]>(`/businesses/${b.id}/connections`), staleTime: 0 });
          const c = list.find((x) => x.id === id);
          toast("Connected — choose what to sync");
          if (c?.status === "selecting_assets") setAssetsFor(c);
        }} />
      <CsvUploadDialog open={Boolean(uploading)} connectionId={uploading?.connectionId} onClose={() => setUploading(null)} onDone={() => { setUploading(null); qc.invalidateQueries({ queryKey: ["b", b.id] }); }} />
      <AssetsDialog connection={assetsFor} onClose={() => setAssetsFor(null)} onSaved={() => { setAssetsFor(null); qc.invalidateQueries({ queryKey: connectionsKey(b.id) }); toast("Import started — data appears as it arrives."); }} />
    </>
  );
}

function StatusBadge({ c }: { c: Connection }) {
  const map: Record<Connection["status"], { tone: "success" | "warning" | "danger" | "accent" | "neutral"; label: string; icon: React.ReactNode }> = {
    active: { tone: "success", label: "Active", icon: <CheckCircle2 className="size-3" /> },
    syncing: { tone: "accent", label: "Syncing", icon: <Loader2 className="size-3 animate-spin" /> },
    selecting_assets: { tone: "warning", label: "Choose accounts", icon: <Settings2 className="size-3" /> },
    pending: { tone: "neutral", label: "Pending", icon: <Clock className="size-3" /> },
    error: { tone: "danger", label: "Error", icon: <AlertTriangle className="size-3" /> },
    reauth_required: { tone: "danger", label: "Reconnect needed", icon: <KeyRound className="size-3" /> },
    disconnected: { tone: "neutral", label: "Disconnected", icon: <Unplug className="size-3" /> },
  };
  const s = map[c.status];
  return <Badge tone={s.tone} icon={s.icon}>{s.label}</Badge>;
}

function ConnectionCard({ c, manage, onChooseAssets, onReconnect, onUpload }: { c: Connection; manage: boolean; onChooseAssets: () => void; onReconnect: () => void; onUpload?: () => void }) {
  const b = useBusiness();
  const qc = useQueryClient();
  const toast = useToast();
  const [disconnecting, setDisconnecting] = useState(false);
  const [history, setHistory] = useState(false);
  const selected = c.assets.filter((a) => a.selected);
  const coveredFrom = selected.map((a) => a.coveredFrom).filter(Boolean).sort()[0];
  const latest = selected.map((a) => a.latestDataDate).filter(Boolean).sort().pop();
  const sync = useMutation({
    mutationFn: () => post<{ alreadyQueued: boolean }>(`/businesses/${b.id}/connections/${c.id}/sync`),
    onSuccess: (r) => { toast(r.alreadyQueued ? "A sync is already queued." : "Sync started"); qc.invalidateQueries({ queryKey: connectionsKey(b.id) }); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const job = c.latestJob;
  const missingScopes = c.requestedScopes.filter((s) => !s.optional && !c.scopes.includes(s.scope));

  return (
    <article className="panel flex flex-col gap-4 p-5" aria-label={`${c.providerName} connection`}>
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wider text-subtle">{c.providerName}</p>
          <p className="truncate text-base font-semibold">{c.accountName}</p>
          {c.externalAccountId && <p className="truncate text-xs text-muted">{c.externalAccountId}</p>}
        </div>
        {c.isDemo ? <DemoBadge /> : <StatusBadge c={c} />}
      </header>

      {(c.status === "reauth_required" || c.status === "error") && c.lastError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="flex-1">{c.lastError}<span className="block text-xs text-muted">{relativeTime(c.lastErrorAt)}</span></span>
        </div>
      )}

      <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm [&_dd]:min-w-0 [&_dd]:break-words">
        <dt className="text-subtle">Accounts synced</dt>
        <dd>{selected.length ? selected.map((a) => `${a.name}${a.currency ? ` (${a.currency})` : ""}`).join(", ") : <span className="text-warning">None selected</span>}</dd>
        <dt className="text-subtle">Last successful sync</dt>
        <dd>{c.isDemo ? "Demo data" : c.lastSuccessAt ? `${relativeTime(c.lastSuccessAt)} · ${new Date(c.lastSuccessAt).toLocaleString()}` : "Not yet"}</dd>
        <dt className="text-subtle">Data available</dt>
        <dd>{coveredFrom || latest ? `${coveredFrom ?? "…"} → ${latest ?? "…"}` : "—"}{c.reportingDelay && <span className="block text-xs text-subtle">{c.reportingDelay}</span>}</dd>
        <dt className="text-subtle">Sync status</dt>
        <dd>
          {!job ? "—" : job.status === "running" ? <span className="inline-flex items-center gap-1 text-accent"><Loader2 className="size-3.5 animate-spin" />Running</span>
            : job.status === "queued" ? <span className="text-muted">{job.attempts ? `Retrying ${job.nextAttemptAt ? relativeTime(job.nextAttemptAt).replace(" ago", "") : "soon"} (attempt ${job.attempts + 1})` : "Queued"}</span>
            : job.status === "failed" ? <span className="text-danger">Failed after {job.attempts} attempt{job.attempts === 1 ? "" : "s"}</span>
            : <span className="text-success">Completed {relativeTime(job.finishedAt)}</span>}
        </dd>
        <dt className="text-subtle">Permissions</dt>
        <dd className="flex flex-wrap gap-1">
          {c.scopes.length ? c.scopes.map((s) => <Badge key={s} icon={<ShieldCheck className="size-3" />} title={s}>{shortScope(s)}</Badge>) : <span className="text-muted">—</span>}
          {missingScopes.length > 0 && <span className="w-full text-xs text-warning">Missing: {missingScopes.map((s) => s.scope).join(", ")} — reconnect to grant.</span>}
        </dd>
        <dt className="text-subtle">Live updates</dt>
        <dd>{onUpload ? "Updated when you upload a new file" : c.webhookTopics.length ? `Webhooks active (${c.webhookTopics.length} topics)` : "Scheduled syncs"}</dd>
      </dl>

      {manage && (
        <footer className="flex flex-wrap gap-2 border-t border-line pt-4">
          {c.status === "reauth_required" ? (
            <Button size="sm" variant="primary" icon={<KeyRound className="size-4" />} onClick={onReconnect}>Reconnect</Button>
          ) : c.status === "selecting_assets" ? (
            <Button size="sm" variant="primary" icon={<Settings2 className="size-4" />} onClick={onChooseAssets}>Choose accounts</Button>
          ) : onUpload ? (
            <Button size="sm" icon={<Upload className="size-4" />} onClick={onUpload}>Upload new file</Button>
          ) : (
            <Button size="sm" icon={<RefreshCw className={cn("size-4", sync.isPending && "animate-spin")} />} onClick={() => sync.mutate()} disabled={c.status === "syncing"}>Sync now</Button>
          )}
          {c.status !== "selecting_assets" && c.assets.length > 1 && <Button size="sm" variant="ghost" onClick={onChooseAssets}>Change accounts</Button>}
          <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setHistory(true)}>History</Button>
          <Button size="sm" variant="ghost" className="ml-auto text-danger/80 hover:text-danger" icon={<Unplug className="size-4" />} onClick={() => setDisconnecting(true)}>Disconnect</Button>
        </footer>
      )}
      <DisconnectDialog open={disconnecting} onClose={() => setDisconnecting(false)} c={c} />
      <HistoryDialog open={history} onClose={() => setHistory(false)} c={c} />
    </article>
  );
}

function ConnectDialog({ entry, onClose, reconnectId, onConnected }: { entry: CatalogEntry | null; onClose: () => void; reconnectId?: string; onConnected: (connectionId: string) => void }) {
  const b = useBusiness();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauthReady = entry?.status === "available" && entry.oauth;
  const [method, setMethod] = useState<"oauth" | "token">("oauth");
  useEffect(() => { setValues({}); setError(null); setMethod(entry && !oauthReady && entry.tokenConnect ? "token" : "oauth"); }, [entry?.id, oauthReady]);
  if (!entry) return null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (method === "token") {
        const r = await post<{ connectionId: string }>(`/businesses/${b.id}/connections/${entry.id}/token`, { input: values });
        setBusy(false);
        onConnected(r.connectionId);
        return;
      }
      const r = await post<{ url: string }>(`/businesses/${b.id}/connections/${entry.id}/authorize`, { input: values, connectionId: reconnectId });
      window.location.assign(r.url); // official provider authorization page
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const token = entry.tokenConnect;
  const canSubmit = method === "token" ? Boolean(token?.fields.every((f) => f.optional || values[f.key]?.trim())) : oauthReady;
  return (
    <Dialog open onClose={onClose} title={`${reconnectId ? "Reconnect" : "Connect"} ${entry.name}`} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>{(method === "token" ? Boolean(token) : oauthReady) && (
        <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={go} icon={method === "token" ? <KeyRound className="size-4" /> : <ExternalLink className="size-4" />}>{method === "token" ? "Connect" : `Continue to ${entry.name}`}</Button>
      )}</>}>
      <div className="space-y-5 text-sm">
        <p className="text-muted">{entry.description}</p>
        {token && entry.oauth && (
          <Tabs value={method} onChange={(v) => { setMethod(v); setError(null); }} items={[{ value: "oauth", label: `Sign in with ${entry.name}` }, { value: "token", label: "Use an access token" }]} />
        )}
        {method === "oauth" && (
          <>
            {entry.status === "config_required" && (
              <Prerequisite tone="warning" title="One-click sign-in isn't set up yet">
                A platform administrator can add the {entry.name} app credentials in <b>Platform admin → Credentials</b> (<code className="text-fg">{entry.missingConfig.join(", ")}</code>).{token ? " Meanwhile you can connect with an access token." : ""}
              </Prerequisite>
            )}
            {entry.status === "access_pending" && <Prerequisite tone="warning" title="Waiting for provider approval">{entry.name} hasn't approved this platform's access yet.</Prerequisite>}
            {oauthReady && entry.connectFields?.map((f) => (
              <Field key={f.key} label={f.label} hint={f.help}>{(p) => <Input {...p} data-autofocus placeholder={f.placeholder} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}</Field>
            ))}
          </>
        )}
        {method === "token" && token && (
          <>
            <ol className="list-decimal space-y-1.5 pl-5 text-muted">{token.instructions.map((t) => <li key={t}>{t}</li>)}</ol>
            {token.fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.optional ? " (optional)" : ""}`} hint={f.help}>{(p) => <Input {...p} type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={f.placeholder} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}</Field>
            ))}
            <p className="text-xs text-subtle">The key is checked with {entry.name}, encrypted before it's stored and never shown again. Data syncs on a schedule. You can revoke it in {entry.name} at any time.</p>
          </>
        )}
        {entry.scopes.length > 0 && <div>
          <p className="mb-2 font-medium">Permissions needed (read-only)</p>
          <ul className="space-y-1.5">
            {entry.scopes.map((s) => (
              <li key={s.scope} className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" /><span><code className="break-all text-xs text-fg">{shortScope(s.scope)}</code> — <span className="text-muted">{s.reason}{s.optional ? " (optional)" : ""}</span></span></li>
            ))}
          </ul>
        </div>}
        {entry.accessRequirements.length > 0 && (
          <details>
            <summary className="cursor-pointer text-muted">Provider requirements</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">{entry.accessRequirements.map((r) => <li key={r}>{r}</li>)}</ul>
          </details>
        )}
        {method === "oauth" && <p className="text-xs text-subtle">You'll be sent to {entry.name} to approve access, then brought back to choose which accounts to sync. You can skip this and connect later.</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function AssetsDialog({ connection, onClose, onSaved }: { connection: Connection | null; onClose: () => void; onSaved: () => void }) {
  const b = useBusiness();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!connection) return;
    const pre = connection.assets.filter((a) => a.selected).map((a) => a.id);
    setSelected(pre.length ? pre : connection.assets.length === 1 ? [connection.assets[0]!.id] : []);
  }, [connection]);
  if (!connection) return null;
  const mismatch = connection.assets.filter((a) => selected.includes(a.id) && ((a.currency && a.currency !== b.currency) || (a.timezone && a.timezone !== b.timezone)));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/businesses/${b.id}/connections/${connection.id}/assets`, { assetIds: selected });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Choose ${connection.providerName} accounts`} description={`Only selected accounts are imported into ${b.name}.`}
      footer={<><Button variant="ghost" onClick={onClose}>Later</Button><Button variant="primary" loading={busy} disabled={!selected.length} onClick={save}>Start import</Button></>}>
      <ul className="space-y-2">
        {connection.assets.map((a) => (
          <li key={a.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2.5 hover:border-line-strong">
              <input type="checkbox" className="size-4 accent-[#22d3ee]" checked={selected.includes(a.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, a.id] : selected.filter((x) => x !== a.id))} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{a.name}</span><span className="text-xs text-muted">{a.kind}{a.currency ? ` · ${a.currency}` : ""}{a.timezone ? ` · ${a.timezone}` : ""}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {mismatch.length > 0 && (
        <p className="mt-3 text-xs text-warning">
          Note: {mismatch.map((a) => a.name).join(", ")} report{mismatch.length === 1 ? "s" : ""} in a different currency or timezone than {b.name} ({b.currency}, {b.timezone}). Figures are labelled with the account's currency and days follow the account's timezone; nothing is converted silently.
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}

function DisconnectDialog({ open, onClose, c }: { open: boolean; onClose: () => void; c: Connection }) {
  const b = useBusiness();
  const qc = useQueryClient();
  const toast = useToast();
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={`Disconnect ${c.providerName}?`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await del<{ revoked: boolean }>(`/businesses/${b.id}/connections/${c.id}`, { deleteData });
          await qc.invalidateQueries({ queryKey: ["b", b.id] });
          toast(r.revoked ? "Disconnected and access revoked" : "Disconnected. We couldn't confirm revocation with the provider — remove the app there too.", r.revoked ? "success" : "info");
          onClose();
        } catch (e) {
          toast(errorMessage(e), "error");
        } finally {
          setBusy(false);
        }
      }}>Disconnect</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">We'll revoke access at {c.providerName}, delete the stored credentials and stop syncing {c.accountName}.</p>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 accent-[#f87171]" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} /><span>Also delete all data imported from this account. Widgets using it will show “unavailable”.</span></label>
      </div>
    </Dialog>
  );
}

function HistoryDialog({ open, onClose, c }: { open: boolean; onClose: () => void; c: Connection }) {
  const b = useBusiness();
  const jobs = useQuery({
    queryKey: ["b", b.id, "connections", c.id, "jobs"],
    queryFn: ({ signal }) => get<{ id: string; type: string; status: string; attempts: number; max_attempts: number; last_error: string | null; created_at: string; finished_at: string | null; result: any }[]>(`/businesses/${b.id}/connections/${c.id}/jobs`, signal),
    enabled: open,
  });
  return (
    <Dialog open={open} onClose={onClose} title="Sync history" description={`${c.providerName} · ${c.accountName}`} size="lg">
      {jobs.isPending ? <Skeleton className="h-40" /> : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-subtle"><tr><th className="py-1 font-medium">When</th><th className="font-medium">Type</th><th className="font-medium">Result</th></tr></thead>
          <tbody>
            {jobs.data?.map((j) => (
              <tr key={j.id} className="border-t border-line/60 align-top">
                <td className="py-2 pr-3 text-xs text-muted">{new Date(j.created_at).toLocaleString()}</td>
                <td className="py-2 pr-3">{j.type.replace("connection.", "")}{j.result?.mode ? ` (${j.result.mode})` : ""}</td>
                <td className="py-2">
                  <span className={j.status === "failed" ? "text-danger" : j.status === "succeeded" ? "text-success" : "text-muted"}>{j.status}</span>
                  {j.attempts > 1 && <span className="text-xs text-subtle"> · {j.attempts} attempts</span>}
                  {j.result?.results?.map((r: any, i: number) => <span key={i} className="block text-xs text-muted">{r.records} records · {r.datesRecomputed} days updated{r.notes?.length ? ` · ${r.notes.join(" ")}` : ""}</span>)}
                  {j.last_error && <span className="block text-xs text-danger/80">{j.last_error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

interface UploadResult { connectionId: string; rows: number; metrics: { key: string; label: string }[]; from: string | null; to: string | null; ignoredColumns: string[]; warnings: string[] }
interface ImportColumn { key: string; label: string; unit: string; aggregation: string; category: string }

/** Upload daily figures as CSV (a new import, or a replacement file for an existing one). */
function CsvUploadDialog({ open, connectionId, onClose, onDone }: { open: boolean; connectionId?: string; onClose: () => void; onDone: () => void }) {
  const b = useBusiness();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const columns = useQuery({ queryKey: ["b", b.id, "import-columns"], queryFn: ({ signal }) => get<ImportColumn[]>(`/businesses/${b.id}/imports/columns`, signal), enabled: open });
  useEffect(() => { if (open) { setFile(null); setError(null); setResult(null); } }, [open]);
  if (!open) return null;
  const MAX = 5 * 1024 * 1024;
  const upload = async () => {
    if (!file) return;
    if (file.size > MAX) return setError("That file is larger than 5 MB. Split it into smaller files.");
    setBusy(true);
    setError(null);
    try {
      const content = await file.text();
      const r = await post<UploadResult>(`/businesses/${b.id}/imports/csv`, { fileName: file.name, content, ...(connectionId ? { connectionId } : {}) });
      setResult(r);
      toast(`Imported ${r.rows} row${r.rows === 1 ? "" : "s"}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={result ? onDone : onClose} title={connectionId ? "Upload a replacement file" : "Upload figures from a CSV file"} size="lg"
      footer={result ? <Button variant="primary" onClick={onDone}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!file} onClick={upload} icon={<Upload className="size-4" />}>Upload</Button></>}>
      {result ? (
        <div className="space-y-3 text-sm">
          <p className="flex items-center gap-2 text-success"><CheckCircle2 className="size-4" />{result.rows} rows imported{result.from ? ` · ${result.from} → ${result.to}` : ""}</p>
          <p className="text-muted">Metrics: {result.metrics.map((m) => m.label).join(", ") || "none"}</p>
          {result.ignoredColumns.length > 0 && <p className="text-xs text-warning">Ignored columns (not recognised): {result.ignoredColumns.join(", ")}</p>}
          {result.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-warning">{result.warnings.slice(0, 8).map((w) => <li key={w}>{w}</li>)}{result.warnings.length > 8 && <li>…and {result.warnings.length - 8} more</li>}</ul>}
          <p className="text-xs text-subtle">Figures from uploads are used only for metrics no connected platform provides.</p>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-muted">One row per day: a <code className="text-fg">date</code> column (YYYY-MM-DD) and one column per metric, named by the metric's name or key. Empty cells mean “no data”, not zero. Money is in {b.currency} unless you add a <code className="text-fg">currency</code> column.{connectionId ? " The new file replaces everything from the previous one." : ""}</p>
          <a className="inline-flex items-center gap-1.5 text-accent hover:underline" href={`/api/businesses/${b.id}/imports/csv/template`} download><Download className="size-4" />Download a template</a>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-[6px] border border-dashed border-line-strong px-4 py-8 text-center hover:border-accent/60">
            <FileUp className="size-6 text-accent" />
            <span className="font-medium">{file ? file.name : "Choose a .csv file"}</span>
            <span className="text-xs text-subtle">{file ? `${(file.size / 1024).toFixed(1)} KB` : "Up to 5 MB"}</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
          </label>
          {columns.data && (
            <details>
              <summary className="cursor-pointer text-muted">Columns you can import ({columns.data.length})</summary>
              <ul className="mt-2 grid max-h-56 gap-x-4 gap-y-1 overflow-y-auto text-xs sm:grid-cols-2">
                {columns.data.map((c) => <li key={c.key}><code className="text-fg">{c.key}</code> <span className="text-muted">— {c.label}{c.aggregation === "snapshot" ? " (end-of-day level)" : ""}</span></li>)}
              </ul>
            </details>
          )}
          {error && <p role="alert" className="whitespace-pre-line text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

/** Google scopes are URLs; show their last segment (full value in the tooltip). */
const shortScope = (s: string) => s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");
