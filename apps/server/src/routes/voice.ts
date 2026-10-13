import { Router, type Request } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { requireUser } from "../auth/sessions.js";
import { inBusiness } from "../auth/access.js";
import { prerequisite } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { ProviderError, providerFetch, providerUrl } from "../connectors/http.js";
import { assertWithinLimit } from "../billing/entitlements.js";
import { assertEnabled } from "../lib/flags.js";
import { recordUsage } from "../lib/usage.js";

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
const XI = (path: string) => providerUrl(`https://api.elevenlabs.io/${path}`, "ELEVENLABS_BASE_URL_OVERRIDE");
const serverSpeech = () => Boolean(config.voice.elevenlabsKey || config.voice.deepgramKey);
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;

export interface VoiceOption { id: string; name: string; description: string | null; category: string | null; accent: string | null; gender: string | null }

// The account's voices, cached briefly (the list rarely changes and lookups cost latency).
let voiceCache: { key: string; at: number; voices: VoiceOption[] } | null = null;
async function elevenVoices(): Promise<VoiceOption[]> {
  const key = config.voice.elevenlabsKey!;
  if (voiceCache && voiceCache.key === key && Date.now() - voiceCache.at < 10 * 60_000) return voiceCache.voices;
  const { data } = await providerFetch<{ voices: any[] }>(XI("v1/voices"), { provider: "ElevenLabs", headers: { "xi-api-key": key }, retries: 1 });
  const voices = (data.voices ?? []).map((v): VoiceOption => ({
    id: String(v.voice_id), name: String(v.name ?? v.voice_id),
    description: v.labels?.description ?? v.description ?? null, category: v.category ?? null,
    accent: v.labels?.accent ?? null, gender: v.labels?.gender ?? null,
  })).filter((v) => VOICE_ID.test(v.id));
  voiceCache = { key, at: Date.now(), voices };
  return voices;
}

async function userVoice(userId: string): Promise<string | null> {
  return (await pool.query(`SELECT tts_voice FROM user_preferences WHERE user_id = $1`, [userId])).rows[0]?.tts_voice ?? null;
}

/** Voices the signed-in user can choose for spoken answers. */
voiceRouter.get("/voice/voices", async (req, res) => {
  const selected = await userVoice(req.user!.id);
  if (!config.voice.elevenlabsKey) {
    return res.json({ provider: config.voice.deepgramKey ? "deepgram" : "browser", voices: [], selected: null, defaultVoice: null, note: "Voice selection needs ElevenLabs (a platform administrator adds the API key in Admin → Credentials)." });
  }
  try {
    res.json({ provider: "elevenlabs", voices: await elevenVoices(), selected, defaultVoice: config.voice.elevenlabsVoice, note: null });
  } catch (e) {
    if (e instanceof ProviderError) console.warn("[voice] voice list failed", e.kind, e.status);
    throw prerequisite(e instanceof ProviderError && e.kind === "auth" ? "ElevenLabs rejected the platform's API key." : "Couldn't load voices from ElevenLabs right now.");
  }
});

