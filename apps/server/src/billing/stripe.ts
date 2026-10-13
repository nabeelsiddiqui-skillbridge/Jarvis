import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaidPlanId, PlanId } from "@bca/shared";
import { PAID_PLANS } from "@bca/shared";
import { providerFetch, providerUrl } from "../connectors/http.js";

/**
 * Minimal Stripe REST client (form-encoded requests, secret key server-side only)
 * and webhook signature verification per Stripe's documented scheme:
 * Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>.
 */

const env = (k: string) => process.env[k]?.trim() || undefined;
export const stripeConfigured = () => Boolean(env("STRIPE_SECRET_KEY"));
export const webhookConfigured = () => Boolean(env("STRIPE_WEBHOOK_SECRET"));

/** Stripe Price id configured for each paid plan (STRIPE_PRICE_STARTER, …). */
export function priceFor(plan: PaidPlanId): string | undefined {
  return env(`STRIPE_PRICE_${plan.toUpperCase()}`);
}

export function planForPrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  return PAID_PLANS.find((p) => priceFor(p) === priceId) ?? null;
}

export const purchasablePlans = (): PaidPlanId[] => (stripeConfigured() ? PAID_PLANS.filter((p) => priceFor(p)) : []);

const url = (path: string) => providerUrl(`https://api.stripe.com/v1/${path}`, "STRIPE_BASE_URL_OVERRIDE");

export async function stripe<T = any>(method: "GET" | "POST", path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe is not configured");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const { data } = await providerFetch<T>(url(path), {
    provider: "Stripe",
    method,
    headers,
    form,
    retries: 2,
    // Stripe honours Idempotency-Key, so POSTs carrying one are safe to retry.
    idempotent: method === "GET" || Boolean(idempotencyKey),
    timeoutMs: 20_000,
  });
  return data;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: any };
}

/** Returns the parsed event when the signature is valid and fresh, otherwise null. */
export function verifyStripeWebhook(raw: Buffer, header: string | undefined, toleranceSec = 300, now = Date.now()): StripeEvent | null {
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret || !header || !Buffer.isBuffer(raw)) return null;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !/^\d+$/.test(t) || !sigs.length) return null;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return null;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
  const ok = sigs.some((s) => {
    if (!/^[0-9a-f]+$/i.test(s)) return false;
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) return null;
  try {
    const ev = JSON.parse(raw.toString("utf8"));
    return ev && typeof ev.id === "string" && typeof ev.type === "string" ? ev : null;
  } catch {
    return null;
  }
}

/** Test/helper: produce a Stripe-Signature header for a payload. */
export function signStripePayload(payload: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

/** Period end lives on the subscription (older API versions) or on its items (newer ones). */
export function subscriptionPeriodEnd(sub: any): Date | null {
  const s = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return typeof s === "number" ? new Date(s * 1000) : null;
}
