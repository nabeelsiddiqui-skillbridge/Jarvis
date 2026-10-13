// Deepgram stand-in for local browser walkthroughs: token grant, streaming listen
// WebSocket (scripted transcripts once audio arrives) and text-to-speech (silent WAV).
import express from "express";
import { WebSocketServer } from "ws";

const KEY = process.env.DEEPGRAM_API_KEY;
const port = Number(process.env.MOCK_DEEPGRAM_PORT ?? 8895);
const issued = new Set<string>();
const script = (process.env.MOCK_DEEPGRAM_UTTERANCES ?? "How did sales do in the last 30 days?|Which channels brought the most sessions this month?").split("|");

const app = express();
app.use(express.json());
app.post("/api.deepgram.com/v1/auth/grant", (req, res) => {
  if (req.get("authorization") !== `Token ${KEY}`) return res.status(401).json({ err_code: "INVALID_AUTH" });
  const t = `jwt-${Math.random().toString(36).slice(2)}`;
  issued.add(t);
  setTimeout(() => issued.delete(t), 30_000);
  res.json({ access_token: t, expires_in: 30 });
});
app.post("/api.deepgram.com/v1/speak", (req, res) => {
  if (req.get("authorization") !== `Token ${KEY}`) return res.status(401).end();
  // ~0.6 s of silence per sentence, 16 kHz mono 16-bit PCM WAV.
  const samples = Math.round(16000 * Math.min(4, 0.25 + String(req.body?.text ?? "").length / 60));
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples * 2, 40);
  res.setHeader("Content-Type", "audio/wav");
  res.end(buf);
});
const server = app.listen(port, () => console.log(`[mock-deepgram] http://127.0.0.1:${port}  ws://127.0.0.1:${port}/v1/listen`));

const wss = new WebSocketServer({
  server,
  path: "/v1/listen",
  handleProtocols: (protocols) => (protocols.has("bearer") ? "bearer" : false),
});
let turn = 0;
wss.on("connection", (ws, req) => {
  const protos = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
  if (protos[0] !== "bearer" || !issued.has(protos[1] ?? "")) { ws.close(4001, "unauthorized"); return; }
  issued.delete(protos[1]!); // single use
  let bytes = 0;
  let speaking = false;
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(String(data));
      if (msg.type === "CloseStream") ws.close(1000);
      return;
    }
    bytes += (data as Buffer).length;
    // After ~1.5 s of audio, "hear" the next scripted question (interim words, then final).
    if (!speaking && bytes > 6000 && turn < script.length) {
      speaking = true;
      const text = script[turn++]!;
      const words = text.split(" ");
      const send = (t: string, final: boolean) => ws.send(JSON.stringify({ type: "Results", is_final: final, speech_final: final, channel: { alternatives: [{ transcript: t, confidence: 0.98 }] } }));
      words.forEach((_, i) => setTimeout(() => send(words.slice(0, i + 1).join(" "), false), 120 * (i + 1)));
      setTimeout(() => { send(text, true); ws.send(JSON.stringify({ type: "UtteranceEnd" })); }, 120 * (words.length + 2));
      setTimeout(() => { speaking = false; bytes = -30_000; }, 120 * (words.length + 3)); // wait before "hearing" the next one
    }
  });
});
