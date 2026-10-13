import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canWorkspace } from "@bca/shared";
import { del, patch, errorMessage } from "@/lib/api";
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
            <Field label="Data retention" hint="Imported source records, conversations and job history older than this are deleted automatically. Aggregated metrics and audit logs are kept.">
              {(p) => (
                <Select {...p} disabled={!owner} value={retention} onChange={(e) => setRetention(e.target.value)}>
                  {[90, 180, 365, 730, 1095, 1825].map((d) => <option key={d} value={d}>{d >= 365 ? `${d / 365} year${d > 365 ? "s" : ""}` : `${d} days`}</option>)}
                </Select>
              )}
            </Field>
            {owner && <div className="flex justify-end"><Button type="submit" variant="primary" loading={busy}>Save</Button></div>}
          </form>
        </Card>
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
