import { ArrowRight, Check } from "lucide-react";
import { PAID_PLANS, PLANS, type PlanId } from "@bca/shared";
import { cn } from "@/lib/cn";
import { ButtonLink } from "@/components/ui/Button";

const EVERY_PLAN = [
  "Live editable dashboards and AI dashboard generation",
  "Evidence-backed assistant (text, and voice where supported)",
  "Daily briefings, weekly reports, insights and automations",
  "Approved external actions with full audit history",
  "Roles per business: owner, administrator, analyst, viewer",
  "Labelled demo business to explore safely",
];

const FAQ = [
  { q: "What happens when the trial ends?", a: "New workspaces get 14 days of Growth. Afterwards the Free plan's limits apply unless you choose a plan. Nothing is deleted — you just can't add beyond the limits." },
  { q: "What counts as an assistant question?", a: "Each message you send to the assistant that it answers, by text or voice. Usage resets on the 1st of each month (UTC)." },
  { q: "Can I change or cancel later?", a: "Yes. Workspace owners manage the plan, payment method and invoices through Stripe's billing portal. Downgrades never delete data." },
  { q: "Do demo businesses count toward limits?", a: "No. Demo businesses hold separate, clearly labelled sample data and don't count." },
];

export function Pricing() {
  return (
    <main className="mx-auto max-w-6xl px-5 pb-24 pt-20">
      <div className="text-center">
        <h1 className="text-4xl font-semibold sm:text-5xl">Simple, per-workspace pricing</h1>
        <p className="mx-auto mt-4 max-w-2xl text-muted">Start with a 14-day Growth trial — no card needed. Prices in USD per month; taxes may apply.</p>
      </div>
      <ul className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {(["free", ...PAID_PLANS] as PlanId[]).map((id) => {
          const p = PLANS[id];
          const featured = id === "growth";
          return (
            <li key={id} className={cn("panel relative flex flex-col p-6", featured && "border-accent/50 shadow-[0_0_40px_-12px_rgba(34,211,238,0.45)]")}>
              {featured && <span className="absolute -top-3 left-6 rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-[#04121a]">Most popular</span>}
              <h2 className="font-display text-xl font-semibold">{p.name}</h2>
              <p className="mt-1 text-sm text-muted">{p.tagline}</p>
              <p className="mt-4"><span className="font-display text-4xl font-semibold">${p.priceMonthly}</span><span className="text-muted"> / month</span></p>
              <ul className="mt-5 flex-1 space-y-2 text-sm">
                {p.highlights.map((h) => <li key={h} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />{h}</li>)}
              </ul>
              <ButtonLink to="/signup" variant={featured ? "primary" : "outline"} className="mt-6 w-full justify-center">{id === "free" ? "Start free" : "Start trial"}</ButtonLink>
            </li>
          );
        })}
      </ul>
      <section className="panel mt-10 p-6" aria-labelledby="every-h">
        <h2 id="every-h" className="font-semibold">Included in every plan</h2>
        <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">{EVERY_PLAN.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />{f}</li>)}</ul>
      </section>
      <section className="mt-16" aria-labelledby="faq-h">
        <h2 id="faq-h" className="text-2xl font-semibold">Questions</h2>
        <dl className="mt-6 grid gap-6 md:grid-cols-2">
          {FAQ.map((f) => <div key={f.q}><dt className="font-medium">{f.q}</dt><dd className="mt-1 text-sm text-muted">{f.a}</dd></div>)}
        </dl>
      </section>
      <div className="mt-16 text-center"><ButtonLink to="/signup" variant="primary" size="lg">Get started <ArrowRight className="size-4" /></ButtonLink></div>
    </main>
  );
}
