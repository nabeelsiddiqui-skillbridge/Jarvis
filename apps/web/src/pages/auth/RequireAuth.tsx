import { useEffect } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { unauthorizedEvents } from "@/lib/api";
import { useMe } from "@/lib/session";
import { ErrorState } from "@/components/ui/EmptyState";
import { PageLoader } from "@/components/ui/Spinner";

export function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();

  // Any 401 (session expired / signed out elsewhere) sends the user to sign in.
  useEffect(() => {
    const onUnauth = () => {
      qc.clear();
      nav(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
    };
    unauthorizedEvents.addEventListener("unauthorized", onUnauth);
    return () => unauthorizedEvents.removeEventListener("unauthorized", onUnauth);
  }, [nav, qc]);

  if (me.isPending) return <PageLoader label="Loading your workspace…" />;
  if (me.error) {
    if ((me.error as any).status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return <div className="p-8"><ErrorState error={me.error} onRetry={() => me.refetch()} /></div>;
  }
  return <Outlet />;
}
