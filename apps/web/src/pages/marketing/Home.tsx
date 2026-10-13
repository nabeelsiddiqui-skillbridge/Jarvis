import { ArrowRight, BarChart3, Bot, Building2, ShieldCheck } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";

export function Home() {
  return (
    <main>
      <section className="relative overflow-hidden">
        <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_50%_0%,#000,transparent_70%)]" />
        <div className="relative mx-auto max-w-4xl px-5 pb-20 pt-24 text-center sm:pt-32">
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">AI business command center</p>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.08] sm:text-6xl">
            Run every business from <span className="text-gradient">one command center</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-muted sm:text-lg">
            Connect your store, analytics, ads and CRM. Ask questions by voice or text, get answers that cite their sources, and build live dashboards in seconds — for one business or a whole client portfolio.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/signup" variant="primary" size="lg">Start free <ArrowRight className="size-4" /></ButtonLink>
            <ButtonLink to="/login" variant="outline" size="lg">Sign in</ButtonLink>
          </div>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-5 px-5 pb-24 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { icon: Building2, title: "Multi-business", body: "Separate businesses with their own connections, dashboards and permissions. Built for owners, teams and agencies." },
          { icon: BarChart3, title: "Live dashboards", body: "Drag, resize and edit widgets backed by validated metric definitions — never invented numbers." },
          { icon: Bot, title: "Voice & text assistant", body: "Answers include the source accounts, date range, definitions, freshness and limitations." },
          { icon: ShieldCheck, title: "Secure by design", body: "Encrypted tokens, row-level security, audited approvals for every external action." },
        ].map((f) => (
          <div key={f.title} className="panel p-6">
            <f.icon className="size-6 text-accent" />
            <h3 className="mt-4 font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm text-muted">{f.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
