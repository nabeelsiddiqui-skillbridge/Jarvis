import { addDays } from "@bca/shared";
import { ProviderError, providerFetch } from "../http.js";
import { Tally, businessTimezone, finishRecordSync, overridable, recomputeDays, recordWindow, required, storeRecords, writeSnapshot, type StoredRecord } from "../kit.js";
import { datesBetween, localDate, type FactInput } from "../normalize.js";
import type { ConnectorDefinition, Credentials, SyncContext, SyncResult } from "../types.js";

/**
 * Stripe (payments and subscriptions).
 *
 * Auth: a restricted key (rk_live_/rk_test_, read-only) or a secret key (sk_…) sent as a
 * Bearer token, with a pinned Stripe-Version. Keys don't expire; nothing to refresh or revoke.
 *
 * Data model (records stored per object, aggregated per day in the account's dashboard timezone):
 *  - balance transactions (GET /v1/balance_transactions): type charge|payment → pay_gross_volume
 *    (amount) and pay_charges; refund|payment_refund → pay_refunds (|amount|); pay_fees = Σ `fee`
 *    on every transaction plus Stripe's separate fee transactions (stripe_fee, tax_fee). Amounts are
 *    converted from minor units using the currency's exponent (JPY etc. have none). Only
 *    transactions in the account's default currency count toward money metrics.
 *  - customers (GET /v1/customers) → pay_new_customers by creation day
 *  - subscriptions (GET /v1/subscriptions?status=all) → sub_new by creation day, sub_canceled by
 *    ended day; snapshot for today: sub_active (active|past_due) and sub_mrr (Σ item unit price ×
 *    quantity normalized to a month, minus active subscription-level coupons; trials excluded;
 *    metered/tiered prices can't be valued and are skipped with a note).
 *
 * Sync: initial import of 365 days. Balance transactions and customers are append-only, so
 * later syncs continue from a `created` cursor (1-hour overlap; refunds of older charges are new
 * balance transactions and are picked up this way). Subscriptions change status over time, so
 * they're re-listed in full on every sync (instead of consuming /v1/events, which only keeps 30 days).
 */

const S = overridable("STRIPE_DATA_BASE_URL_OVERRIDE");
const API = "https://api.stripe.com/v1";
const PROVIDER = "Stripe";
export const STRIPE_DATA_API_VERSION = "2024-06-20";
const INITIAL_DAYS = 365;
const RECONCILE_DAYS = 7;
const OVERLAP_S = 3600;
const LIMIT = 100;

const PAY = ["pay_gross_volume", "pay_refunds", "pay_fees", "pay_charges"];
const CUSTOMERS = ["pay_new_customers"];
const SUBS_FLOW = ["sub_new", "sub_canceled"];
const SUBS_SNAPSHOT = ["sub_active", "sub_mrr"];
const MONEY = new Set(["pay_gross_volume", "pay_refunds", "pay_fees", "sub_mrr"]);

/** Currencies Stripe expresses without minor units, and with three (https://docs.stripe.com/currencies). */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
export const fromMinor = (amount: number, currency: string) => {
  const c = currency.toLowerCase();
  return amount / (ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100);
};

// ------------------------------------------------------------------ HTTP

const headers = (creds: Credentials) => ({ Authorization: `Bearer ${creds.apiKey}`, "Stripe-Version": STRIPE_DATA_API_VERSION });

async function get<T = any>(creds: Credentials, path: string, params: [string, string | number][] = []) {
  const q = new URLSearchParams(params.map(([k, v]) => [k, String(v)]));
  const { data } = await providerFetch<T>(S(`${API}/${path}${q.size ? `?${q}` : ""}`), { provider: PROVIDER, headers: headers(creds) });
  return data;
}

/** Walk a list endpoint with starting_after pagination. */
async function list(creds: Credentials, path: string, params: [string, string | number][], onPage: (items: any[]) => Promise<void> | void) {
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const data: any = await get(creds, path, [...params, ["limit", LIMIT], ...(after ? [["starting_after", after] as [string, string]] : [])]);
    const items: any[] = data?.data ?? [];
    total += items.length;
    if (items.length) await onPage(items);
    if (!data?.has_more || !items.length) break;
    after = items[items.length - 1].id;
  }
  return total;
}

