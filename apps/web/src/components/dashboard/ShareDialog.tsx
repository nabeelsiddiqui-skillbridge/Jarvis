import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can, ROLE_LABELS } from "@bca/shared";
import { get, put, errorMessage } from "@/lib/api";
import { keys } from "@/lib/business";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { UserAvatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";

interface Sharing { visibility: "business" | "private"; shares: { userId: string; name: string; email: string; canEdit: boolean }[] }
interface AccessRow { userId: string; name: string; email: string; role: string | null }

/** Share only with people who already have access to the business; edit rights only for analysts and up. */
export function ShareDialog({ open, onClose, businessId, dashboardId, meId }: { open: boolean; onClose: () => void; businessId: string; dashboardId: string; meId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const sharing = useQuery({ queryKey: ["b", businessId, "dashboard", dashboardId, "sharing"], queryFn: ({ signal }) => get<Sharing>(`/businesses/${businessId}/dashboards/${dashboardId}/sharing`, signal), enabled: open });
  const people = useQuery({ queryKey: keys.access(businessId), queryFn: ({ signal }) => get<AccessRow[]>(`/businesses/${businessId}/access`, signal), enabled: open });
  const [visibility, setVisibility] = useState<"business" | "private">("business");
  const [shares, setShares] = useState<Record<string, "none" | "view" | "edit">>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!sharing.data) return;
    setVisibility(sharing.data.visibility);
    setShares(Object.fromEntries(sharing.data.shares.map((s) => [s.userId, s.canEdit ? "edit" : "view"])));
  }, [sharing.data]);

  const save = async () => {
    setBusy(true);
    try {
      await put(`/businesses/${businessId}/dashboards/${dashboardId}/sharing`, {
        visibility,
        shares: Object.entries(shares).filter(([, v]) => v !== "none").map(([userId, v]) => ({ userId, canEdit: v === "edit" })),
      });
      await qc.invalidateQueries({ queryKey: ["b", businessId] });
      toast("Sharing updated");
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const others = (people.data ?? []).filter((p) => p.userId !== meId && p.role);
  return (
    <Dialog open={open} onClose={onClose} title="Share dashboard" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-5">
        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 text-[13px] font-medium">General access</legend>
          <label className="flex items-start gap-2"><input type="radio" name="v" className="mt-1 accent-[#22d3ee]" checked={visibility === "business"} onChange={() => setVisibility("business")} /><span>Everyone with access to this business <span className="block text-xs text-muted">Analysts and administrators can edit; viewers can view.</span></span></label>
          <label className="flex items-start gap-2"><input type="radio" name="v" className="mt-1 accent-[#22d3ee]" checked={visibility === "private"} onChange={() => setVisibility("private")} /><span>Restricted <span className="block text-xs text-muted">Only you, business administrators and the people below.</span></span></label>
        </fieldset>
        {visibility === "private" && (
          <div>
            <p className="mb-2 text-[13px] font-medium">People</p>
            {!others.length && <p className="text-sm text-muted">Nobody else has access to this business yet.</p>}
            <ul className="divide-y divide-line">
              {others.map((p) => (
                <li key={p.userId} className="flex items-center gap-3 py-2">
                  <UserAvatar name={p.name} />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm">{p.name}</p><p className="truncate text-xs text-muted">{p.email} · {ROLE_LABELS[p.role as keyof typeof ROLE_LABELS]}</p></div>
                  {p.role === "owner" || p.role === "admin" ? <span className="text-xs text-subtle">Always has access</span> : (
                    <select aria-label={`Access for ${p.name}`} value={shares[p.userId] ?? "none"} onChange={(e) => setShares({ ...shares, [p.userId]: e.target.value as "none" | "view" | "edit" })} className="h-8 rounded-md border border-line bg-panel-2 px-2 text-sm">
                      <option value="none">No access</option>
                      <option value="view">Can view</option>
                      <option value="edit" disabled={!can(p.role as "viewer", "dashboard.write")}>Can edit</option>
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
