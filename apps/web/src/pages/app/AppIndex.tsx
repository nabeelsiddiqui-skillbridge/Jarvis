import { Navigate } from "react-router";
import { useMe } from "@/lib/session";
import { useBusinesses } from "@/lib/business";
import { PageLoader } from "@/components/ui/Spinner";

/** Sends the user to the right place: onboarding, their most recent business, or the workspace. */
export function AppIndex() {
  const me = useMe();
  const ws = me.data?.workspaces.find((w) => w.id === me.data?.preferences.lastWorkspaceId) ?? me.data?.workspaces[0];
  const businesses = useBusinesses(ws?.id);
  if (!me.data) return <PageLoader />;
  if (!ws) return <Navigate to="/app/onboarding" replace />;
  if (businesses.isPending) return <PageLoader />;
  const list = businesses.data ?? [];
  const recent = me.data.preferences.recentBusinessIds.find((id) => list.some((b) => b.id === id));
  const target = recent ?? list.find((b) => !b.isDemo)?.id ?? list[0]?.id;
  if (target) return <Navigate to={`/app/b/${target}`} replace />;
  if (ws.role === "owner") return <Navigate to="/app/onboarding" replace />;
  return <Navigate to={`/app/w/${ws.id}/businesses`} replace />;
}
