import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Zap } from "lucide-react";
import { can, type ActionProposal, type ActionTarget, type ActionTypeInfo } from "@bca/shared";
import { errorMessage, get, post } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { useMe } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, Prerequisite } from "@/components/ui/EmptyState";
import { Field, Input, Select } from "@/components/ui/Field";
import { Skeleton, Spinner } from "@/components/ui/Spinner";
import { Tabs } from "@/components/ui/Tabs";
import { ActionCard } from "./ActionCard";

export const actionKeys = {
  list: (b: string) => ["b", b, "actions", "list"] as const,
  types: (b: string) => ["b", b, "actions", "types"] as const,
};

export function ActionsPanel({ focus }: { focus?: string | null }) {
  const b = useBusiness();
  const me = useMe();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: actionKeys.list(b.id), queryFn: ({ signal }) => get<ActionProposal[]>(`/businesses/${b.id}/actions`, signal), refetchInterval: (q) => (q.state.data?.some((a) => ["approved", "executing", "needs_check"].includes(a.status)) ? 2000 : false) });
  const types = useQuery({ queryKey: actionKeys.types(b.id), queryFn: ({ signal }) => get<ActionTypeInfo[]>(`/businesses/${b.id}/actions/types`, signal) });
  const rows = (list.data ?? []).filter((a) => filter === "all" || a.status === "pending_approval" || a.id === focus);
  useEffect(() => { if (focus) document.getElementById(`act-${focus}`)?.scrollIntoView({ block: "center" }); }, [focus, list.data]);
  return (
    <div className="space-y-4">
      <Prerequisite title="How actions work">
        Changes in connected accounts are proposed first, showing current and proposed values and the expected effect. A business owner or administrator approves the exact change; it then runs once, after re-checking the current value. Every step is logged.
      </Prerequisite>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onChange={setFilter} items={[{ value: "pending", label: `Waiting for approval${list.data ? ` (${list.data.filter((a) => a.status === "pending_approval").length})` : ""}` }, { value: "all", label: "History" }]} />
        {can(b.role, "action.propose") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={!types.data?.some((t) => t.available)}>New action</Button>}
      </div>
      {types.data && !types.data.length && <p className="text-sm text-muted">None of this business's connections support actions. Google Ads (pause/enable campaigns, daily budgets) and HubSpot (deal stages) do.</p>}
      {types.data?.some((t) => !t.available) && (
        <ul className="space-y-1 text-xs text-subtle">{types.data.filter((t) => !t.available).map((t) => <li key={t.type + t.connectionId}>{t.providerName} · {t.label}: {t.unavailableReason}</li>)}</ul>
      )}
      {list.isLoading ? <Skeleton className="h-40" /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? (
        <EmptyState icon={<Zap className="size-5" />} title={filter === "pending" ? "Nothing waiting for approval" : "No actions yet"}>
          Propose a change here, or ask the assistant (for example "pause the Brand Search campaign"). Nothing changes until it's approved.
        </EmptyState>
      ) : (
        <div className="space-y-3">{rows.map((a) => <ActionCard key={a.id} business={b} action={a} me={me.data?.user.id ?? ""} compact={a.status !== "pending_approval" && a.id !== focus} />)}</div>
      )}
      {creating && <NewActionDialog types={(types.data ?? []).filter((t) => t.available)} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewActionDialog({ types, onClose }: { types: ActionTypeInfo[]; onClose: () => void }) {
  const b = useBusiness();
  const qc = useQueryClient();
  const [choice, setChoice] = useState(types[0] ? `${types[0].connectionId}|${types[0].type}` : "");
  const [connectionId, type] = choice.split("|");
  const targets = useQuery({ queryKey: ["b", b.id, "actions", "targets", connectionId, type], queryFn: ({ signal }) => get<ActionTarget[]>(`/businesses/${b.id}/actions/targets?connectionId=${connectionId}&type=${encodeURIComponent(type!)}`, signal), enabled: Boolean(connectionId && type), staleTime: 0 });
  const [targetId, setTargetId] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const target = targets.data?.find((t) => t.id === targetId) ?? null;
  useEffect(() => { setTargetId(""); setParams({}); }, [choice]);
  useEffect(() => { setParams({}); }, [targetId]);
  const create = useMutation({
    mutationFn: () => post<ActionProposal>(`/businesses/${b.id}/actions`, { connectionId, type, targetId, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, target?.fields.find((f) => f.key === k)?.kind === "money" ? Number(v) : v])) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["b", b.id, "actions"] }); onClose(); },
    onError: (e) => setError(errorMessage(e)),
  });
  const ready = target && target.fields.every((f) => params[f.key]);
  return (
    <Dialog open onClose={onClose} size="lg" title="Propose a change" description="Values are read live from the account. Nothing changes until an administrator approves."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready} loading={create.isPending} onClick={() => { setError(null); create.mutate(); }}>Prepare for approval</Button></>}>
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#fecaca]">{error}</p>}
        <Field label="Account and action">{(p) => (
          <Select {...p} value={choice} onChange={(e) => setChoice(e.target.value)}>
            {types.map((t) => <option key={t.connectionId + t.type} value={`${t.connectionId}|${t.type}`}>{t.providerName} · {t.connectionName} — {t.label}</option>)}
          </Select>
        )}</Field>
        <Field label={target?.kind === "deal" || type?.includes("deal") ? "Deal" : "Campaign"}>{(p) => (
          targets.isLoading ? <div className="flex h-10 items-center"><Spinner label="Reading from the account" /></div>
            : targets.error ? <p className="text-sm text-danger">{errorMessage(targets.error)}</p>
            : <Select {...p} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">— Choose —</option>
                {targets.data?.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.summary}{t.assetName ? ` (${t.assetName})` : ""}</option>)}
              </Select>
        )}</Field>
        {target?.fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.help}>{(p) => f.kind === "select" ? (
            <Select {...p} value={params[f.key] ?? ""} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}><option value="">— Choose —</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
          ) : (
            <Input {...p} type="number" min={1} step="0.01" value={params[f.key] ?? ""} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })} placeholder={String(target.state.dailyBudget ?? "")} />
          )}</Field>
        ))}
      </div>
    </Dialog>
  );
}
