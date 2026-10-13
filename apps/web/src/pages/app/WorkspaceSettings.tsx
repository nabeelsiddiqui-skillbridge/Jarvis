import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { canWorkspace } from "@bca/shared";
import { del, get, patch, post, errorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { relativeTime } from "@/components/widgets/WidgetFrame";
import { useMe } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Prerequisite } from "@/components/ui/EmptyState";
import { Field, Input, Select } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

export function WorkspaceSettings() {
  const { workspaceId = "" } = useParams();
  const me = useMe();
  const ws = me.data?.workspaces.find((w) => w.id === workspaceId);
  const owner = canWorkspace(ws?.role, "workspace.manage");
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [name, setName] = useState(ws?.name ?? "");
  const [retention, setRetention] = useState(String(ws?.retentionDays ?? 730));
  const [busy, setBusy] = useState(false);
  const [del0, setDel] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!ws) return null;

  const save = async () => {
    setBusy(true);
    try {
      await patch(`/workspaces/${workspaceId}`, { name, retentionDays: Number(retention) });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast("Workspace saved");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Workspace settings" description={ws.name} />
      {!owner && <div className="mb-5"><Prerequisite title="Read-only">Only workspace owners can change these settings.</Prerequisite></div>}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="General">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Field label="Workspace name">{(p) => <Input {...p} disabled={!owner} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Data retention" hint="Imported source records, conversations, job history and read notifications older than this are deleted daily. Aggregated metrics for those days, dashboards, reports and audit logs are kept; open CRM deals are kept while they're open.">
              {(p) => (
                <Select {...p} disabled={!owner} value={retention} onChange={(e) => setRetention(e.target.value)}>
                  {[90, 180, 365, 730, 1095, 1825].map((d) => <option key={d} value={d}>{d >= 365 ? `${d / 365} year${d > 365 ? "s" : ""}` : `${d} days`}</option>)}
                </Select>
              )}
            </Field>
            {owner && <div className="flex justify-end"><Button type="submit" variant="primary" loading={busy}>Save</Button></div>}
          </form>
        </Card>
        {owner && <SupportAccessCard workspaceId={workspaceId} />}
        {owner && (
          <Card title="Delete workspace" className="border-danger/25">
            <Prerequisite tone="warning" title="Permanent">Deletes every business, connection, imported record, dashboard, conversation and automation in this workspace.</Prerequisite>
            <Button variant="danger" className="mt-4" onClick={() => setDel(true)}>Delete workspace…</Button>
          </Card>
        )}
      </div>
      <Dialog open={del0} onClose={() => setDel(false)} title="Delete workspace?" size="sm"
        footer={<><Button variant="ghost" onClick={() => setDel(false)}>Cancel</Button><Button variant="danger" disabled={confirm !== ws.name} onClick={async () => {
          try {
            await del(`/workspaces/${workspaceId}`, { confirmName: confirm });
            qc.clear();
            nav("/app", { replace: true });
          } catch (e) {
            setErr(errorMessage(e));
          }
        }}>Delete permanently</Button></>}>
        <Field label={`Type “${ws.name}” to confirm`} error={err}>{(p) => <Input {...p} data-autofocus value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}

interface SupportGrant { id: string; reason: string; adminEmail: string; createdAt: string; expiresAt: string; revokedAt: string | null; views: number; active: boolean }

/** Platform support access to this workspace: who, why, until when, how many views — and a way to end it. */
function SupportAccessCard({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["support-access", workspaceId], queryFn: ({ signal }) => get<SupportGrant[]>(`/workspaces/${workspaceId}/support-access`, signal) });
  const revoke = useMutation({
    mutationFn: (id: string) => post(`/workspaces/${workspaceId}/support-access/${id}/revoke`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["support-access", workspaceId] }); toast("Support access ended"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <Card title="Support access" description="Platform staff can only see this workspace's data with a time-limited, read-only grant. You're notified, and every page they open is recorded in your audit log.">
      {q.isLoading ? <p className="text-sm text-muted">Loading…</p> : !q.data?.length ? (
        <p className="flex items-center gap-2 text-sm text-muted"><ShieldCheck className="size-4 text-success" aria-hidden /> Platform staff have never accessed this workspace.</p>
      ) : (
        <ul className="divide-y divide-line/70 text-sm">
          {q.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-start gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="break-words">{g.reason}</p>
                <p className="text-xs text-muted">{g.adminEmail} · {relativeTime(g.createdAt)} · {g.views} page view{g.views === 1 ? "" : "s"}</p>
              </div>
              {g.active ? <><Badge tone="warning">Active until {new Date(g.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Badge><Button size="sm" variant="danger" loading={revoke.isPending && revoke.variables === g.id} onClick={() => revoke.mutate(g.id)}>End access</Button></> : <Badge>{g.revokedAt ? "Ended" : "Expired"}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
