import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup } from "./helpers.js";
import { lastUserText, startMockAnthropic, toolResults, type MockAnthropicState, type MockReply } from "./mock-anthropic.js";

let app: any;
let pool: any;
let mock: { url: string; state: MockAnthropicState; close: () => Promise<void> };

/** A scripted model: picks tools from keywords and answers from the tool results it gets back. */
function brain(body: any): MockReply {
  const results = toolResults(body);
  const q = lastUserText(body).toLowerCase();
  if (results.length) {
    const r = results[0]!;
    if (r.is_error) {
      if (r.content.problems && !body.messages.some((m: any) => JSON.stringify(m).includes("Fixed dashboard"))) {
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu_${body.messages.length}`, name: "propose_dashboard", input: { name: "Fixed dashboard", summary: "Sales and orders.", widgets: [{ type: "kpi", title: "Net sales", metric: "store_net_sales" }, { type: "bar", title: "Sales by product", metric: "store_net_sales", dimension: "product" }] } }] };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: `That didn't work: ${r.content.error}` }] };
    }
    if (r.content.evidence_id) return { stop_reason: "end_turn", content: [{ type: "text", text: `Net sales from ${r.content.range.from} to ${r.content.range.to} were ${r.content.total} ${r.content.currency} [${r.content.evidence_id}].` }] };
    if (r.content.proposal_id) return { stop_reason: "end_turn", content: [{ type: "text", text: "Your dashboard is ready to review." }] };
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
  }
  const id = `tu_${body.messages.length}`;
  if (q.includes("refuse")) return { stop_reason: "refusal", content: [{ type: "text", text: "Partial" }] };
  if (q.includes("dashboard")) {
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "propose_dashboard", input: { name: "First try", widgets: [{ type: "kpi", title: "Bogus", metric: "not_a_metric" }] } }] };
  }
  if (q.includes("sales")) {
    return { stop_reason: "tool_use", content: [
      { type: "thinking", thinking: "", signature: `sig-${body.messages.length}` },
      { type: "text", text: "Let me check. " },
      { type: "tool_use", id, name: "query_metric", input: { metric: "store_net_sales", date_range: { preset: "last_30_days" }, comparison: "previous_period" } },
    ] };
  }
  if (q.includes("bad input")) return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "query_metric", input: { metric: "store_net_sales" } }] };
  return { stop_reason: "end_turn", content: [{ type: "text", text: "Hello! Ask me about your business." }] };
}

beforeAll(async () => {
  mock = await startMockAnthropic(brain);
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.ANTHROPIC_BASE_URL = mock.url;
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
});
afterAll(async () => mock?.close());

const sseParser = (res: any, cb: any) => {
  let d = "";
  res.setEncoding("utf8");
  res.on("data", (c: string) => (d += c));
  res.on("end", () => cb(null, d));
};

async function ask(c: any, businessId: string, conversationId: string, text: string) {
  const r = await c.agent.post(`/api/businesses/${businessId}/assistant/conversations/${conversationId}/messages`)
    .set("X-BCA-Client", "web").send({ text }).buffer(true).parse(sseParser);
  if (r.status !== 200) return { status: r.status, body: JSON.parse(String(r.body)), events: [] as any[] };
  const events = String(r.body).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return { status: 200, events, done: events.find((e) => e.type === "done")?.message, text: events.filter((e) => e.type === "text").map((e) => e.delta).join("") };
}

