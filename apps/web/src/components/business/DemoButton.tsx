import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { post, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

/** Creates a separate, clearly labelled demo business with seeded sample data. */
export function DemoButton({ workspaceId, label = "Explore a demo business", variant = "secondary" }: { workspaceId: string; label?: string; variant?: "secondary" | "ghost" | "outline" }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button variant={variant} loading={busy} icon={<FlaskConical className="size-4" />} onClick={async () => {
      setBusy(true);
      try {
        const r = await post<{ id: string }>(`/workspaces/${workspaceId}/demo-business`, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
        await qc.invalidateQueries();
        toast("Demo business created — it's labelled and kept separate from your real data.", "info");
        nav(`/app/b/${r.id}`);
      } catch (e) {
        toast(errorMessage(e), "error");
      } finally {
        setBusy(false);
      }
    }}>{label}</Button>
  );
}
