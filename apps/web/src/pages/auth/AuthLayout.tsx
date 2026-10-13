import type { ReactNode } from "react";
import { BarChart3, Mic, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand/Logo";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden border-r border-line bg-panel-2 p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="grid-bg absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_30%_20%,#000,transparent_70%)]" />
        <Logo className="relative" />
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight">
            Every business account. <span className="text-gradient">One command center.</span>
          </h2>
          <ul className="mt-8 space-y-5 text-sm text-muted">
            <li className="flex gap-3"><BarChart3 className="size-5 shrink-0 text-accent" /> Live dashboards built from your real store, analytics, ads and CRM data — with sources and freshness on every number.</li>
            <li className="flex gap-3"><Mic className="size-5 shrink-0 text-accent" /> Ask by voice or text. Answers cite the accounts, date ranges and definitions they used.</li>
            <li className="flex gap-3"><ShieldCheck className="size-5 shrink-0 text-accent" /> Business-level permissions, encrypted credentials and approval-gated actions.</li>
          </ul>
        </div>
        <p className="relative text-xs text-subtle">© {new Date().getFullYear()} Business Command AI</p>
      </aside>
      <main className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm animate-rise">
          <Logo className="mb-10 lg:hidden" />
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
