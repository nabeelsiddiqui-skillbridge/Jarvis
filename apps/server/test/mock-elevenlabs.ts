import express from "express";
import type { AddressInfo } from "node:net";

/** ElevenLabs stand-in: voice list and streaming text-to-speech. */
export async function startMockElevenLabs(key: string, port = 0) {
  const calls = { speak: [] as { voice: string; model: string; text: string; format: string; settings?: Record<string, number> }[], voices: 0 };
  const app = express();
  app.use(express.json());
  app.get("/api.elevenlabs.io/v1/voices", (req, res) => {
    calls.voices++;
    if (req.get("xi-api-key") !== key) return res.status(401).json({ detail: { status: "invalid_api_key" } });
    res.json({ voices: [
      { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "premade", labels: { accent: "american", gender: "female", description: "calm" } },
      { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", category: "premade", labels: { accent: "american", gender: "male" } },
    ] });
  });
  app.post("/api.elevenlabs.io/v1/text-to-speech/:voice/stream", (req, res) => {
    if (req.get("xi-api-key") !== key) return res.status(401).end();
    calls.speak.push({ voice: String(req.params.voice), model: req.body.model_id, text: req.body.text, format: String(req.query.output_format), settings: req.body.voice_settings });
    res.setHeader("Content-Type", "audio/mpeg");
    res.end(Buffer.from("ID3-fake-mp3"));
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}
