// Scripted Messages API stand-in for local browser walkthroughs (not a real model).
import { lastUserText, startMockAnthropic, toolResults, type MockReply } from "./mock-anthropic.js";

const fmt = (v: number | null, unit: string, cur?: string) => v == null ? "unavailable" : unit === "currency" ? new Intl.NumberFormat("en-US", { style: "currency", currency: cur ?? "USD", maximumFractionDigits: 0 }).format(v) : unit === "percent" ? `${v.toFixed(1)}%` : v.toLocaleString("en-US");

/** Narratives (briefings, explanations, commentary) restate the figures they're given, citing their ids. */
function narrative(body: any): MockReply {
  let p: any = {};
  try { p = JSON.parse(body.messages[0].content); } catch { /* not JSON */ }
  const n = (v: number | null, unit: string, cur?: string) => fmt(v, unit, cur);
  let text = "Summary unavailable.";
  if (p.headline) {
    const [a, b] = p.headline;
    text = `${a ? `${a.metric} was ${n(a.total, a.unit, a.currency)}${a.change_pct != null ? ` (${a.change_pct >= 0 ? "+" : ""}${a.change_pct}% vs the previous period)` : ""} [${a.id}]` : "No figures yet"}${b ? `, and ${b.metric.toLowerCase()} was ${n(b.total, b.unit, b.currency)} [${b.id}]` : ""}.${p.business?.demo ? " These are demo figures." : ""}${p.open_insights?.length ? `\n\n- Watch: ${p.open_insights[0].title}` : ""}`;
  } else if (p.finding) {
    const e = p.evidence?.[0];
    text = `Possible explanations: ${p.largest_contributors?.[0] ? `lower results from ${p.largest_contributors[0].label}` : "a change in demand"}${e ? ` [${e.id}]` : ""}, or a tracking or campaign change. Check the breakdown and recent campaign edits to confirm.`;
  } else if (p.widgets) {
    const w = p.widgets.filter((x: any) => x.total != null).slice(0, 2);
    text = w.map((x: any) => `${x.widget}: ${n(x.total, x.unit, x.currency)}${x.change_pct != null ? ` (${x.change_pct >= 0 ? "+" : ""}${x.change_pct}%)` : ""} [${x.id}]`).join(". ") + ".";
  }
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

function brain(body: any): MockReply {
  if (!body.stream) return narrative(body);
  const q = lastUserText(body).toLowerCase();
  const results = toolResults(body);
  const n = body.messages.length;
  if (results.length) {
    const texts = results.map((r) => {
      const c = r.content;
      if (r.is_error) return `I couldn't complete that: ${c.error}`;
      if (c.proposal_id) return `I've prepared the dashboard — it's ready for you to review. Use **Preview** to see it with live data, then **Create dashboard** to save it.`;
      if (c.connections) return `Here's the status of your data sources [${c.evidence_id}]:\n\n${c.connections.map((x: any) => `- **${x.provider}** (${x.name}): ${x.status}${x.stale ? ", stale" : ""}${x.latestDataDate ? `, data through ${x.latestDataDate}` : ""}`).join("\n")}`;
      if (c.breakdown) return `**${c.label}** by ${c.breakdown.length ? "channel" : ""} for ${c.range.from} to ${c.range.to} [${c.evidence_id}]:\n\n| Channel | ${c.label} | Share |\n|---|---|---|\n${c.breakdown.slice(0, 6).map((b: any) => `| ${b.label} | ${fmt(b.value, c.unit, c.currency)} | ${b.share_pct ?? "—"}% |`).join("\n")}\n\n${c.limitations?.length ? `_Note: ${c.limitations[0]}_` : ""}`;
      if (c.evidence_id) return `**${c.label}** was **${fmt(c.total, c.unit, c.currency)}** from ${c.range.from} to ${c.range.to} [${c.evidence_id}]${c.change_pct != null ? `, ${c.change_pct >= 0 ? "up" : "down"} ${Math.abs(c.change_pct).toFixed(1)}% from ${fmt(c.comparison_total, c.unit, c.currency)} in the previous period` : ""}.${c.demo_data ? "\n\nThese figures come from the demo business's sample data." : ""}`;
      return "Done.";
    });
    return { stop_reason: "end_turn", content: [{ type: "text", text: texts.join("\n\n") }] };
  }
  const tu = (name: string, input: unknown): MockReply => ({ stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: `sig-${n}` }, { type: "tool_use", id: `tu_${n}`, name, input }] });
  if (q.includes("dashboard")) return tu("propose_dashboard", { name: "Marketing performance", summary: "Spend, ROAS, sessions and conversion rate, with channel breakdowns.", widgets: [
    { type: "kpi", title: "Ad spend", metric: "ad_spend" }, { type: "kpi", title: "ROAS", metric: "roas" }, { type: "kpi", title: "Sessions", metric: "sessions" }, { type: "kpi", title: "Conversion rate", metric: "conversion_rate" },
    { type: "area", title: "Sessions trend", metric: "sessions" }, { type: "bar", title: "Sessions by channel", metric: "sessions", dimension: "channel" },
  ] });
  if (q.includes("stale") || q.includes("missing")) return tu("get_data_status", {});
  if (q.includes("channel")) return tu("query_metric", { metric: "sessions", dimension: "channel", date_range: { preset: "month_to_date" } });
  if (q.includes("roas")) return tu("query_metric", { metric: "roas", date_range: { preset: "last_30_days" }, comparison: "previous_period" });
  if (q.includes("sales")) return tu("query_metric", { metric: "store_net_sales", date_range: { preset: "last_30_days" }, comparison: "previous_period" });
  return { stop_reason: "end_turn", content: [{ type: "text", text: "I can answer questions about this business's sales, traffic, advertising, search and CRM data, or build a dashboard. What would you like to know?" }] };
}

const m = await startMockAnthropic(brain);
console.log(`[mock-anthropic] ${m.url}`);
