import express from "express";
import type { Server } from "node:http";

/**
 * A scripted stand-in for the Claude Messages API (streaming). Each request is
 * recorded; `respond` decides the reply from the request body. Replies are sent
 * as the documented SSE event sequence so the real SDK parses them.
 */

export type MockBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; rawJson?: string };

export interface MockReply { content: MockBlock[]; stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal"; model?: string }

export interface MockAnthropicState {
  requests: { headers: Record<string, string | undefined>; body: any }[];
  respond: (body: any) => MockReply;
}

export async function startMockAnthropic(respond: MockAnthropicState["respond"]) {
  const state: MockAnthropicState = { requests: [], respond };
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.post("/v1/messages", (req, res) => {
    if (req.get("x-api-key") !== process.env.ANTHROPIC_API_KEY) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    state.requests.push({ headers: { beta: req.get("anthropic-beta") }, body: structuredClone(req.body) });
    const reply = state.respond(req.body);
    if (!req.body.stream) {
      // Non-streaming request: a complete Message object.
      return res.json({
        id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model: reply.model ?? req.body.model,
        content: reply.content.map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input } : b)),
        stop_reason: reply.stop_reason, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
    const model = reply.model ?? req.body.model;
    send("message_start", { message: { id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    reply.content.forEach((b, index) => {
      if (b.type === "text") {
        send("content_block_start", { index, content_block: { type: "text", text: "" } });
        for (const chunk of b.text.match(/.{1,12}/gs) ?? []) send("content_block_delta", { index, delta: { type: "text_delta", text: chunk } });
      } else if (b.type === "thinking") {
        send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
        if (b.thinking) send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
        send("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
      } else {
        send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        const json = b.rawJson ?? JSON.stringify(b.input);
        for (const chunk of json.match(/.{1,20}/gs) ?? []) send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: chunk } });
      }
      send("content_block_stop", { index });
    });
    send("message_delta", { delta: { stop_reason: reply.stop_reason, stop_sequence: null, ...(reply.stop_reason === "refusal" ? { stop_details: { type: "refusal", category: null, explanation: null } } : {}) }, usage: { output_tokens: 42 } });
    send("message_stop", {});
    res.end();
  });
  return new Promise<{ url: string; state: MockAnthropicState; close: () => Promise<void> }>((resolve) => {
    const server: Server = app.listen(Number(process.env.MOCK_ANTHROPIC_PORT ?? 0), () => {
      const port = (server.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Helpers for scripted brains. */
export const lastMessage = (body: any) => body.messages[body.messages.length - 1];
export const toolResults = (body: any): { tool_use_id: string; content: any; is_error?: boolean }[] => {
  const m = lastMessage(body);
  if (m.role !== "user" || !Array.isArray(m.content)) return [];
  return m.content.filter((c: any) => c.type === "tool_result").map((c: any) => ({ ...c, content: JSON.parse(c.content) }));
};
export const lastUserText = (body: any): string => {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
};
