import { useQuery } from "@tanstack/react-query";
import { History, RotateCcw } from "lucide-react";
import { get } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Spinner";

interface Version { version: number; note: string | null; createdAt: string; createdByName: string | null; widgets: number }

export function VersionsDialog({ open, onClose, businessId, dashboardId, current, canRestore, onRestore }: {
  open: boolean;
  onClose: () => void;
  businessId: string;
  dashboardId: string;
  current: number;
  canRestore: boolean;
  onRestore: (v: number) => void;
}) {
  const versions = useQuery({
    queryKey: ["b", businessId, "dashboard", dashboardId, "versions", current],
    queryFn: ({ signal }) => get<Version[]>(`/businesses/${businessId}/dashboards/${dashboardId}/versions`, signal),
    enabled: open,
  });
  return (
    <Dialog open={open} onClose={onClose} title="Version history" description="Every save is kept. Restoring creates a new version, so nothing is lost.">
      {versions.isPending ? <Skeleton className="h-40" /> : (
        <ol className="space-y-1">
          {versions.data?.map((v) => (
            <li key={v.version} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.03]">
              <History className="size-4 shrink-0 text-subtle" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">Version {v.version}{v.version === current && <span className="ml-2 text-xs text-accent">current</span>}</p>
                <p className="truncate text-xs text-muted">{v.note ?? "Edited"} · {v.widgets} widgets · {v.createdByName ?? "Unknown"} · {new Date(v.createdAt).toLocaleString()}</p>
              </div>
              {canRestore && v.version !== current && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => onRestore(v.version)}>Restore</Button>}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
