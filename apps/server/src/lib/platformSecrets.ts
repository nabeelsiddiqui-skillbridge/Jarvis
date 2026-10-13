import { pool } from "../db/pool.js";
import { decryptJson, encryptJson } from "./crypto.js";

/**
 * Provider credentials a platform administrator can set from the admin console instead of
 * the hosting environment. Values are encrypted at rest (ENCRYPTION_KEY), loaded into this
 * process's environment, refreshed periodically (so the API and worker agree), and never
 * returned to any client. A value set in the real environment always wins and can't be
 * changed from the console.
 */
export interface ManagedSetting { key: string; label: string; group: string; secret: boolean; help?: string }

export const MANAGED_SETTINGS: ManagedSetting[] = [
  { key: "SHOPIFY_API_KEY", label: "Client ID", group: "Shopify", secret: false, help: "Shopify Partner/Dev Dashboard → your app → Client credentials." },
  { key: "SHOPIFY_API_SECRET", label: "Client secret", group: "Shopify", secret: true },
  { key: "GOOGLE_CLIENT_ID", label: "OAuth client ID", group: "Google (GA4, Search Console, Ads)", secret: false, help: "Google Cloud → APIs & Services → Credentials → OAuth client (Web application)." },
  { key: "GOOGLE_CLIENT_SECRET", label: "OAuth client secret", group: "Google (GA4, Search Console, Ads)", secret: true },
  { key: "GOOGLE_ADS_DEVELOPER_TOKEN", label: "Google Ads developer token", group: "Google (GA4, Search Console, Ads)", secret: true, help: "Google Ads manager account → Tools → API Center." },
  { key: "HUBSPOT_CLIENT_ID", label: "Client ID", group: "HubSpot", secret: false, help: "HubSpot developer account → your app → Auth." },
  { key: "HUBSPOT_CLIENT_SECRET", label: "Client secret", group: "HubSpot", secret: true },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", group: "AI assistant", secret: true },
  { key: "DEEPGRAM_API_KEY", label: "Deepgram API key (speech recognition)", group: "Voice", secret: true },
  { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API key (voices)", group: "Voice", secret: true },
  { key: "ELEVENLABS_DEFAULT_VOICE_ID", label: "Default ElevenLabs voice ID", group: "Voice", secret: false },
  { key: "STRIPE_SECRET_KEY", label: "Secret key", group: "Billing (Stripe)", secret: true },
  { key: "STRIPE_WEBHOOK_SECRET", label: "Webhook signing secret", group: "Billing (Stripe)", secret: true },
  { key: "STRIPE_PRICE_STARTER", label: "Starter price ID", group: "Billing (Stripe)", secret: false },
  { key: "STRIPE_PRICE_GROWTH", label: "Growth price ID", group: "Billing (Stripe)", secret: false },
  { key: "STRIPE_PRICE_AGENCY", label: "Agency price ID", group: "Billing (Stripe)", secret: false },
  { key: "SMTP_URL", label: "SMTP URL", group: "Email", secret: true, help: "e.g. smtps://user:password@smtp.example.com:465" },
  { key: "EMAIL_FROM", label: "From address", group: "Email", secret: false },
];
const KEYS = new Set(MANAGED_SETTINGS.map((s) => s.key));
export const isManaged = (key: string) => KEYS.has(key);

// Captured before anything is loaded from the database: these come from the real environment.
const fromEnvironment = new Set(MANAGED_SETTINGS.map((s) => s.key).filter((k) => process.env[k]?.trim()));
const loaded = new Map<string, Date>();

export function settingSource(key: string): "environment" | "admin" | null {
  return fromEnvironment.has(key) ? "environment" : loaded.has(key) ? "admin" : null;
}
export const settingUpdatedAt = (key: string) => loaded.get(key) ?? null;

/** Load (or reload) administrator-set values into process.env. */
export async function loadPlatformSecrets() {
  const { rows } = await pool.query(`SELECT key, value_enc, updated_at FROM platform_secrets`);
  const seen = new Set<string>();
  for (const r of rows) {
    if (!KEYS.has(r.key) || fromEnvironment.has(r.key)) continue;
    try {
      process.env[r.key] = decryptJson<string>(r.value_enc);
      loaded.set(r.key, new Date(r.updated_at));
      seen.add(r.key);
    } catch {
      console.error(`[settings] couldn't decrypt ${r.key} (was ENCRYPTION_KEY changed?)`);
    }
  }
  for (const k of [...loaded.keys()]) if (!seen.has(k)) { loaded.delete(k); delete process.env[k]; }
}

let timer: NodeJS.Timeout | undefined;
/** Keep this process in step with changes made through another process (API ↔ worker). */
export function watchPlatformSecrets(ms = 30_000) {
  clearInterval(timer);
  timer = setInterval(() => loadPlatformSecrets().catch((e) => console.error("[settings] reload failed", e.message)), ms);
  timer.unref();
}

export class EnvironmentManaged extends Error {}

/** Set (value) or clear (null) an administrator-managed setting. */
export async function setPlatformSecret(key: string, value: string | null, userId: string) {
  if (!KEYS.has(key)) throw new Error(`Unknown setting ${key}`);
  if (fromEnvironment.has(key)) throw new EnvironmentManaged(key);
  if (value === null) await pool.query(`DELETE FROM platform_secrets WHERE key = $1`, [key]);
  else {
    await pool.query(
      `INSERT INTO platform_secrets (key, value_enc, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value_enc = excluded.value_enc, updated_by = excluded.updated_by, updated_at = now()`,
      [key, encryptJson(value), userId],
    );
  }
  await loadPlatformSecrets();
}
