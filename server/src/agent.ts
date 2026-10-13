import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountUpdates, CONNECTORS, getConnector } from "./connectors/index.js";
import type { Account } from "./store.js";

// ----------------------------------------------------------------- types shared with the client

const VIZ = ["stat", "line", "area", "bar", "list"] as const;

export interface Widget {
  id: string;
  title: string;
  provider: string;
  metric: string;
  viz: (typeof VIZ)[number];
  refreshSec: number;
}

export interface DashboardState {
  id: string;
  name: string;
  widgets: Widget[];
}

export type DashboardOp =
  | { op: "add_widget"; widget: Widget }
  | { op: "update_widget"; id: string; changes: Partial<Omit<Widget, "id">> }
  | { op: "remove_widget"; id: string }
  | { op: "create_dashboard"; id: string; name: string }
  | { op: "rename_dashboard"; name: string };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentResult {
  reply: string;
  ops: DashboardOp[];
  /** Tool steps, shown in the UI as JARVIS's "thought trace". */
  steps: string[];
  mode: "claude" | "offline";
}

// ----------------------------------------------------------------- tools

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_updates",
    description:
      "Fetch the latest updates (new emails, messages, PRs, payments, prices, weather…) from one connected account. Call it once per account you need; call several in parallel for a general briefing.",
    input_schema: {
      type: "object",
      properties: { provider: { type: "string", description: "Connector id of a connected account, e.g. github, google, slack." } },
      required: ["provider"],
      additionalProperties: false,
    },
  },
  {
    name: "add_widget",
    description:
      "Add a live widget to the user's current dashboard. The provider must be connected and the metric must be one of that connector's metrics. Pick a viz from the metric's allowed list.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short widget title." },
        provider: { type: "string" },
        metric: { type: "string" },
        viz: { type: "string", enum: [...VIZ] },
        refresh_sec: { type: "integer", description: "How often the widget refreshes. Default 60.", minimum: 10, maximum: 3600 },
      },
      required: ["title", "provider", "metric", "viz"],
      additionalProperties: false,
    },
  },
  {
    name: "update_widget",
    description: "Change an existing widget on the current dashboard (title, visualisation or refresh interval).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        viz: { type: "string", enum: [...VIZ] },
        refresh_sec: { type: "integer", minimum: 10, maximum: 3600 },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_widget",
    description: "Remove a widget from the current dashboard.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "create_dashboard",
    description: "Create a new, empty dashboard and switch to it. Subsequent add_widget calls go to the new dashboard.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
  {
    name: "rename_dashboard",
    description: "Rename the current dashboard.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
];

const schemas = {
  get_updates: z.object({ provider: z.string() }),
  add_widget: z.object({ title: z.string().min(1), provider: z.string(), metric: z.string(), viz: z.enum(VIZ), refresh_sec: z.number().int().min(10).max(3600).optional() }),
  update_widget: z.object({ id: z.string(), title: z.string().optional(), viz: z.enum(VIZ).optional(), refresh_sec: z.number().int().min(10).max(3600).optional() }),
  remove_widget: z.object({ id: z.string() }),
  create_dashboard: z.object({ name: z.string().min(1) }),
  rename_dashboard: z.object({ name: z.string().min(1) }),
};

/** Runs one tool call against the session's accounts and the (mutable copy of the) dashboard. */
class Toolbox {
  ops: DashboardOp[] = [];
  steps: string[] = [];
  constructor(private accounts: Map<string, Account>, private dash: DashboardState) {}

  async run(name: string, rawInput: unknown): Promise<string> {
    const schema = schemas[name as keyof typeof schemas];
    if (!schema) throw new Error(`Unknown tool ${name}`);
    const input: any = schema.parse(rawInput);

    switch (name) {
      case "get_updates": {
        const account = this.accounts.get(input.provider);
        if (!account) throw new Error(`${input.provider} is not connected. Ask the user to connect it from the Accounts panel.`);
        this.steps.push(`Scanning ${getConnector(input.provider)?.name ?? input.provider}…`);
        return accountUpdates(account);
      }
      case "add_widget": {
        const c = getConnector(input.provider);
        if (!this.accounts.has(input.provider) || !c) throw new Error(`${input.provider} is not connected.`);
        const m = c.metrics.find((x) => x.id === input.metric);
        if (!m) throw new Error(`${c.name} has no metric "${input.metric}". Options: ${c.metrics.map((x) => x.id).join(", ")}`);
        const widget: Widget = {
          id: randomUUID().slice(0, 8),
          title: input.title,
          provider: input.provider,
          metric: input.metric,
          viz: m.viz.includes(input.viz) ? input.viz : m.viz[0],
          refreshSec: input.refresh_sec ?? 60,
        };
        this.dash.widgets.push(widget);
        this.ops.push({ op: "add_widget", widget });
        this.steps.push(`Deploying widget "${widget.title}"`);
        return `Added widget ${widget.id} (${widget.viz}).`;
      }
      case "update_widget": {
        const w = this.dash.widgets.find((x) => x.id === input.id);
        if (!w) throw new Error(`No widget with id ${input.id} on this dashboard.`);
        const changes: Partial<Widget> = {};
        if (input.title) changes.title = input.title;
        if (input.viz) changes.viz = input.viz;
        if (input.refresh_sec) changes.refreshSec = input.refresh_sec;
        Object.assign(w, changes);
        this.ops.push({ op: "update_widget", id: w.id, changes });
        this.steps.push(`Reconfiguring "${w.title}"`);
        return "Updated.";
      }
      case "remove_widget": {
        const idx = this.dash.widgets.findIndex((x) => x.id === input.id);
        if (idx < 0) throw new Error(`No widget with id ${input.id} on this dashboard.`);
        const [w] = this.dash.widgets.splice(idx, 1);
        this.ops.push({ op: "remove_widget", id: w.id });
        this.steps.push(`Removing "${w.title}"`);
        return "Removed.";
      }
      case "create_dashboard": {
        const id = randomUUID().slice(0, 8);
        this.dash = { id, name: input.name, widgets: [] };
        this.ops.push({ op: "create_dashboard", id, name: input.name });
        this.steps.push(`Creating dashboard "${input.name}"`);
        return `Created and switched to dashboard ${id}.`;
      }
      case "rename_dashboard": {
        this.dash.name = input.name;
        this.ops.push({ op: "rename_dashboard", name: input.name });
        return "Renamed.";
      }
    }
    throw new Error(`Unhandled tool ${name}`);
  }
}

// ----------------------------------------------------------------- context

function contextBlock(accounts: Map<string, Account>, dash: DashboardState): string {
  const connected = [...accounts.values()].map((a) => {
    const c = getConnector(a.provider)!;
    return `- ${c.id} (${c.name})${a.demo ? " [demo data]" : ""}; metrics: ${c.metrics.map((m) => `${m.id} "${m.label}" viz=${m.viz.join("|")}`).join("; ")}`;
  });
  const available = CONNECTORS.filter((c) => !accounts.has(c.id)).map((c) => `${c.id} (${c.name})`);
  const widgets = dash.widgets.map((w) => `- id=${w.id} "${w.title}" ${w.provider}/${w.metric} viz=${w.viz} every ${w.refreshSec}s`);
  return [
    `<context>`,
    `Local time: ${new Date().toString()}`,
    `Connected accounts:\n${connected.join("\n") || "(none yet)"}`,
    `Not connected (user can connect these from the Accounts panel): ${available.join(", ") || "none"}`,
    `Current dashboard: "${dash.name}" (id=${dash.id})\n${widgets.join("\n") || "(no widgets)"}`,
    `</context>`,
  ].join("\n");
}

const SYSTEM = `You are JARVIS, a calm, witty, highly capable AI assistant running the user's personal command center.

The user talks to you by voice or text to get updates from their connected accounts (email, calendar, GitHub, Slack, Stripe, markets, weather, news) and to build live dashboards.

How to work:
- For questions about what's new, call get_updates for the relevant connected account(s) and then brief the user. For a general "what did I miss" briefing, check every connected account in parallel.
- Only use accounts listed as connected. If the user asks about one that isn't connected, tell them to connect it from the Accounts panel — never invent data.
- When the user asks to see, track, chart or monitor something, build it with add_widget (choose a sensible title and viz). When they ask for a whole dashboard, create one with create_dashboard first and then add several widgets that fit the theme. Edit or remove widgets by their id when asked.
- Accounts marked [demo data] show sample data; mention that once if relevant.

How to reply:
- Your replies are often read aloud, so speak naturally: short sentences, lead with what matters, no markdown tables, no headings, at most a few short bullet points.
- Keep it brief — two to five sentences for most answers. Be precise with numbers and names from the data.
- A touch of dry British-butler wit is welcome; never at the expense of clarity.`;

// ----------------------------------------------------------------- Claude loop

const client = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;
export const aiMode = (): AgentResult["mode"] => (client ? "claude" : "offline");

const MODEL = process.env.JARVIS_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.JARVIS_EFFORT || "low") as "low" | "medium" | "high";
const MAX_STEPS = 8;