/** Account name, default currency and dashboard timezone. Restricted keys without account access fall back to the balance. */
async function accountInfo(creds: Credentials) {
  try {
    const a: any = await get(creds, "account");
    return {
      id: String(a.id),
      name: String(a.settings?.dashboard?.display_name || a.business_profile?.name || a.email || a.id),
      currency: a.default_currency ? String(a.default_currency).toUpperCase() : null,
      timezone: validTz(a.settings?.dashboard?.timezone),
    };
  } catch (e) {
    if (!(e instanceof ProviderError) || e.kind !== "scope") throw e;
    const b: any = await get(creds, "balance");
    const cur = b?.available?.[0]?.currency ?? b?.pending?.[0]?.currency;
    return { id: `key_${String(creds.apiKey).slice(-6)}`, name: "Stripe account", currency: cur ? String(cur).toUpperCase() : null, timezone: null };
  }
}

function validTz(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ records

interface TxnRec { day: string; type: string; amount: number; fee: number; currency: string }
interface CustomerRec { day: string }
interface SubRec { created: string; ended: string | null; status: string; currency: string; mrr: number | null; unvalued: boolean }

const GROSS_TYPES = new Set(["charge", "payment"]);
const REFUND_TYPES = new Set(["refund", "payment_refund"]);
const FEE_TYPES = new Set(["stripe_fee", "tax_fee"]);

/** Monthly value of a subscription in major units, or null when a price can't be valued (metered/tiered). */
export function subscriptionMrr(sub: any, now = Date.now() / 1000): { mrr: number; unvalued: boolean } {
  let monthlyMinor = 0;
  let unvalued = false;
  let perInvoiceToMonth = 1;
  for (const item of sub.items?.data ?? []) {
    const price = item.price ?? item.plan ?? {};
    const rec = price.recurring ?? (price.interval ? { interval: price.interval, interval_count: price.interval_count, usage_type: price.usage_type } : null);
    const unit = price.unit_amount ?? (price.unit_amount_decimal != null ? Number(price.unit_amount_decimal) : price.amount);
    if (!rec || rec.usage_type === "metered" || unit == null || !Number.isFinite(Number(unit))) {
      unvalued = true;
      continue;
    }
    const count = Math.max(1, Number(rec.interval_count ?? 1));
    const factor = ({ month: 1, year: 1 / 12, week: 52 / 12, day: 365 / 12 } as Record<string, number>)[rec.interval] ?? 1;
    perInvoiceToMonth = factor / count;
    monthlyMinor += Number(unit) * Number(item.quantity ?? 1) * (factor / count);
  }
  // Subscription-level discounts (expanded `discounts`, or the legacy single `discount`).
  const discounts: any[] = (Array.isArray(sub.discounts) ? sub.discounts.filter((d: any) => d && typeof d === "object") : []);
  if (!discounts.length && sub.discount) discounts.push(sub.discount);
  for (const d of discounts) {
    if (d.end && d.end < now) continue;
    const coupon = d.coupon ?? d.source?.coupon;
    if (!coupon || typeof coupon !== "object") continue;
    if (coupon.percent_off) monthlyMinor *= 1 - Number(coupon.percent_off) / 100;
    else if (coupon.amount_off && String(coupon.currency ?? "").toLowerCase() === String(sub.currency ?? "").toLowerCase()) {
      monthlyMinor -= Number(coupon.amount_off) * perInvoiceToMonth; // amount off each invoice
    }
  }
  return { mrr: fromMinor(Math.max(0, monthlyMinor), String(sub.currency ?? "usd")), unvalued };
}

function normTxn(t: any, tz: string): StoredRecord<TxnRec> {
  const cur = String(t.currency ?? "").toLowerCase();
  const day = localDate(new Date(t.created * 1000).toISOString(), tz);
  return {
    type: "txn", id: String(t.id), date: day, occurredAt: new Date(t.created * 1000).toISOString(),
    payload: { day, type: String(t.type), amount: fromMinor(Number(t.amount ?? 0), cur), fee: fromMinor(Number(t.fee ?? 0), cur), currency: cur.toUpperCase() },
  };
}

function normSub(s: any, tz: string): StoredRecord<SubRec> {
  const day = (u: number | null | undefined) => (u ? localDate(new Date(u * 1000).toISOString(), tz) : null);
  const ended = s.ended_at ?? (s.status === "canceled" || s.status === "incomplete_expired" ? s.canceled_at : null);
  const { mrr, unvalued } = subscriptionMrr(s);
  const created = day(s.created)!;
  return {
    type: "sub", id: String(s.id), date: created, occurredAt: new Date(s.created * 1000).toISOString(),
    payload: { created, ended: day(ended), status: String(s.status), currency: String(s.currency ?? "").toUpperCase(), mrr: Math.round(mrr * 100) / 100, unvalued },
  };
}

// ------------------------------------------------------------------ aggregation

function computeDay(owned: string[], currency: string | null, notes: Set<string>) {
  return (date: string, records: any[]): FactInput[] => {
    const t = new Tally(owned);
    const has = (m: string) => owned.includes(m);
    for (const r of records) {
      if (r._type === "txn" && has("pay_charges")) {
        const x = r as TxnRec;
        if (currency && x.currency !== currency) {
          notes.add(`Some balance transactions are in ${x.currency}, not the account's default currency ${currency}; they're left out of payment totals.`);
          continue;
        }
        if (GROSS_TYPES.has(x.type)) t.add("pay_gross_volume", x.amount).add("pay_charges");
        else if (REFUND_TYPES.has(x.type)) t.add("pay_refunds", Math.abs(x.amount));
        if (FEE_TYPES.has(x.type)) t.add("pay_fees", -x.amount);
        t.add("pay_fees", x.fee);
      } else if (r._type === "customer" && has("pay_new_customers")) {
        t.add("pay_new_customers");
      } else if (r._type === "sub" && has("sub_new")) {
        const x = r as SubRec;
        if (x.created === date && x.status !== "incomplete" && x.status !== "incomplete_expired") t.add("sub_new");
        if (x.ended === date && x.status === "canceled") t.add("sub_canceled");
      }
    }
    return t.facts(MONEY, currency);
  };
}

function subSnapshot(subs: SubRec[], currency: string | null, notes: Set<string>): FactInput[] {
  const t = new Tally(SUBS_SNAPSHOT);
  let skipped = 0;
  for (const s of subs) {
    if (s.status !== "active" && s.status !== "past_due") continue;
    t.add("sub_active");
    if (currency && s.currency !== currency) { skipped++; continue; }
    if (s.unvalued) notes.add("Some subscriptions use metered or tiered prices; those items aren't included in MRR.");
    t.add("sub_mrr", s.mrr ?? 0);
  }
  if (skipped) notes.add(`${skipped} active subscription${skipped > 1 ? "s are" : " is"} billed in another currency than ${currency} and ${skipped > 1 ? "aren't" : "isn't"} included in MRR.`);
  return t.facts(MONEY, currency);
}

// ------------------------------------------------------------------ sync

/** Unix seconds a little before local midnight of `date` (records before the window are filtered by day). */
const unixBefore = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) - 86400;

