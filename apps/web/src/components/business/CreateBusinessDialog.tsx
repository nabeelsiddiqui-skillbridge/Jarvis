import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { keys, rememberBusiness } from "@/lib/business";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { BusinessForm } from "./BusinessForm";

export function CreateBusinessDialog({ open, onClose, workspaceId }: { open: boolean; onClose: () => void; workspaceId: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <Dialog open={open} onClose={onClose} title="New business" description="Each business has its own connections, dashboards, conversations and permissions." size="lg">
      <BusinessForm
        submitLabel="Create business"
        onCancel={onClose}
        onSubmit={async (v) => {
          const { id } = await post<{ id: string }>(`/workspaces/${workspaceId}/businesses`, v);
          await qc.invalidateQueries({ queryKey: keys.businesses(workspaceId) });
          await qc.invalidateQueries({ queryKey: ["me"] });
          rememberBusiness(id, workspaceId);
          toast(`${v.name} created`);
          onClose();
          nav(`/app/b/${id}`);
        }}
      />
    </Dialog>
  );
}
