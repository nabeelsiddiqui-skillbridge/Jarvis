import { NavLink } from "react-router";
import { cn } from "@/lib/cn";
import type { Business } from "@bca/shared";
import { useMe } from "@/lib/session";
import { Logo } from "@/components/brand/Logo";
import { BusinessSwitcher } from "./BusinessSwitcher";
import { adminNav, businessNav, workspaceNav } from "./nav";

const linkCls = ({ isActive }: { isActive: boolean }) =>
  cn(
    "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
    isActive ? "bg-accent/10 text-fg shadow-[inset_2px_0_0_var(--color-accent)]" : "text-muted hover:bg-white/[0.04] hover:text-fg",
  );

export function Sidebar({ workspaceId, business, onNavigate }: { workspaceId: string; business: Business | null; onNavigate?: () => void }) {
  const me = useMe();
  const bizBase = business ? `/app/b/${business.id}` : null;
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-4">
      <Logo to="/app" className="px-2" />
      <BusinessSwitcher workspaceId={workspaceId} active={business} />

      <div>
        <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">Business</p>
        {bizBase ? (
          <ul className="space-y-0.5">
            {businessNav.map((n) => (
              <li key={n.label}>
                <NavLink to={n.to ? `${bizBase}/${n.to}` : bizBase} end={"end" in n} className={linkCls} onClick={onNavigate}>
                  <n.icon className="size-[18px] shrink-0 opacity-80 group-[.active]:text-accent" /> {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 text-xs text-subtle">Select or create a business to see its pages.</p>
        )}
      </div>

      <div>
        <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">Workspace</p>
        <ul className="space-y-0.5">
          {workspaceNav.map((n) => (
            <li key={n.label}>
              <NavLink to={`/app/w/${workspaceId}/${n.to}`} className={linkCls} onClick={onNavigate}>
                <n.icon className="size-[18px] shrink-0 opacity-80" /> {n.label}
              </NavLink>
            </li>
          ))}
          {me.data?.user.isPlatformAdmin && (
            <li>
              <NavLink to={`/app/w/${workspaceId}/${adminNav.to}`} className={linkCls} onClick={onNavigate}>
                <adminNav.icon className="size-[18px] shrink-0 text-violet" /> {adminNav.label}
              </NavLink>
            </li>
          )}
        </ul>
      </div>
    </nav>
  );
}
