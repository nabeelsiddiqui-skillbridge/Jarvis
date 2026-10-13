import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useMatch, useParams } from "react-router";
import { ShieldAlert } from "lucide-react";
import type { Business } from "@bca/shared";
import { cn } from "@/lib/cn";
import { patch } from "@/lib/api";
import { BusinessContext, rememberBusiness, useBusinessQuery, useBusinesses } from "@/lib/business";
import { useMe } from "@/lib/session";
import { useBusinessEvents } from "@/lib/metrics";
import { ErrorState } from "@/components/ui/EmptyState";
import { PageLoader } from "@/components/ui/Spinner";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { AssistantPanel } from "./AssistantPanel";
import { MobileTabBar } from "./MobileTabBar";

function AppShell({ workspaceId, business, navBusiness = business, title, children }: { workspaceId: string; business: Business | null; navBusiness?: Business | null; title?: string; children: ReactNode }) {
  const support = Boolean(business?.support);
  const me = useMe();
  const [drawer, setDrawer] = useState(false);
  // The Assistant page is a full-height chat: no page padding, and no duplicate side panel.
  const fullBleed = Boolean(useMatch("/app/b/:businessId/assistant"));
  // The command deck already puts JARVIS in the middle of the page.
  const onDeck = Boolean(useMatch("/app/b/:businessId"));
  const [assistantOpen, setAssistantOpen] = useState(me.data?.preferences.assistantPanelOpen ?? true);
  const toggleAssistant = () => {
    const next = !assistantOpen;
    setAssistantOpen(next);
    patch("/auth/me/preferences", { assistantPanelOpen: next }).catch(() => undefined);
  };

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="sr-only z-[70] rounded-md bg-accent px-3 py-2 text-[#04121a] focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>

      <aside className="no-print hidden w-[272px] shrink-0 border-r border-line bg-panel-2/70 lg:block">
        <Sidebar workspaceId={workspaceId} business={navBusiness} />
      </aside>

      {/* Mobile navigation drawer */}
      <div className={cn("fixed inset-0 z-40 lg:hidden", drawer ? "" : "pointer-events-none")} aria-hidden={!drawer}>
        <div className={cn("absolute inset-0 bg-black/60 transition-opacity", drawer ? "opacity-100" : "opacity-0")} onClick={() => setDrawer(false)} />
        <aside className={cn("absolute inset-y-0 left-0 w-[86%] max-w-[300px] border-r border-line bg-panel transition-transform", drawer ? "translate-x-0" : "-translate-x-full")}>
          {drawer && <Sidebar workspaceId={workspaceId} business={navBusiness} onNavigate={() => setDrawer(false)} />}
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar business={business} title={title} workspaceId={workspaceId} onMenu={() => setDrawer(true)} assistantOpen={assistantOpen} onToggleAssistant={toggleAssistant} showAssistantToggle={!fullBleed && !onDeck} />
        <div className="flex min-h-0 flex-1">
          {fullBleed ? (
            <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col overflow-hidden pb-[calc(3rem+env(safe-area-inset-bottom))] focus:outline-none lg:pb-0">{children}</main>
          ) : (
            <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto px-4 pb-24 pt-6 focus:outline-none sm:px-6 lg:px-8 lg:pb-10">
              <div className="mx-auto max-w-[1400px]">{support && <SupportBanner business={business!} workspaceId={workspaceId} />}{children}</div>
            </main>
          )}
          {business && assistantOpen && !fullBleed && !onDeck && !support && <AssistantPanel business={business} onClose={toggleAssistant} />}
        </div>
      </div>
      <MobileTabBar business={navBusiness} workspaceId={workspaceId} onMore={() => setDrawer(true)} />
    </div>
  );
}

/** Resolves the active business from the URL. Data is (re)loaded per business id; the outlet is keyed so no state leaks across a switch. */
export function BusinessLayout() {
  const { businessId } = useParams();
  const business = useBusinessQuery(businessId);
  const me = useMe();

  useEffect(() => {
    // Support views of a customer's business never enter the administrator's own recents.
    if (business.data && !business.data.support) rememberBusiness(business.data.id, business.data.workspaceId);
  }, [business.data?.id]);

  if (business.isPending) return <PageLoader />;
  if (business.error) {
    const ws = me.data?.preferences.lastWorkspaceId ?? me.data?.workspaces[0]?.id;
    if ((business.error as any).status === 404 && ws) {
      return (
        <AppShell workspaceId={ws} business={null} title="Business not found">
          <ErrorState error={new Error("This business doesn't exist or you don't have access to it.")} />
        </AppShell>
      );
    }
    return <div className="p-8"><ErrorState error={business.error} onRetry={() => business.refetch()} /></div>;
  }
  const b = business.data;
  if (!b) return <PageLoader />;
  return (
    <BusinessContext.Provider value={b}>
      <BusinessEvents businessId={b.id} />
      <AppShell workspaceId={b.support ? (me.data?.preferences.lastWorkspaceId ?? me.data?.workspaces[0]?.id ?? b.workspaceId) : b.workspaceId} business={b}>
        <Outlet key={b.id} />
      </AppShell>
    </BusinessContext.Provider>
  );
}

export function WorkspaceLayout() {
  const { workspaceId } = useParams();
  const me = useMe();
  const businesses = useBusinesses(workspaceId);
  const ws = me.data?.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return <Navigate to="/app" replace />;
  // Keep the last-used business of this workspace in the switcher for context.
  const recent = me.data?.preferences.recentBusinessIds.map((id) => businesses.data?.find((b) => b.id === id)).find(Boolean) ?? null;
  return (
    <AppShell workspaceId={ws.id} business={null} navBusiness={recent} title={ws.name}>
      <Outlet key={ws.id} />
    </AppShell>
  );
}

/** Live updates for the active business (re-subscribes on switch). */
function BusinessEvents({ businessId }: { businessId: string }) {
  useBusinessEvents(businessId);
  return null;
}

function SupportBanner({ business, workspaceId }: { business: Business; workspaceId: string }) {
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      <ShieldAlert className="size-5 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1"><span className="font-semibold text-warning">Support access · read-only.</span> You're viewing {business.name} as platform staff. Every page you open is recorded in the customer's audit log; changes, exports and the assistant are blocked.</p>
      <Link to={`/app/w/${workspaceId}/admin?tab=support`} className="font-medium text-accent hover:underline">Back to admin</Link>
    </div>
  );
}
