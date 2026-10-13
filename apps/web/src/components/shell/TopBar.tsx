import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, LogOut, Menu, PanelRightClose, PanelRightOpen, UserRound } from "lucide-react";
import { INDUSTRIES, ROLE_LABELS, type Business } from "@bca/shared";
import { post } from "@/lib/api";
import { useMe } from "@/lib/session";
import { Badge, DemoBadge } from "@/components/ui/Badge";
import { BusinessAvatar, UserAvatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";

export function TopBar({ business, title, workspaceId, onMenu, assistantOpen, onToggleAssistant }: {
  business: Business | null;
  title?: string;
  workspaceId: string;
  onMenu: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
}) {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const signOut = async () => {
    await post("/auth/logout").catch(() => undefined);
    qc.clear();
    nav("/login", { replace: true });
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-bg/80 px-3 backdrop-blur-xl sm:px-5">
      <IconButton label="Open navigation" className="lg:hidden" onClick={onMenu}>
        <Menu className="size-5" />
      </IconButton>

      {business ? (
        <div className="flex min-w-0 flex-1 items-center gap-3" aria-live="polite">
          <BusinessAvatar name={business.name} logoUrl={business.logoUrl} size={36} className="hidden sm:grid" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-display text-[17px] font-semibold" title="Active business">{business.name}</span>
              {business.isDemo && <DemoBadge />}
            </div>
            <div className="hidden truncate text-xs text-muted sm:block">
              {INDUSTRIES.find((i) => i.id === business.industry)?.label ?? business.industry} · {business.timezone.replace(/_/g, " ")} · {business.currency}
            </div>
          </div>
          <Badge tone="violet" className="ml-1 hidden md:inline-flex">{ROLE_LABELS[business.role]}</Badge>
        </div>
      ) : (
        <div className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold">{title}</div>
      )}

      <div className="flex items-center gap-1">
        {business && (
          <IconButton label={assistantOpen ? "Hide assistant" : "Show assistant"} onClick={onToggleAssistant} className="hidden xl:inline-grid">
            {assistantOpen ? <PanelRightClose className="size-5" /> : <PanelRightOpen className="size-5" />}
          </IconButton>
        )}
        {business && (
          <Link to={`/app/b/${business.id}/assistant`} aria-label="Open assistant" className="inline-grid size-10 place-items-center rounded-lg text-accent hover:bg-white/5 xl:hidden">
            <Bot className="size-5" />
          </Link>
        )}
        <div className="relative">
          <button ref={menuRef} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-white/5">
            <UserAvatar name={me.data?.user.name ?? "?"} size={30} />
            <span className="sr-only">Account menu</span>
          </button>
          <Popover open={menu} onClose={() => setMenu(false)} anchor={menuRef} align="end" className="w-60 p-1.5">
            <div role="menu" aria-label="Account">
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium">{me.data?.user.name}</p>
                <p className="truncate text-xs text-muted">{me.data?.user.email}</p>
              </div>
              <div className="my-1 h-px bg-line" />
              <Link role="menuitem" to={`/app/w/${workspaceId}/account`} onClick={() => setMenu(false)} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-white/5">
                <UserRound className="size-4" /> Account settings
              </Link>
              <button role="menuitem" onClick={signOut} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-white/5">
                <LogOut className="size-4" /> Sign out
              </button>
            </div>
          </Popover>
        </div>
      </div>
    </header>
  );
}
