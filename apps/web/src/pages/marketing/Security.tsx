import { Database, Eye, KeyRound, Lock, ScrollText, ShieldCheck, Trash2, UserCheck } from "lucide-react";

const ITEMS = [
  { icon: Lock, title: "Encrypted credentials", body: "Provider tokens are encrypted at rest (AES-256-GCM) and only ever used on the server. They never reach your browser." },
  { icon: Database, title: "Isolation by business", body: "Every query runs as a restricted database role with row-level security, on top of server-side permission checks. A business ID in the browser is never enough to read data." },
  { icon: KeyRound, title: "Minimum scopes", body: "Connectors request read-only scopes. Write access (for approved actions) is requested only where an action needs it." },
  { icon: UserCheck, title: "Roles and approvals", body: "Owners, administrators, analysts and viewers per business. External changes need an administrator's approval, bound to the exact change, and run once." },
  { icon: ScrollText, title: "Audit logs", body: "Sign-ins, membership changes, exports, approvals, connection changes and billing events are recorded and visible to workspace owners." },
  { icon: Eye, title: "Support access you control", body: "Our staff can't see your data unless they open a time-limited, read-only grant with a reason. You're notified, can end it at any time, and every page they open appears in your audit log." },
  { icon: Trash2, title: "Retention and deletion", body: "Choose how long imported records are kept. Disconnecting an account can delete its imported data; deleting a workspace removes everything in it." },
  { icon: ShieldCheck, title: "Verified integrations", body: "OAuth state is verified on every callback and webhooks are signature-checked. Payments are handled by Stripe; we never see card numbers." },
];

export function Security() {
  return (
    <main className="mx-auto max-w-6xl px-5 pb-24 pt-20">
      <div className="text-center">
        <h1 className="text-4xl font-semibold sm:text-5xl">Security and privacy</h1>
        <p className="mx-auto mt-4 max-w-2xl text-muted">Your business data belongs to you. Here's how the platform protects it.</p>
      </div>
      <ul className="mt-12 grid gap-5 sm:grid-cols-2">
        {ITEMS.map((i) => (
          <li key={i.title} className="panel flex gap-4 p-6">
            <i.icon className="mt-0.5 size-6 shrink-0 text-accent" aria-hidden />
            <div>
              <h2 className="font-semibold">{i.title}</h2>
              <p className="mt-1.5 text-sm text-muted">{i.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
