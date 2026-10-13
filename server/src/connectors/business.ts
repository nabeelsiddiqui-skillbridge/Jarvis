import { Connector, Credentials, getJson, relTime } from "./types.js";

// ---------------------------------------------------------------- Slack

async function slack(method: string, creds: Credentials, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const data = await getJson(`https://slack.com/api/${method}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

async function recentSlackMessages(creds: Credentials, limit: number) {
  const { channels } = await slack("users.conversations", creds, { types: "public_channel,private_channel", limit: "20", exclude_archived: "true" });
  const histories = await Promise.all(
    channels.slice(0, 6).map(async (c: any) => {
      const h = await slack("conversations.history", creds, { channel: c.id, limit: "5" }).catch(() => ({ messages: [] }));
      return h.messages.map((m: any) => ({ channel: c.name, text: m.text as string, ts: Number(m.ts) * 1000 }));
    }),
  );
  return { channels, messages: histories.flat().sort((a, b) => b.ts - a.ts).slice(0, limit) };
}

export const slackConnector: Connector = {
  id: "slack",
  name: "Slack",
  category: "Communication",
  description: "Latest messages from the channels your bot is in.",
  auth: "token",
  docsUrl: "https://api.slack.com/apps",
  fields: [
    {
      key: "token",
      label: "Bot token",
      placeholder: "xoxb-…",
      secret: true,
      help: "Create a Slack app, add channels:history, channels:read, groups:history, groups:read scopes, install it and paste the bot token.",
    },
  ],
  metrics: [
    { id: "recent", label: "Recent messages", viz: ["list"] },
    { id: "channels", label: "Channels joined", viz: ["stat"] },
  ],
  async verify(creds) {
    await slack("auth.test", creds);
  },
  async updates(creds) {
    const { channels, messages } = await recentSlackMessages(creds, 10);
    return [`Member of ${channels.length} channel(s).`, ...messages.map((m) => `- #${m.channel} (${relTime(m.ts)}): ${m.text.slice(0, 160)}`)].join("\n");
  },
  async fetchMetric(metric, creds) {
    const { channels, messages } = await recentSlackMessages(creds, 20);
    if (metric === "channels") return { kind: "stat", value: channels.length, label: "channels" };
    return { kind: "list", items: messages.map((m) => ({ title: m.text.slice(0, 120) || "(attachment)", subtitle: `#${m.channel}`, time: relTime(m.ts) })) };
  },
};

// ---------------------------------------------------------------- Stripe

const stripe = (path: string, creds: Credentials) =>
  getJson(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Bearer ${creds.key}` } });

const money = (cents: number, currency: string) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() });

export const stripeConnector: Connector = {
  id: "stripe",
  name: "Stripe",
  category: "Finance",
  description: "Balance, recent payments and 7-day revenue.",
  auth: "token",
  docsUrl: "https://dashboard.stripe.com/apikeys",
  fields: [
    {
      key: "key",
      label: "Restricted API key",
      placeholder: "rk_live_… or sk_test_…",
      secret: true,
      help: "Use a restricted key with read access to Balance and Charges.",
    },
  ],
  metrics: [
    { id: "balance", label: "Available balance", viz: ["stat"] },
    { id: "payments", label: "Recent payments", viz: ["list"] },
    { id: "revenue_7d", label: "Revenue last 7 days", viz: ["bar", "area", "line"] },
  ],
  async verify(creds) {
    await stripe("/balance", creds);
  },
  async updates(creds) {
    const [bal, charges] = await Promise.all([stripe("/balance", creds), stripe("/charges?limit=10", creds)]);
    const avail = bal.available.map((b: any) => money(b.amount, b.currency)).join(", ");
    return [
      `Available balance: ${avail || "0"}.`,
      ...charges.data.map((c: any) => `- ${money(c.amount, c.currency)} ${c.status} from ${c.billing_details?.email ?? c.description ?? "customer"} (${relTime(c.created * 1000)})`),
    ].join("\n");
  },
  async fetchMetric(metric, creds) {
    if (metric === "balance") {
      const bal = await stripe("/balance", creds);
      const b = bal.available[0] ?? { amount: 0, currency: "usd" };
      return { kind: "stat", value: money(b.amount, b.currency), label: "available" };
    }
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const charges = await stripe(`/charges?limit=100&created[gte]=${since}`, creds);
    if (metric === "payments") {
      return {
        kind: "list",
        items: charges.data.slice(0, 20).map((c: any) => ({
          title: money(c.amount, c.currency),
          subtitle: `${c.status} · ${c.billing_details?.email ?? c.description ?? ""}`,
          time: relTime(c.created * 1000),
        })),
      };
    }
    if (metric === "revenue_7d") {
      const days: { label: string; value: number }[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400_000);
        days.push({ label: d.toLocaleDateString("en", { weekday: "short" }), value: 0 });
      }
      for (const c of charges.data) {
        if (c.status !== "succeeded") continue;
        const idx = 6 - Math.floor((Date.now() - c.created * 1000) / 86400_000);
        if (days[idx]) days[idx].value += c.amount / 100;
      }
      return { kind: "series", unit: "$", points: days };
    }
    throw new Error(`Unknown Stripe metric ${metric}`);
  },
};
