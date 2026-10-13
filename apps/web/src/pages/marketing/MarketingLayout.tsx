import { Link, NavLink, Outlet, ScrollRestoration } from "react-router";
import { Logo } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { useMe } from "@/lib/session";

export function MarketingLayout() {
  const me = useMe();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
          <div className="flex items-center gap-6">
            <Logo />
            <nav aria-label="Product" className="hidden items-center gap-5 text-sm sm:flex">
              {[["/pricing", "Pricing"], ["/security", "Security"]].map(([to, label]) => <NavLink key={to} to={to!} className={({ isActive }) => (isActive ? "text-fg" : "text-muted hover:text-fg")}>{label}</NavLink>)}
            </nav>
          </div>
          <nav aria-label="Account" className="flex items-center gap-2">
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
      <ScrollRestoration />
      <footer className="border-t border-line py-10 text-xs text-subtle">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5">
          <span>© {new Date().getFullYear()} Business Command AI</span>
          <nav aria-label="Footer" className="flex gap-5"><Link to="/" className="hover:text-fg">Product</Link><Link to="/pricing" className="hover:text-fg">Pricing</Link><Link to="/security" className="hover:text-fg">Security</Link><Link to="/login" className="hover:text-fg">Sign in</Link></nav>
        </div>
      </footer>
    </div>
  );
}