export async function runAgent(history: ChatTurn[], accounts: Map<string, Account>, dashboard: DashboardState): Promise<AgentResult> {
  const dash: DashboardState = structuredClone(dashboard);
  const toolbox = new Toolbox(accounts, dash);
  if (!client) return offlineAgent(history, accounts, dash, toolbox);

  // Keep the last 20 turns; attach live context to the newest user message so the
  // system prompt and older history stay byte-stable (prompt-cache friendly).
  const recent = history.slice(-20);
  while (recent.length && recent[0].role !== "user") recent.shift();
  const messages: Anthropic.Beta.BetaMessageParam[] = recent.map((t, i) => ({
    role: t.role,
    content: i === recent.length - 1 ? `${contextBlock(accounts, dash)}\n\n${t.content}` : t.content,
  }));

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      output_config: { effort: EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (response.stop_reason === "refusal") {
      return { reply: text || "I'm afraid I can't help with that one.", ops: toolbox.ops, steps: toolbox.steps, mode: "claude" };
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { reply: text || "Done.", ops: toolbox.ops, steps: toolbox.steps, mode: "claude" };
    }

    messages.push({ role: "assistant", content: response.content });
    // Read-only fetches run in parallel; dashboard edits run in order so ids line up.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    const fetches = toolUses.filter((t) => t.name === "get_updates");
    const edits = toolUses.filter((t) => t.name !== "get_updates");
    const settled = await Promise.all(fetches.map((t) => runTool(toolbox, t)));
    results.push(...settled);
    for (const t of edits) results.push(await runTool(toolbox, t));
    // Return results in the order Claude asked for them.
    results.sort((a, b) => toolUses.findIndex((t) => t.id === a.tool_use_id) - toolUses.findIndex((t) => t.id === b.tool_use_id));
    messages.push({ role: "user", content: results });
  }
  return { reply: "That took more steps than I'd like — here's where I got to.", ops: toolbox.ops, steps: toolbox.steps, mode: "claude" };
}

