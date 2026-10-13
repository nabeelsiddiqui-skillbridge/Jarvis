import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup } from "./helpers.js";
import { startMockAnthropic, toolResults, type MockAnthropicState } from "./mock-anthropic.js";

const DG_KEY = "dg-secret-key-123";
let app: any;
let llm: { url: string; state: MockAnthropicState; close: () => Promise<void> };
let dg: { url: string; close: () => Promise<void>; calls: { grant: number; speak: any[] }; failGrant: boolean };

async function startMockDeepgram() {
  const calls = { grant: 0, speak: [] as any[] };
  const state = { calls, failGrant: false } as any;
  const a = express();
  a.use(express.json());
  a.post("/api.deepgram.com/v1/auth/grant", (req, res) => {
    if (req.get("authorization") !== `Token ${DG_KEY}`) return res.status(401).json({ err_code: "INVALID_AUTH" });
    if (state.failGrant) return res.status(403).json({ err_code: "FORBIDDEN" });
    calls.grant++;
    res.json({ access_token: `jwt.${calls.grant}`, expires_in: 30 });
  });
  a.post("/api.deepgram.com/v1/speak", (req, res) => {
    if (req.get("authorization") !== `Token ${DG_KEY}`) return res.status(401).end();
    calls.speak.push({ query: req.query, body: req.body });
    res.setHeader("Content-Type", "audio/mpeg");
    res.end(Buffer.from("ID3-fake-mp3-bytes"));
  });
  return new Promise<typeof dg>((resolve) => {
    const s: Server = a.listen(0, () => resolve(Object.assign(state, { url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => new Promise<void>((r) => s.close(() => r())) })));
  });
}

beforeAll(async () => {
  llm = await startMockAnthropic((body) => {
    if (toolResults(body).length) return { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Net sales were about 224 thousand dollars. Want the breakdown on screen?" }] };
  });
  dg = await startMockDeepgram();
  Object.assign(process.env, { ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_BASE_URL: llm.url, DEEPGRAM_BASE_URL_OVERRIDE: dg.url });
  await resetDatabase();
  app = await makeApp();
});
afterAll(async () => { await llm?.close(); await dg?.close(); });

const sse = (res: any, cb: any) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c: string) => (d += c)); res.on("end", () => cb(null, d)); };

describe("voice", () => {
  let owner: any, businessId: string;

  it("falls back to the browser's speech when no voice provider is configured", async () => {
    owner = await signup(app, "Owner");
    const ws = await owner.post("/api/workspaces", { name: "WS" });
    businessId = (await owner.post(`/api/workspaces/${ws.body.id}/businesses`, { name: "Acme", industry: "ecommerce", timezone: "UTC", currency: "USD" })).body.id;
    const r = await owner.post(`/api/businesses/${businessId}/voice/session`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stt: { provider: "browser" }, tts: { provider: "browser" } });
    expect(r.body.note).toMatch(/browser/);
    expect((await owner.post(`/api/businesses/${businessId}/voice/speak`, { text: "Hello" })).status).toBe(412);
  });

  it("mints a short-lived token for the browser and never exposes the API key", async () => {
    const { config } = await import("../src/config.js");
    config.voice.deepgramKey = DG_KEY;
    const r = await owner.post(`/api/businesses/${businessId}/voice/session`, {});
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.stt).toMatchObject({ provider: "deepgram", token: "jwt.1", expiresIn: 30, authScheme: "bearer" });
    expect(r.body.stt.url).toMatch(/^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
    expect(r.body.stt.url).toContain("model=nova-3");
    expect(r.body.stt.url).toContain("interim_results=true");
    expect(r.body.tts.provider).toBe("server");
    expect(JSON.stringify(r.body)).not.toContain(DG_KEY);
    // Provider failure → a clear prerequisite, no key in the message.
    dg.failGrant = true;
    const bad = await owner.post(`/api/businesses/${businessId}/voice/session`, {});
    expect(bad.status).toBe(412);
    expect(JSON.stringify(bad.body)).not.toContain(DG_KEY);
    dg.failGrant = false;
  });

  it("proxies text-to-speech so the browser needs no credential", async () => {
    const r = await owner.agent.post(`/api/businesses/${businessId}/voice/speak`).set("X-BCA-Client", "web").send({ text: "Net sales were about 224 thousand dollars." }).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(r.body.toString()).toBe("ID3-fake-mp3-bytes");
    expect(dg.calls.speak.at(-1)).toMatchObject({ query: { model: "aura-2-thalia-en", encoding: "mp3" }, body: { text: "Net sales were about 224 thousand dollars." } });
    expect((await owner.post(`/api/businesses/${businessId}/voice/speak`, { text: "x".repeat(2000) })).status).toBe(400);
  });

  it("keeps voice private to the business", async () => {
    const other = await signup(app, "Other");
    expect((await other.post(`/api/businesses/${businessId}/voice/session`, {})).status).toBe(404);
    expect((await other.post(`/api/businesses/${businessId}/voice/speak`, { text: "hi" })).status).toBe(404);
    expect(dg.calls.grant).toBe(1);
  });

  it("asks for a short spoken reply on voice turns, and replays history validly", async () => {
    const conv = (await owner.post(`/api/businesses/${businessId}/assistant/conversations`, {})).body.id;
    const ask = (text: string, voice: boolean) => owner.agent.post(`/api/businesses/${businessId}/assistant/conversations/${conv}/messages`).set("X-BCA-Client", "web").send({ text, voice }).buffer(true).parse(sse);
    await ask("How were sales?", true);
    const first = llm.state.requests.at(-1)!.body;
    expect(first.messages.at(-1)).toMatchObject({ role: "system" });
    expect(first.messages.at(-1).content).toMatch(/read aloud/);
    await ask("And orders?", false);
    const second = llm.state.requests.at(-1)!.body;
    expect(second.messages.map((m: any) => m.role)).toEqual(["user", "system", "assistant", "user"]);
    expect(second.messages.slice(0, 3)).toEqual([...first.messages, second.messages[2]]);
  });
});
