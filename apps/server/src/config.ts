/**
 * Central configuration. Secrets are read here and nowhere else; `configStatus()`
 * reports *whether* each is set (for the admin console) without exposing values.
 */

const env = (key: string) => process.env[key]?.trim() || undefined;

export const config = {
  env: env("NODE_ENV") ?? "development",
  isProd: env("NODE_ENV") === "production",
  port: Number(env("PORT") ?? 8787),
  appUrl: env("APP_URL") ?? "http://localhost:5173",
  /** Public origin of the API (OAuth redirect URIs and webhook URLs are built from it). */
  apiUrl: env("API_URL") ?? `http://localhost:${env("PORT") ?? 8787}`,
  databaseUrl: env("DATABASE_URL") ?? "postgres://postgres@localhost:5432/bca",
  /** Encrypts provider tokens at rest (AES-256-GCM). Required in production. */
  encryptionKey: env("ENCRYPTION_KEY"),
  trustProxy: env("TRUST_PROXY"),
  allowSignup: env("ALLOW_SIGNUP") !== "false",
  /** Comma-separated emails that become platform administrators on sign-up / boot. */
  platformAdmins: (env("PLATFORM_ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  anthropic: {
    // Read on each use: platform administrators can set provider keys at runtime (Admin → Credentials).
    get apiKey() { return env("ANTHROPIC_API_KEY"); },
    model: env("ASSISTANT_MODEL") ?? "claude-opus-5-5",
    effort: (env("ASSISTANT_EFFORT") ?? "medium") as "low" | "medium" | "high",
  },
  voice: {
    /** Deepgram: streaming speech-to-text (browser connects with a short-lived token) and text-to-speech (proxied). */
    get deepgramKey() { return env("DEEPGRAM_API_KEY"); },
    /** ElevenLabs text-to-speech (optional): natural voices users can choose from. Takes precedence over Deepgram for speech output. */
    get elevenlabsKey() { return env("ELEVENLABS_API_KEY"); },
    get elevenlabsModel() { return env("ELEVENLABS_MODEL") ?? "eleven_flash_v2_5"; },
    /** Default voice when a user hasn't picked one (ElevenLabs voice id). */
    get elevenlabsVoice() { return env("ELEVENLABS_DEFAULT_VOICE_ID") ?? "21m00Tcm4TlvDq8ikWAM"; },
    sttModel: env("VOICE_STT_MODEL") ?? "nova-3",
    ttsModel: env("VOICE_TTS_MODEL") ?? "aura-2-thalia-en",
    language: env("VOICE_LANGUAGE") ?? "en",
    /** WebSocket subprotocol scheme the browser uses to present the temporary token. */
    wsAuthScheme: env("VOICE_WS_AUTH_SCHEME") ?? "bearer",
  },
};

export type SecretStatus = { key: string; label: string; configured: boolean; requiredFor: string };

/** Which secrets/config are present. Values are never returned. */
export function configStatus(): SecretStatus[] {
  const items: [string, string, string][] = [
    ["DATABASE_URL", "PostgreSQL connection", "Everything"],
    ["ENCRYPTION_KEY", "Token encryption key", "Storing provider credentials (required in production)"],
    ["ANTHROPIC_API_KEY", "Anthropic API key", "AI assistant, voice, AI dashboard generation, insight explanations"],
    ["DEEPGRAM_API_KEY", "Deepgram API key", "Streaming voice (speech-to-text and text-to-speech); without it the browser's built-in speech is used where available"],
    ["ELEVENLABS_API_KEY", "ElevenLabs API key", "Natural, selectable voices for spoken answers"],
    ["SHOPIFY_API_KEY", "Shopify app client ID", "Shopify connector"],
    ["SHOPIFY_API_SECRET", "Shopify app client secret", "Shopify connector + webhook verification"],
    ["GOOGLE_CLIENT_ID", "Google OAuth client ID", "GA4, Search Console, Google Ads"],
    ["GOOGLE_CLIENT_SECRET", "Google OAuth client secret", "GA4, Search Console, Google Ads"],
    ["GOOGLE_ADS_DEVELOPER_TOKEN", "Google Ads developer token", "Google Ads connector"],
    ["HUBSPOT_CLIENT_ID", "HubSpot app client ID", "HubSpot connector"],
    ["HUBSPOT_CLIENT_SECRET", "HubSpot app client secret", "HubSpot connector + webhook verification"],
    ["STRIPE_SECRET_KEY", "Stripe secret key", "Billing"],
    ["STRIPE_WEBHOOK_SECRET", "Stripe webhook signing secret", "Billing webhooks"],
    ["STRIPE_PRICE_STARTER", "Stripe price for Starter", "Selling the Starter plan"],
    ["STRIPE_PRICE_GROWTH", "Stripe price for Growth", "Selling the Growth plan"],
    ["STRIPE_PRICE_AGENCY", "Stripe price for Agency", "Selling the Agency plan"],
    ["PLATFORM_ADMIN_EMAILS", "Platform administrator emails", "Access to the platform admin console"],
    ["SMTP_URL", "SMTP server", "Email delivery of briefings, reports and invitations"],
  ];
  return items.map(([key, label, requiredFor]) => ({ key, label, requiredFor, configured: Boolean(env(key)) }));
}

export function assertProductionConfig() {
  if (!config.isProd) return;
  const missing = ["DATABASE_URL", "ENCRYPTION_KEY", "APP_URL", "API_URL"].filter((k) => !env(k));
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
}