async function runTool(toolbox: Toolbox, t: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  try {
    return { type: "tool_result", tool_use_id: t.id, content: await toolbox.run(t.name, t.input) };
  } catch (err) {
    const message = err instanceof z.ZodError ? `Invalid input: ${err.message}` : (err as Error).message;
    return { type: "tool_result", tool_use_id: t.id, content: message, is_error: true };
  }
}

// ----------------------------------------------------------------- offline fallback

/** Keyword-driven assistant used when no API key is configured, so the UI is still explorable. */
async function offlineAgent(history: ChatTurn[], accounts: Map<string, Account>, dash: DashboardState, toolbox: Toolbox): Promise<AgentResult> {
  const q = (history.at(-1)?.content ?? "").toLowerCase();
  const done = (reply: string): AgentResult => ({ reply, ops: toolbox.ops, steps: toolbox.steps, mode: "offline" });
  const aliases: Record<string, string[]> = {
    google: ["google", "gmail", "email", "mail", "inbox", "calendar", "meeting", "agenda", "schedule"],
    github: ["github", "pull request", "pr", "repo", "code", "commit"],
    slack: ["slack", "channel", "team"],
    stripe: ["stripe", "payment", "revenue", "sales", "balance", "money"],
    weather: ["weather", "temperature", "rain", "forecast"],
    crypto: ["crypto", "bitcoin", "btc", "ethereum", "price", "market"],
    hackernews: ["hacker news", "hn", "news", "headlines", "stories"],
  };
  const mentioned = Object.keys(aliases).filter((p) => aliases[p].some((a) => new RegExp(`\\b${a}\\b`).test(q)));
  const connected = [...accounts.keys()];

  if (!connected.length) {
    return done("No accounts are connected yet. Open the Accounts panel and connect one — demo mode works without any credentials.");
  }

  const wantsWidget = /\b(add|show|create|build|make|chart|graph|track|monitor|widget|dashboard|plot)\b/.test(q) && !/\b(what|any)\b.*\bupdate/.test(q);
  if (wantsWidget) {
    const targets = (mentioned.length ? mentioned : connected).filter((p) => accounts.has(p));
    if (!targets.length) return done(`${mentioned.join(", ")} isn't connected yet. Connect it from the Accounts panel and ask again.`);
    if (/\bdashboard\b/.test(q) && /\b(new|create|build|make)\b/.test(q)) {
      await toolbox.run("create_dashboard", { name: mentioned.length ? `${mentioned.map((m) => getConnector(m)!.name.split(" ")[0]).join(" & ")} Ops` : "Command Center" });
    }
    for (const p of targets) {
      const c = getConnector(p)!;
      const metrics = mentioned.length ? c.metrics : c.metrics.slice(0, 1);
      for (const m of metrics) await toolbox.run("add_widget", { title: m.label, provider: p, metric: m.id, viz: m.viz[0] });
    }
    return done(`Done. I've deployed ${toolbox.ops.filter((o) => o.op === "add_widget").length} live widget(s). Drag, resize or edit them as you like.`);
  }

  const targets = mentioned.length ? mentioned : connected;
  const missing = targets.filter((p) => !accounts.has(p));
  const parts: string[] = [];
  for (const p of targets.filter((x) => accounts.has(x))) {
    parts.push(`${getConnector(p)!.name}:\n${await toolbox.run("get_updates", { provider: p })}`);
  }
  if (missing.length) parts.push(`(${missing.map((m) => getConnector(m)!.name).join(", ")} not connected.)`);
  return done(`Offline mode — add an ANTHROPIC_API_KEY for natural conversation. Here's the raw feed:\n\n${parts.join("\n\n")}`);
}
