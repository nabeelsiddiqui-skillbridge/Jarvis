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
import { EnvironmentManaged, setPlatformSecret, settingSource } from "../lib/platformSecrets.js";
import { audit } from "../lib/audit.js";
import { withSystem } from "../db/pool.js";
import { conflict, forbidden } from "../lib/errors.js";

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

/** ElevenLabs models users can pick (allow-listed; the platform default comes from ELEVENLABS_MODEL). */
export const TTS_MODELS = [
  { id: "eleven_flash_v2_5", label: "Flash v2.5", description: "Fastest replies (~75 ms), good quality — best for conversation" },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5", description: "Fast, slightly richer delivery" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2", description: "Most natural and expressive, a little slower" },
  { id: "eleven_v3", label: "Eleven v3", description: "Most expressive (newest), slowest" },
] as const;
const MODEL_IDS = TTS_MODELS.map((m) => m.id) as [string, ...string[]];

/** Voice tuning, as ElevenLabs voice_settings (ranges per ElevenLabs: speed 0.7–1.2, others 0–1). */
const ttsSettings = z.object({
  model: z.enum(MODEL_IDS).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
  stability: z.number().min(0).max(1).optional(),
  similarity: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
}).strict();
type TtsSettings = z.infer<typeof ttsSettings>;

async function userVoicePrefs(userId: string): Promise<{ voice: string | null; settings: TtsSettings }> {
  const r = (await pool.query(`SELECT tts_voice, tts_settings FROM user_preferences WHERE user_id = $1`, [userId])).rows[0];
  const parsed = ttsSettings.safeParse(r?.tts_settings ?? {});
  return { voice: r?.tts_voice ?? null, settings: parsed.success ? parsed.data : {} };
}

const platformModel = () => (MODEL_IDS.includes(config.voice.elevenlabsModel) ? config.voice.elevenlabsModel : "eleven_flash_v2_5");

/** Voices the signed-in user can choose for spoken answers, their tuning, and what platform admins may change. */
voiceRouter.get("/voice/voices", async (req, res) => {
  const { voice: selected, settings } = await userVoicePrefs(req.user!.id);
  const admin = {
    canManage: req.user!.isPlatformAdmin,
    keyFromEnvironment: settingSource("ELEVENLABS_API_KEY") === "environment",
    defaultFromEnvironment: settingSource("ELEVENLABS_DEFAULT_VOICE_ID") === "environment",
  };
  const common = { settings, models: TTS_MODELS, platformModel: platformModel(), admin };
  if (!config.voice.elevenlabsKey) {
    return res.json({ provider: config.voice.deepgramKey ? "deepgram" : "browser", voices: [], selected: null, defaultVoice: null, ...common,
      note: req.user!.isPlatformAdmin ? "Add your ElevenLabs API key below to choose from your ElevenLabs voices." : "Voice selection needs ElevenLabs — ask a platform administrator to add the API key (Settings → Voice or Admin → Credentials)." });
  }
  try {
    res.json({ provider: "elevenlabs", voices: await elevenVoices(), selected, defaultVoice: config.voice.elevenlabsVoice, ...common, note: null });
  } catch (e) {
    if (e instanceof ProviderError) console.warn("[voice] voice list failed", e.kind, e.status);
    throw prerequisite(e instanceof ProviderError && e.kind === "auth" ? "ElevenLabs rejected the platform's API key. A platform administrator can replace it in Settings → Voice." : "Couldn't load voices from ElevenLabs right now.");
  }
});