/** Run a fetch step; a restricted key without that permission skips the object with a note. */
async function optional(step: string, notes: Set<string>, fn: () => Promise<void>) {
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "scope") {
      notes.add(`The key can't read ${step}; grant it Read access to ${step} in Stripe to include those figures.`);
      return false;
    }
    throw e;
  }
}

async function syncAccount(ctx: SyncContext): Promise<SyncResult> {
  const creds = await ctx.credentials();
  const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
  const { today, initial, coveredFrom, cursor, allDays } = recordWindow(ctx, tz, INITIAL_DAYS);
  const currency = ctx.asset.currency ?? null;
  const reconcileFrom = addDays(today, -RECONCILE_DAYS + 1);
  const affected = new Set<string>();
  const notes = new Set<string>();
  const startedAt = Math.floor(Date.now() / 1000);
  let records = 0;
  const since = (key: string) => {
    if (initial || !cursor[key]) return unixBefore(coveredFrom);
    if (ctx.mode === "reconcile") return Math.min(cursor[key] - OVERLAP_S, unixBefore(reconcileFrom));
    return cursor[key] - OVERLAP_S;
  };
  const next: Record<string, number> = {};

  const payOk = await optional("balance transactions", notes, async () => {
    records += await list(creds, "balance_transactions", [["created[gte]", since("txnCreated")]], async (items) => {
      await storeRecords(ctx, items.map((t) => normTxn(t, tz)), ["day"], affected);
    });
    next.txnCreated = startedAt;
  });

  const custOk = await optional("customers", notes, async () => {
    records += await list(creds, "customers", [["created[gte]", since("customerCreated")]], async (items) => {
      await storeRecords(ctx, items.map((c): StoredRecord<CustomerRec> => {
        const day = localDate(new Date(c.created * 1000).toISOString(), tz);
        return { type: "customer", id: String(c.id), date: day, occurredAt: new Date(c.created * 1000).toISOString(), payload: { day } };
      }), ["day"], affected);
    });
    next.customerCreated = startedAt;
  });

  const subs: SubRec[] = [];
  const subsOk = await optional("subscriptions", notes, async () => {
    records += await list(creds, "subscriptions", [["status", "all"], ["expand[]", "data.discounts"]], async (items) => {
      const recs = items.map((s) => normSub(s, tz));
      subs.push(...recs.map((r) => r.payload));
      await storeRecords(ctx, recs, ["created", "ended"], affected);
    });
  });

  const owned = [...(payOk ? PAY : []), ...(custOk ? CUSTOMERS : []), ...(subsOk ? SUBS_FLOW : [])];
  const fillFrom = initial || !cursor.coveredTo ? coveredFrom : cursor.coveredTo < today ? cursor.coveredTo : today;
  const dates = initial ? allDays() : [...affected, ...datesBetween(fillFrom < coveredFrom ? coveredFrom : fillFrom, today)];
  if (ctx.mode === "reconcile") dates.push(...datesBetween(reconcileFrom, today));
  const recomputed = owned.length
    ? await recomputeDays(ctx, dates.filter((d) => d >= coveredFrom && d <= today), {
      recordTypes: [...(payOk ? ["txn"] : []), ...(custOk ? ["customer"] : []), ...(subsOk ? ["sub"] : [])],
      dateFields: ["day", "created", "ended"],
      owned,
      compute: computeDay(owned, currency, notes),
    })
    : 0;
  if (subsOk) await writeSnapshot(ctx, today, subSnapshot(subs, currency, notes), SUBS_SNAPSHOT);

  return finishRecordSync(ctx, { coveredFrom, today, records, recomputed, cursor: next, notes: [...notes] });
}