describe("AI assistant (against a scripted Messages API stand-in)", () => {
  let owner: any, businessId: string, conversationId: string;

  it("sets up a business with data and a conversation", async () => {
    owner = await signup(app, "Owner");
    const ws = await owner.post("/api/workspaces", { name: "Owner WS" });
    const demo = await owner.post(`/api/workspaces/${ws.body.id}/demo-business`, {});
    expect(demo.status).toBe(201);
    businessId = demo.body.id ?? demo.body.businessId;
    const status = await owner.get(`/api/businesses/${businessId}/assistant/status`);
    expect(status.body.configured).toBe(true);
    const conv = await owner.post(`/api/businesses/${businessId}/assistant/conversations`, {});
    expect(conv.status).toBe(201);
    conversationId = conv.body.id;
  });

  it("answers with evidence built from the real query result", async () => {
    const r = await ask(owner, businessId, conversationId, "How were sales in the last 30 days?");
    expect(r.status).toBe(200);
    const types = r.events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("step");
    expect(types).toContain("evidence");
    expect(types.at(-1)).toBe("done");
    const msg = r.done;
    expect(msg.status).toBe("complete");
    expect(msg.text).toMatch(/\[E1\]/);
    expect(msg.evidence).toHaveLength(1);
    const ev = msg.evidence[0];
    expect(ev).toMatchObject({ id: "E1", kind: "metric", isDemo: true, metric: { key: "store_net_sales" } });
    expect(ev.sources.length).toBeGreaterThan(0);
    // The evidence equals what the metrics API returns for the same query.
    const direct = await owner.post(`/api/businesses/${businessId}/metrics/query`, { query: { metric: "store_net_sales", dateRange: { preset: "last_30_days" }, comparison: "previous_period" } });
    expect(ev.total).toBeCloseTo(direct.body.total, 6);
    expect(ev.range).toEqual(direct.body.range);
    expect(msg.text).toContain(String(Math.round(direct.body.total * 100) / 100));

    // Request shape: streaming tools with eager input, adaptive thinking, explicit effort, server-side fallbacks, cached rules.
    const req = mock.state.requests[0]!;
    expect(req.headers.beta).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", stream: true, fallbacks: "default", thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
    expect(req.body.tool_choice).toBeUndefined();
    expect(req.body.tools.every((t: any) => t.eager_input_streaming === true)).toBe(true);
    expect(req.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.body.system[1].text).toContain("Aurora Outfitters");
  });

  it("replays history append-only (thinking blocks unchanged) and continues evidence numbering", async () => {
    const before = mock.state.requests.length;
    const r = await ask(owner, businessId, conversationId, "And sales again?");
    expect(r.done.evidence[0].id).toBe("E2");
    const body = mock.state.requests[before]!.body;
    expect(body.messages[0]).toEqual({ role: "user", content: "How were sales in the last 30 days?" });
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content[0]).toMatchObject({ type: "thinking", signature: "sig-1" });
    expect(body.messages[1].content.map((b: any) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(body.messages[2].content[0].type).toBe("tool_result");
    // Earlier request bodies are a prefix of later ones.
    const first = mock.state.requests[before - 1]!.body.messages;
    expect(body.messages.slice(0, first.length)).toEqual(first);
  });

  it("rejects invalid tool inputs and reports them to the model as errors", async () => {
    const r = await ask(owner, businessId, conversationId, "bad input please");
    expect(r.done.steps[0].error).toMatch(/INVALID_INPUT/);
    expect(r.done.text).toMatch(/didn't work/);
  });

  it("handles refusals without storing the declined turn for replay", async () => {
    const r = await ask(owner, businessId, conversationId, "please refuse this");
    expect(r.done.status).toBe("refused");
    const row = (await pool.query("SELECT api_messages FROM conversation_messages WHERE id = $1", [r.done.id])).rows[0];
    expect(row.api_messages).toEqual([]);
  });

  it("proposes a dashboard (validated), then applies and undoes it", async () => {
    const r = await ask(owner, businessId, conversationId, "build me a sales dashboard");
    // First proposal had an unknown metric: nothing is stored, the model gets the problems and retries.
    expect(r.done.steps[0].error).toBeTruthy();
    expect(r.done.proposals).toHaveLength(1);
    const p = r.done.proposals[0];
    expect(p).toMatchObject({ kind: "create", status: "pending", widgetCount: 2, name: "Fixed dashboard" });
    expect(r.done.text).toMatch(/ready to review/);
    const dashboardsBefore = (await owner.get(`/api/businesses/${businessId}/dashboards`)).body.length;

    const preview = await owner.get(`/api/businesses/${businessId}/assistant/proposals/${p.id}`);
    expect(preview.body.spec.widgets.map((w: any) => w.type)).toEqual(["kpi", "bar"]);
    expect((await owner.get(`/api/businesses/${businessId}/dashboards`)).body.length).toBe(dashboardsBefore); // nothing saved yet

    const applied = await owner.post(`/api/businesses/${businessId}/assistant/proposals/${p.id}/apply`, {});
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe("applied");
    const dash = await owner.get(`/api/businesses/${businessId}/dashboards/${applied.body.dashboardId}`);
    expect(dash.body.spec.widgets).toHaveLength(2);
    expect((await owner.post(`/api/businesses/${businessId}/assistant/proposals/${p.id}/apply`, {})).status).toBe(409);

    // The conversation shows the updated status.
    const conv = await owner.get(`/api/businesses/${businessId}/assistant/conversations/${conversationId}`);
    expect(conv.body.messages.flatMap((m: any) => m.proposals).find((x: any) => x.id === p.id).status).toBe("applied");

    const undo = await owner.post(`/api/businesses/${businessId}/assistant/proposals/${p.id}/undo`, {});
    expect(undo.body.status).toBe("undone");
    expect((await owner.get(`/api/businesses/${businessId}/dashboards/${applied.body.dashboardId}`)).status).toBe(404);
    const after = await owner.get(`/api/businesses/${businessId}/assistant/conversations/${conversationId}`);
    expect(after.body.messages.flatMap((m: any) => m.proposals).find((x: any) => x.id === p.id).status).toBe("undone");
  });

  it("keeps conversations private to their user and business", async () => {
    const other = await signup(app, "Other");
    expect((await other.get(`/api/businesses/${businessId}/assistant/conversations`)).status).toBe(404);
    expect((await other.get(`/api/businesses/${businessId}/assistant/conversations/${conversationId}`)).status).toBe(404);
    const r = await ask(other, businessId, conversationId, "sales?");
    expect(r.status).toBe(404);
    // Even a teammate with access to the business can't read someone else's conversation.
    const ws = (await pool.query("SELECT workspace_id FROM businesses WHERE id = $1", [businessId])).rows[0].workspace_id;
    await pool.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws, other.userId]);
    await pool.query("INSERT INTO business_memberships (workspace_id, business_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [ws, businessId, other.userId]);
    expect((await other.get(`/api/businesses/${businessId}/assistant/conversations`)).body).toEqual([]);
    expect((await other.get(`/api/businesses/${businessId}/assistant/conversations/${conversationId}`)).status).toBe(404);
    expect((await ask(other, businessId, conversationId, "sales?")).status).toBe(404);
    const rls = await pool.query("SELECT count(*)::int AS n FROM conversation_messages");
    expect(rls.rows[0].n).toBeGreaterThan(0); // (system view) rows exist…

    // …and a viewer may ask questions but the assistant can't propose dashboards for them.
    const conv = await other.post(`/api/businesses/${businessId}/assistant/conversations`, {});
    const v = await ask(other, businessId, conv.body.id, "build me a dashboard");
    expect(v.done.steps[0].error).toMatch(/can view dashboards but not/);
    expect(v.done.proposals).toHaveLength(0);
  });

  it("returns breakdown shares as percentages that add up to 100", async () => {
    const { runTool } = await import("../src/assistant/tools.js");
    let n = 100;
    const out: any = await runTool({ userId: owner.userId, businessId, conversationId, nextEvidenceId: () => `E${++n}` }, "query_metric", { metric: "sessions", dimension: "channel", date_range: { preset: "last_30_days" }, limit: 50 });
    const shares = out.result.breakdown.map((b: any) => b.share_pct);
    expect(shares.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(100, 0);
    expect(Math.max(...shares)).toBeLessThanOrEqual(100);
    // A different business id in the environment is refused (404), even with a valid user.
    const other = await runTool({ userId: owner.userId, businessId: "00000000-0000-4000-8000-000000000000", conversationId, nextEvidenceId: () => "E0" }, "query_metric", { metric: "sessions", date_range: { preset: "last_30_days" } });
    expect(other.isError).toBe(true);
  });

  it("explains the prerequisite when no AI provider is configured", async () => {
    const { config } = await import("../src/config.js");
    const key = config.anthropic.apiKey;
    config.anthropic.apiKey = undefined;
    try {
      expect((await owner.get(`/api/businesses/${businessId}/assistant/status`)).body.configured).toBe(false);
      const r = await ask(owner, businessId, conversationId, "sales?");
      expect(r.status).toBe(412);
      expect(r.body.error.message).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      config.anthropic.apiKey = key;
    }
  });
});