voiceRouter.put("/voice/preference", async (req, res) => {
  const body = z.object({ voiceId: z.string().regex(VOICE_ID).nullable().optional(), settings: ttsSettings.optional() }).parse(req.body);
  if (body.voiceId && config.voice.elevenlabsKey) {
    const ok = (await elevenVoices().catch(() => [])).some((v) => v.id === body.voiceId);
    if (!ok) throw prerequisite("That voice isn't available on the platform's ElevenLabs account.");
  }
  await pool.query(
    `INSERT INTO user_preferences (user_id, tts_voice, tts_settings) VALUES ($1, $2, coalesce($3::jsonb, '{}'::jsonb))
     ON CONFLICT (user_id) DO UPDATE SET
       tts_voice = CASE WHEN $4 THEN excluded.tts_voice ELSE user_preferences.tts_voice END,
       tts_settings = coalesce($3::jsonb, user_preferences.tts_settings), updated_at = now()`,
    [req.user!.id, body.voiceId ?? null, body.settings ? JSON.stringify(body.settings) : null, body.voiceId !== undefined],
  );
  res.json({ ok: true });
});

function requireAdmin(req: Request) {
  if (!req.user!.isPlatformAdmin) throw forbidden("Only platform administrators can change the platform's voice settings.");
}

async function setManaged(req: Request, key: string, value: string | null) {
  try {
    await setPlatformSecret(key, value, req.user!.id);
  } catch (e) {
    if (e instanceof EnvironmentManaged) throw conflict("This setting is defined in the hosting environment; change it there.");
    throw e;
  }
  await withSystem((db) => audit(db, { actorUserId: req.user!.id, actorType: "support", action: "admin.setting_changed", targetType: "setting", targetId: key, metadata: { change: value === null ? "cleared" : "set", via: "voice_settings" }, ip: req.ip }));
}

/** Platform admins: the ElevenLabs API key, checked with ElevenLabs before it's saved. */
voiceRouter.put("/voice/elevenlabs-key", async (req, res) => {
  requireAdmin(req);
  const { apiKey } = z.object({ apiKey: z.string().trim().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/, "That doesn't look like an ElevenLabs API key.") }).parse(req.body);
  try {
    await providerFetch(XI("v1/voices"), { provider: "ElevenLabs", headers: { "xi-api-key": apiKey }, retries: 1 });
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === "auth" || e.kind === "scope")) throw prerequisite("ElevenLabs rejected that key, or it lacks the Voices (read) permission. Create a key with Text to Speech and Voices access.");
    throw prerequisite("Couldn't reach ElevenLabs to check the key. Try again in a moment.");
  }
  await setManaged(req, "ELEVENLABS_API_KEY", apiKey);
  voiceCache = null;
  res.json({ ok: true });
});

/** Platform admins: the voice everyone hears unless they pick their own. */
voiceRouter.put("/voice/default", async (req, res) => {
  requireAdmin(req);
  const body = z.object({ voiceId: z.string().regex(VOICE_ID).nullable(), model: z.enum(MODEL_IDS).optional() }).parse(req.body);
  if (body.voiceId) {
    if (!config.voice.elevenlabsKey) throw prerequisite("Add the ElevenLabs API key first.");
    const ok = (await elevenVoices().catch(() => [])).some((v) => v.id === body.voiceId);
    if (!ok) throw prerequisite("That voice isn't available on the platform's ElevenLabs account.");
  }
  await setManaged(req, "ELEVENLABS_DEFAULT_VOICE_ID", body.voiceId);
  if (body.model) await setManaged(req, "ELEVENLABS_MODEL", body.model);
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

const speakBody = z.object({ text: z.string().trim().min(1).max(1500), voiceId: z.string().regex(VOICE_ID).optional(), settings: ttsSettings.optional() });

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
      const prefs = await userVoicePrefs(req.user!.id);
      const t = { ...prefs.settings, ...(body.settings ?? {}) };
      const voice = body.voiceId ?? prefs.voice ?? config.voice.elevenlabsVoice;
      const voiceSettings = Object.fromEntries(Object.entries({ speed: t.speed, stability: t.stability, similarity_boost: t.similarity, style: t.style }).filter(([, v]) => v !== undefined));
      const q = new URLSearchParams({ output_format: "mp3_44100_128" });
      upstream = await fetch(`${XI(`v1/text-to-speech/${encodeURIComponent(voice)}/stream`)}?${q}`, {
        method: "POST",
        headers: { "xi-api-key": config.voice.elevenlabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: body.text, model_id: t.model ?? platformModel(), ...(Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {}) }),
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