// ------------------------------------------------------------------ definition

const KEY_RE = /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/;

export const stripe: ConnectorDefinition = {
  id: "stripe",
  name: "Stripe",
  category: "Payments",
  description: "Collected payments, refunds, fees, new customers, subscriptions and MRR from Stripe.",
  implemented: true,
  configKeys: [],
  scopes: [
    { scope: "balance_transactions:read", reason: "Payments collected, refunds and fees" },
    { scope: "customers:read", reason: "New paying customers", optional: true },
    { scope: "subscriptions:read", reason: "New/canceled subscriptions, active subscriptions and MRR", optional: true },
  ],
  metrics: [...PAY, ...CUSTOMERS, ...SUBS_FLOW, ...SUBS_SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Payments appear at the next sync (every hour)",
  staleAfterHours: 6,
  syncIntervalMinutes: 60,
  reconcileDays: RECONCILE_DAYS,
  docsUrl: "https://docs.stripe.com/keys#create-restricted-api-secret-key",

  tokenConnect: {
    fields: [
      { key: "apiKey", label: "Restricted API key", placeholder: "rk_live_…", secret: true, help: "A read-only restricted key is recommended; a secret key (sk_…) also works." },
    ],
    instructions: [
      "In the Stripe Dashboard open Developers → API keys and click “Create restricted key”.",
      "Name it (e.g. Business Command AI) and set Read access for: Balance (balance transactions), Charges and Payment Intents, Customers, Subscriptions, Invoices, Coupons/Prices and Products. Leave everything else as None.",
      "Click “Create key” and copy the key (it starts with rk_live_). Use a test-mode key (rk_test_) to try it with test data.",
    ],
    async connect(input) {
      const { apiKey } = required(input, { apiKey: "API key" });
      if (/^pk_/.test(apiKey)) throw new ProviderError("permanent", "That's a publishable key. Use a restricted key (rk_…) or secret key (sk_…).");
      if (!KEY_RE.test(apiKey)) throw new ProviderError("permanent", "That doesn't look like a Stripe API key (it starts with rk_live_, rk_test_, sk_live_ or sk_test_).");
      const creds = { apiKey };
      const acct = await accountInfo(creds);
      return {
        credentials: creds,
        scopes: ["read"],
        externalAccountId: acct.id,
        displayName: acct.name,
        tokenExpiresAt: null,
        settings: { authMode: "token", livemode: apiKey.includes("_live_"), currency: acct.currency, timezone: acct.timezone },
      };
    },
  },

  async discoverAssets(creds) {
    const acct = await accountInfo(creds);
    return [{ providerAssetId: acct.id, name: acct.name, kind: "account", currency: acct.currency, timezone: acct.timezone, metadata: { livemode: String(creds.apiKey).includes("_live_") } }];
  },

  sync: syncAccount,

  async healthCheck(ctx) {
    await get(await ctx.credentials(), "balance");
  },
};