voiceRouter.put("/voice/preference", async (req, res) => {
  const body = z.object({ voiceId: z.string().regex(VOICE_ID).nullable() }).parse(req.body);
  if (body.voiceId && config.voice.elevenlabsKey) {
    const ok = (await elevenVoices().catch(() => [])).some((v) => v.id === body.voiceId);
    if (!ok) throw prerequisite("That voice isn't available on the platform's ElevenLabs account.");
  }
  await pool.query(`INSERT INTO user_preferences (user_id, tts_voice) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET tts_voice = excluded.tts_voice, updated_at = now()`, [req.user!.id, body.voiceId]);
  res.json({ ok: true });
});
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
    const business = await inBusiness(req, req.params.businessId, "assistant.use", async ({ business }) => business);
    if (!config.anthropic.apiKey) throw prerequisite("Voice needs the AI assistant, which isn't configured on this platform yet (ANTHROPIC_API_KEY).");
    await assertEnabled("assistant", business.workspace_id);
    await assertEnabled("voice", business.workspace_id);
    await assertWithinLimit(business.workspace_id, "voiceSessions");
    const meter = () => recordUsage({ workspaceId: business.workspace_id, businessId: business.id, userId: req.user!.id, kind: "voice_session", meta: { stt: config.voice.deepgramKey ? "deepgram" : "browser" } });
    if (!config.voice.deepgramKey) {
      await meter();
      return res.json({
        stt: { provider: "browser" },
        tts: { provider: config.voice.elevenlabsKey ? "server" : "browser" },
        language: config.voice.language,
        note: config.voice.elevenlabsKey
          ? "Using your browser's speech recognition (in some browsers, e.g. Chrome, audio is processed by the browser vendor) and your chosen ElevenLabs voice for answers."
          : "Using your browser's built-in speech recognition and voices. In some browsers (e.g. Chrome) audio is processed by the browser vendor's speech service.",
      });
    }
    let grant: { access_token: string; expires_in: number };
    try {
      grant = (await providerFetch(DG("v1/auth/grant"), { provider: "Deepgram", method: "POST", headers: { Authorization: `Token ${config.voice.deepgramKey}` }, json: {}, retries: 1, idempotent: true })).data;
    } catch (e) {
      if (e instanceof ProviderError) console.warn("[voice] token grant failed", e.kind, e.status, e.detail?.slice(0, 200));
      throw prerequisite("The voice service couldn't start a session right now. Try again, or use text.");
    }
    await meter();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      stt: { provider: "deepgram", url: listenUrl(), token: grant.access_token, expiresIn: grant.expires_in, authScheme: config.voice.wsAuthScheme },
      tts: { provider: "server" },
      language: config.voice.language,
      note: config.voice.elevenlabsKey ? "Voice audio is transcribed by Deepgram and answers are spoken by ElevenLabs; neither is stored by Business Command AI." : "Voice audio is transcribed by Deepgram and isn't stored by Business Command AI.",
    });
  },
);

const speakBody = z.object({ text: z.string().trim().min(1).max(1500), voiceId: z.string().regex(VOICE_ID).optional() });

voiceRouter.post(
  "/businesses/:businessId/voice/speak",
  rateLimit({ name: "voice-speak", max: 240, windowMs: 60_000, key: perUser }),
  async (req, res) => {
    const body = speakBody.parse(req.body);
    const business = await inBusiness(req, req.params.businessId, "assistant.use", async ({ business }) => business);
    await assertEnabled("voice", business.workspace_id);
    if (!serverSpeech()) throw prerequisite("Server-side speech isn't configured (ELEVENLABS_API_KEY or DEEPGRAM_API_KEY); the browser's built-in voice is used instead.");
    let upstream: Response | null;
    let provider: "elevenlabs" | "deepgram";
    if (config.voice.elevenlabsKey) {
      // ElevenLabs: the voice the user picked (or one being previewed), else the platform default.
      provider = "elevenlabs";
      const voice = body.voiceId ?? (await userVoice(req.user!.id)) ?? config.voice.elevenlabsVoice;
      const q = new URLSearchParams({ output_format: "mp3_44100_128" });
      upstream = await fetch(`${XI(`v1/text-to-speech/${encodeURIComponent(voice)}/stream`)}?${q}`, {
        method: "POST",
        headers: { "xi-api-key": config.voice.elevenlabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: body.text, model_id: config.voice.elevenlabsModel }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
    } else {
      provider = "deepgram";
      const q = new URLSearchParams({ model: config.voice.ttsModel, encoding: "mp3" });
      upstream = await fetch(`${DG("v1/speak")}?${q}`, {
        method: "POST",
        headers: { Authorization: `Token ${config.voice.deepgramKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: body.text }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
    }
    if (!upstream?.ok || !upstream.body) {
      console.warn("[voice] speak failed", provider, upstream?.status);
      return res.status(502).json({ error: { code: "voice_unavailable", message: "The voice service didn't respond. The answer is still shown as text." } });
    }
    await recordUsage({ workspaceId: business.workspace_id, businessId: business.id, userId: req.user!.id, kind: "tts_characters", quantity: body.text.length, meta: { provider } });
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    const stream = Readable.fromWeb(upstream.body as any);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  },
);
