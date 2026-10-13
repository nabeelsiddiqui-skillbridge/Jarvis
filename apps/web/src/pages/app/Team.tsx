import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Mail, UserPlus, X } from "lucide-react";
import { BUSINESS_ROLES, ROLE_LABELS, canWorkspace, type BusinessRole } from "@bca/shared";
import { del, get, patch, post, errorMessage } from "@/lib/api";
import { keys, useBusinesses } from "@/lib/business";
import { useMe } from "@/lib/session";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { UserAvatar } from "@/components/ui/Avatar";

interface Members {
  members: { id: string; name: string; email: string; role: "owner" | "member"; businesses: { businessId: string; role: BusinessRole }[] }[];
  invitations: { id: string; email: string; role: string; businessGrants: { businessId: string; role: string }[]; expiresAt: string }[];
}

export function Team() {
  const { workspaceId = "" } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const isOwner = canWorkspace(me.data?.workspaces.find((w) => w.id === workspaceId)?.role, "workspace.members.manage");
  const data = useQuery({ queryKey: keys.members(workspaceId), queryFn: ({ signal }) => get<Members>(`/workspaces/${workspaceId}/members`, signal) });
  const businesses = useBusinesses(workspaceId);
  const [inviting, setInviting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.members(workspaceId) });

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) => patch(`/workspaces/${workspaceId}/members/${userId}`, { role }),
    onSuccess: () => { refresh(); toast("Role updated"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => del(`/workspaces/${workspaceId}/members/${userId}`),
    onSuccess: () => { refresh(); toast("Member removed"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/workspaces/${workspaceId}/invitations/${id}`),
    onSuccess: () => { refresh(); toast("Invitation revoked"); },
  });
  const bizName = (id: string) => businesses.data?.find((b) => b.id === id)?.name ?? "Business";

  return (
    <>
      <PageHeader title="Team" description="Workspace owners see every business. Members only see the businesses they're granted."
        actions={isOwner ? <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>Invite</Button> : <span className="text-xs text-subtle">Only owners can invite people.</span>} />
      <Card title="Members">
        {data.isPending ? <Skeleton className="h-32" /> : (
          <ul className="divide-y divide-line">
            {data.data?.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                <UserAvatar name={m.name} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name} {m.id === me.data?.user.id && <span className="text-xs text-subtle">(you)</span>}</p>
                  <p className="truncate text-xs text-muted">{m.email}</p>
                  {m.role === "member" && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {m.businesses.length ? m.businesses.map((g) => <Badge key={g.businessId}>{bizName(g.businessId)} · {ROLE_LABELS[g.role]}</Badge>) : <span className="text-xs text-warning">No business access yet</span>}
                    </div>
                  )}
                </div>
                {isOwner ? (
                  <div className="flex items-center gap-2">
                    <select aria-label={`Workspace role for ${m.name}`} value={m.role} onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value })} className="h-8 rounded-md border border-line bg-panel-2 px-2 text-sm">
                      <option value="owner">Owner</option>
                      <option value="member">Member</option>
                    </select>
                    {m.id !== me.data?.user.id && (
                      <Button size="sm" variant="ghost" aria-label={`Remove ${m.name}`} onClick={() => confirm(`Remove ${m.name} from the workspace?`) && remove.mutate(m.id)}><X className="size-4" /></Button>
                    )}
                  </div>
                ) : <Badge tone={m.role === "owner" ? "violet" : "neutral"}>{m.role === "owner" ? "Owner" : "Member"}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {isOwner && !!data.data?.invitations.length && (
        <Card title="Pending invitations" className="mt-5">
          <ul className="divide-y divide-line">
            {data.data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
                <Mail className="size-4 text-subtle" />
                <span className="flex-1 truncate">{i.email}</span>
                <span className="text-xs text-muted">expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} workspaceId={workspaceId} businesses={businesses.data ?? []} onDone={refresh} />
    </>
  );
}

function InviteDialog({ open, onClose, workspaceId, businesses, onDone }: { open: boolean; onClose: () => void; workspaceId: string; businesses: { id: string; name: string }[]; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "owner">("member");
  const [grants, setGrants] = useState<Record<string, BusinessRole | "">>({});
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const close = () => { setEmail(""); setGrants({}); setLink(null); setError(null); onClose(); };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const businessGrants = Object.entries(grants).filter(([, r]) => r).map(([businessId, r]) => ({ businessId, role: r }));
      const res = await post<{ inviteUrl: string }>(`/workspaces/${workspaceId}/invitations`, { email, role, businessGrants });
      setLink(res.inviteUrl);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} title="Invite to workspace" size="lg"
      footer={link ? <Button variant="primary" onClick={close}>Done</Button> : <><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!email} onClick={submit}>Create invitation</Button></>}>
      {link ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Share this one-time link with <b className="text-fg">{email}</b>. It expires in 7 days and only works for that email address. (Invitations are emailed automatically once an email provider is configured.)</p>
          <div className="flex gap-2">
            <Input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
            <Button icon={<Copy className="size-4" />} onClick={() => { navigator.clipboard?.writeText(link); toast("Link copied"); }}>Copy</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Email">{(p) => <Input {...p} data-autofocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Workspace role">{(p) => (
            <Select {...p} value={role} onChange={(e) => setRole(e.target.value as "member" | "owner")}>
              <option value="member">Member — only the businesses granted below</option>
              <option value="owner">Owner — every business, billing and team</option>
            </Select>
          )}</Field>
          {role === "member" && (
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">Business access</legend>
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {businesses.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                    <span className="truncate text-sm">{b.name}</span>
                    <select aria-label={`Access to ${b.name}`} value={grants[b.id] ?? ""} onChange={(e) => setGrants({ ...grants, [b.id]: e.target.value as BusinessRole })} className="h-8 rounded-md border border-line bg-panel-2 px-2 text-sm">
                      <option value="">No access</option>
                      {BUSINESS_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
