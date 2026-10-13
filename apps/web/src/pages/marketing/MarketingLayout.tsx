import { Link, Outlet } from "react-router";
import { Logo } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { useMe } from "@/lib/session";

export function MarketingLayout() {
  const me = useMe();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
          <Logo />
          <nav aria-label="Site" className="flex items-center gap-2">
            {me.data ? (
              <ButtonLink to="/app" variant="primary" size="sm">Open app</ButtonLink>
            ) : (
              <>
                <Link to="/login" className="px-3 text-sm text-muted hover:text-fg">Sign in</Link>
                <ButtonLink to="/signup" variant="primary" size="sm">Get started</ButtonLink>
              </>
            )}
          </nav>
        </div>
      </header>
      <Outlet />
      <footer className="border-t border-line py-10 text-center text-xs text-subtle">© {new Date().getFullYear()} Business Command AI</footer>
    </div>
  );
}
