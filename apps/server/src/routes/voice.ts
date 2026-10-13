import { Router, type Request } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { config } from "../config.js";
import { requireUser } from "../auth/sessions.js";
import { inBusiness } from "../auth/access.js";
import { prerequisite } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { ProviderError, providerFetch, providerUrl } from "../connectors/http.js";

/**
 * Voice. Speech-to-text streams directly from the browser to Deepgram using a
 * short-lived token minted here (≈30 s, only needed to open the socket; the API
 * key never leaves the server). Text-to-speech is proxied through this server so
 * no credential is needed in the browser at all. Without a Deepgram key the
 * client falls back to the browser's built-in speech services, labelled as such.
 */
export const voiceRouter = Router();
voiceRouter.use(requireUser);

const DG = (path: string) => providerUrl(`https://api.deepgram.com/${path}`, "DEEPGRAM_BASE_URL_OVERRIDE");
const perUser = (req: Request) => req.user?.id ?? req.ip ?? "anon";

export function listenUrl() {
  const q = new URLSearchParams({
    model: config.voice.sttModel,
    language: config.voice.language,
    smart_format: "true",
    interim_results: "true",
    endpointing: "400",
    utterance_end_ms: "1200",
    vad_events: "true",
  });
  const base = process.env.DEEPGRAM_WS_URL_OVERRIDE && !config.isProd ? process.env.DEEPGRAM_WS_URL_OVERRIDE : "wss://api.deepgram.com/v1/listen";
  return `${base}?${q}`;
}

voiceRouter.post(
  "/businesses/:businessId/voice/session",
  rateLimit({ name: "voice-session", max: 30, windowMs: 60_000, key: perUser }),
  async (req, res) => {
    await inBusiness(req, req.params.businessId, "assistant.use", async () => undefined);
    if (!config.anthropic.apiKey) throw prerequisite("Voice needs the AI assistant, which isn't configured on this platform yet (ANTHROPIC_API_KEY).");
    if (!config.voice.deepgramKey) {
      return res.json({
        stt: { provider: "browser" },
        tts: { provider: "browser" },
        language: config.voice.language,
        note: "Using your browser's built-in speech recognition and voices. In some browsers (e.g. Chrome) audio is processed by the browser vendor's speech service.",
      });
    }
    let grant: { access_token: string; expires_in: number };
    try {
      grant = (await providerFetch(DG("v1/auth/grant"), { provider: "Deepgram", method: "POST", headers: { Authorization: `Token ${config.voice.deepgramKey}` }, json: {}, retries: 1, idempotent: true })).data;
    } catch (e) {
      if (e instanceof ProviderError) console.warn("[voice] token grant failed", e.kind, e.status, e.detail?.slice(0, 200));
      throw prerequisite("The voice service couldn't start a session right now. Try again, or use text.");
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      stt: { provider: "deepgram", url: listenUrl(), token: grant.access_token, expiresIn: grant.expires_in, authScheme: config.voice.wsAuthScheme },
      tts: { provider: "server" },
      language: config.voice.language,
      note: "Voice audio is transcribed by Deepgram and isn't stored by Business Command AI.",
    });
  },
);

const speakBody = z.object({ text: z.string().trim().min(1).max(1500) });

voiceRouter.post(
  "/businesses/:businessId/voice/speak",
  rateLimit({ name: "voice-speak", max: 240, windowMs: 60_000, key: perUser }),
  async (req, res) => {
    const body = speakBody.parse(req.body);
    await inBusiness(req, req.params.businessId, "assistant.use", async () => undefined);
    if (!config.voice.deepgramKey) throw prerequisite("Server-side speech isn't configured (DEEPGRAM_API_KEY); the browser's built-in voice is used instead.");
    const q = new URLSearchParams({ model: config.voice.ttsModel, encoding: "mp3" });
    const upstream = await fetch(`${DG("v1/speak")}?${q}`, {
      method: "POST",
      headers: { Authorization: `Token ${config.voice.deepgramKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: body.text }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      console.warn("[voice] speak failed", upstream?.status);
      return res.status(502).json({ error: { code: "voice_unavailable", message: "The voice service didn't respond. The answer is still shown as text." } });
    }
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    const stream = Readable.fromWeb(upstream.body as any);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  },
);
