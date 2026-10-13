import { NavLink } from "react-router";
import { Bot, Gauge, LayoutDashboard, Menu } from "lucide-react";
import type { Business } from "@bca/shared";
import { cn } from "@/lib/cn";

const cls = ({ isActive }: { isActive: boolean }) =>
  cn("flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium", isActive ? "text-accent" : "text-muted");

/** Bottom tab bar on phones: the three most-used destinations + the full menu. */
export function MobileTabBar({ business, workspaceId, onMore }: { business: Business | null; workspaceId: string; onMore: () => void }) {
  const base = business ? `/app/b/${business.id}` : `/app/w/${workspaceId}/businesses`;
  return (
    <nav aria-label="Quick navigation" className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      <NavLink to={base} end className={cls}><Gauge className="size-5" />Command</NavLink>
      <NavLink to={business ? `${base}/assistant` : base} className={cls}><Bot className="size-5" />Assistant</NavLink>
      <NavLink to={business ? `${base}/dashboards` : base} className={cls}><LayoutDashboard className="size-5" />Dashboards</NavLink>
      <button onClick={onMore} className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted"><Menu className="size-5" />More</button>
    </nav>
  );
}
