import { ArrowRight, BarChart3, Bot, Building2, CheckCircle2, FileText, Lightbulb, Mic, Plug, ShieldCheck, Workflow } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { JarvisCore } from "@/components/jarvis/JarvisCore";

/** Working integrations by category. Mirrors the server's connector catalog. */
export const CONNECTOR_GROUPS: [string, string[]][] = [
  ["Commerce & payments", ["Shopify", "WooCommerce", "Stripe"]],
  ["Advertising", ["Google Ads", "Meta Ads", "TikTok Ads", "LinkedIn Ads"]],
  ["Website & search", ["Google Analytics 4", "Google Search Console"]],
  ["Social", ["Facebook Pages", "Instagram"]],
  ["Email marketing", ["Klaviyo", "Mailchimp", "Brevo"]],
  ["CRM", ["HubSpot", "Salesforce", "GoHighLevel"]],
  ["Support", ["Zendesk", "Intercom"]],
  ["Accounting", ["QuickBooks Online", "Xero"]],
  ["Your own data", ["Google Sheets", "CSV upload"]],
];
export const LIVE_CONNECTORS = CONNECTOR_GROUPS.flatMap(([, list]) => list);

export function Home() {
  return (
    <main>
      <section className="relative overflow-hidden">
        <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_50%_0%,#000,transparent_70%)]" />
        <div className="relative mx-auto max-w-4xl px-5 pb-20 pt-16 text-center sm:pt-20">
          <JarvisCore state="listening" size={240} className="mx-auto mb-8" />
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">AI business command center</p>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.08] sm:text-6xl">
            Run every business from <span className="text-gradient">one command center</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-muted sm:text-lg">
            Connect your store, analytics, ads and CRM. Ask questions by voice or text, get answers that cite their sources, and build live dashboards in seconds — for one business or a whole client portfolio.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/signup" variant="primary" size="lg">Start a 14-day trial <ArrowRight className="size-4" /></ButtonLink>
            <ButtonLink to="/pricing" variant="outline" size="lg">See pricing</ButtonLink>
          </div>
          <p className="mt-4 text-xs text-subtle">No card needed. Explore a clearly labelled demo business before connecting anything.</p>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-5 px-5 pb-20 sm:grid-cols-2 lg:grid-cols-4" aria-label="Highlights">
        {[
          { icon: Building2, title: "Multi-business", body: "Separate businesses with their own connections, dashboards and permissions. Built for owners, teams and agencies." },
          { icon: BarChart3, title: "Live dashboards", body: "Drag, resize and edit widgets backed by validated metric definitions — never invented numbers." },
          { icon: Bot, title: "Voice & text assistant", body: "Answers include the source accounts, date range, definitions, freshness and limitations." },
          { icon: ShieldCheck, title: "Secure by design", body: "Encrypted tokens, row-level security, audited approvals for every external action." },
        ].map((f) => (
          <div key={f.title} className="panel p-6">
            <f.icon className="size-6 text-accent" aria-hidden />
            <h2 className="mt-4 font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-muted">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20" aria-labelledby="how-h">
        <h2 id="how-h" className="text-center text-2xl font-semibold sm:text-3xl">From connected accounts to decisions</h2>
        <ol className="mt-10 grid gap-5 md:grid-cols-3">
          {[
            { icon: Plug, title: "1. Connect", body: "Sign in or paste a read-only API key for each platform, pick the exact store, property or account, and watch the first import progress." },
            { icon: Mic, title: "2. Ask", body: "“How did sales do last week, and why?” The assistant queries your normalized metrics and shows the evidence: source, period, comparison and freshness." },
            { icon: Lightbulb, title: "3. Act", body: "Daily briefings, alerts and insights surface what changed. Supported changes — like pausing a campaign — are proposed, approved and logged." },
          ].map((s) => (
            <li key={s.title} className="panel p-6">
              <s.icon className="size-6 text-violet" aria-hidden />
              <h3 className="mt-4 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-20 lg:grid-cols-2" aria-labelledby="evidence-h">
        <div>
          <h2 id="evidence-h" className="text-2xl font-semibold sm:text-3xl">Answers you can check</h2>
          <p className="mt-4 text-muted">Every figure comes from a tool call against your own data — never from the model's imagination. Store sales, analytics revenue, ad-attributed value and CRM pipeline stay separate, because they measure different things.</p>
          <ul className="mt-6 space-y-2 text-sm">
            {["Citations link each number to its evidence card", "Stale or missing sources are flagged, not hidden", "Delayed provider reporting is never presented as real-time", "Possible explanations are labelled as possibilities"].map((t) => (
              <li key={t} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />{t}</li>
            ))}
          </ul>
        </div>
        <figure className="panel p-5" aria-label="Example assistant answer">
          <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2 text-sm">How did net sales do last week?</p>
          <div className="mt-4 space-y-3 text-sm">
            <p>Net sales were <strong>$48,210</strong> for the 7 days to Sunday, down <strong>8.4%</strong> on the previous 7 days <span className="rounded bg-accent/15 px-1.5 text-xs text-accent">E1</span>. The drop came mostly from the Trail Runner jacket <span className="rounded bg-accent/15 px-1.5 text-xs text-accent">E2</span>.</p>
            <div className="rounded-lg border border-line bg-panel-2 p-3 text-xs text-muted">
              <p className="font-medium text-fg">E1 · Store net sales</p>
              <p>Shopify · Example store · 7 days vs previous 7 · synced 12 min ago</p>
            </div>
          </div>
          <figcaption className="mt-3 text-[11px] text-subtle">Illustrative example; figures are not from a real business.</figcaption>
        </figure>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20" aria-labelledby="more-h">
        <h2 id="more-h" className="sr-only">More features</h2>
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { icon: FileText, title: "Briefings & reports", body: "A daily briefing and weekly report per business, with evidence, exports and print-ready layouts." },
            { icon: Workflow, title: "Automations", body: "Threshold alerts, connection-failure alerts and tasks from new insights — each run recorded, never duplicated." },
            { icon: ShieldCheck, title: "Approved actions", body: "Pause a campaign, change a budget or move a deal: current and proposed values, approval bound to the exact change, executed once." },
          ].map((f) => (
            <div key={f.title} className="panel p-6">
              <f.icon className="size-6 text-accent" aria-hidden />
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-24" aria-labelledby="connectors-h">
        <h2 id="connectors-h" className="text-center text-2xl font-semibold sm:text-3xl">Integrations</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-muted">{LIVE_CONNECTORS.length} working integrations. Figures from different platforms are added up only where they measure separate things — and every number says where it came from.</p>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {CONNECTOR_GROUPS.map(([group, list]) => (
            <div key={group} className="panel p-5">
              <h3 className="hud-label text-[11px] text-subtle">{group}</h3>
              <ul className="mt-3 flex flex-wrap gap-2">{list.map((c) => <li key={c} className="rounded-full border border-success/30 bg-success/10 px-3 py-1 text-sm text-success">{c}</li>)}</ul>
            </div>
          ))}
        </div>
        <div className="mt-12 text-center">
          <ButtonLink to="/signup" variant="primary" size="lg">Start a 14-day trial <ArrowRight className="size-4" /></ButtonLink>
        </div>
      </section>
    </main>
  );
}
