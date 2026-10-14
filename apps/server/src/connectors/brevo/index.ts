import { ProviderError, providerFetch } from "../http.js";
import { businessTimezone, overridable } from "../kit.js";
import { EMAIL_FLOW, EMAIL_SNAPSHOT, syncSentCampaigns, type CampaignStat } from "../mailchimp/index.js";
import type { ConnectorDefinition, Credentials } from "../types.js";

/**
 * Brevo (formerly Sendinblue) API v3, connected with an API key (`api-key` header, keys
 * start with xkeysib-). The account is the single asset.
 *
 * Data model: sent email campaigns (GET /emailCampaigns?status=sent&statistics=globalStats)
 * are stored as source records by their local send day (Brevo reports no account timezone, so
 * the business timezone is used), with the campaign name as dimension:
 *  - email_sends = delivered, email_opens = unique views, email_clicks = unique clicks,
 *    email_unsubscribes = unsubscriptions. Campaigns sent in the last 30 days (90 on
 *    reconciliation) are re-fetched each sync, since engagement keeps accruing; it is credited
 *    to the send day. Transactional and automation (workflow) emails are not included.
 *  - email_list_size = the contact count from GET /contacts (Brevo's documented total, which
 *    includes blocklisted contacts), a snapshot for the sync day.
 */
const B = overridable("BREVO_BASE_URL_OVERRIDE");
const KEY_FORMAT = /^xkeysib-[A-Za-z0-9-]{30,}$/;
const PAGE = 100; // max `limit` for /emailCampaigns

const get = async <T = any>(creds: Credentials, path: string) =>
  (await providerFetch<T>(B(`https://api.brevo.com/v3${path}`), { provider: "Brevo", headers: { "api-key": creds.api_key } })).data;

async function accountInfo(creds: Credentials) {
  return get<{ email?: string; companyName?: string; organization_id?: string; user_id?: number }>(creds, "/account");
}
/** Stable account id: the organization id where reported, else the account email. */
const accountId = (a: { email?: string; organization_id?: string }) => String(a.organization_id ?? a.email ?? "brevo");

async function campaignsSince(creds: Credentials, since: string): Promise<CampaignStat[]> {
  const out: CampaignStat[] = [];
  const endDate = new Date().toISOString();
  let total = Infinity;
  // Advance by what was returned (the server may return fewer than `limit`).
  for (let offset = 0; offset < total; ) {
    const q = new URLSearchParams({ type: "classic", status: "sent", statistics: "globalStats", limit: String(PAGE), offset: String(offset), startDate: new Date(since).toISOString(), endDate, sort: "asc" });
    const page = await get(creds, `/emailCampaigns?${q}`);
    total = page?.count ?? 0;
    const list: any[] = page?.campaigns ?? [];
    for (const c of list) {
      if (!c.sentDate) continue;
      const g = c.statistics?.globalStats ?? {};
      out.push({
        id: String(c.id),
        name: c.name || c.subject || `Campaign ${c.id}`,
        sentAt: c.sentDate,
        sends: Number(g.delivered ?? 0),
        opens: Number(g.uniqueViews ?? 0),
        clicks: Number(g.uniqueClicks ?? 0),
        unsubscribes: Number(g.unsubscriptions ?? 0),
      });
    }
    if (!list.length) break;
    offset += list.length;
  }
  return out;
}

export const brevo: ConnectorDefinition = {
  id: "brevo",
  name: "Brevo",
  category: "Email",
  description: "Email campaign deliveries, opens, clicks and unsubscribes, plus contact count.",
  implemented: true,
  configKeys: [],
  scopes: [{ scope: "api_key", reason: "Read email campaign statistics and the contact count (only reads are made)." }],
  metrics: [...EMAIL_FLOW, ...EMAIL_SNAPSHOT],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Campaign results appear at the next sync (every 6 hours); opens and clicks keep updating for 30 days after a send",
  staleAfterHours: 26,
  syncIntervalMinutes: 360,
  reconcileDays: 90,
  docsUrl: "https://developers.brevo.com/docs/getting-started",
  tokenConnect: {
    fields: [{ key: "apiKey", label: "API key", placeholder: "xkeysib-…", secret: true }],
    instructions: [
      "In Brevo click your account name (top right) → SMTP & API → API keys (or go to app.brevo.com/settings/keys/api).",
      "Click Generate a new API key, name it (e.g. \"Business Command AI\") and copy it — it starts with xkeysib- and is shown only once.",
      "If your account restricts API access by IP address, allow this platform's servers under Security → Authorised IPs, or deactivate the restriction for this key.",
    ],
    async connect(input) {
      const key = (input.apiKey ?? "").trim();
      if (!KEY_FORMAT.test(key)) throw new ProviderError("permanent", "That doesn't look like a Brevo API key (it starts with xkeysib-). SMTP keys (xsmtpsib-) won't work.");
      const creds = { api_key: key };
      const a = await accountInfo(creds);
      return { credentials: creds, scopes: ["api_key"], externalAccountId: accountId(a), displayName: a.companyName || a.email || "Brevo account", tokenExpiresAt: null, settings: { authMode: "token" } };
    },
  },
  async discoverAssets(creds) {
    const a = await accountInfo(creds);
    return [{ providerAssetId: accountId(a), name: a.companyName || a.email || "Brevo account", kind: "account", currency: null, timezone: null }];
  },
  async sync(ctx) {
    const creds = await ctx.credentials();
    const tz = ctx.asset.timezone ?? (await businessTimezone(ctx));
    return syncSentCampaigns(ctx, {
      tz, initialDays: 365, lookbackDays: 30, reconcileDays: 90,
      fetchSince: (since) => campaignsSince(creds, since),
      async listSize() {
        const r = await get(creds, "/contacts?limit=1&offset=0");
        return typeof r?.count === "number" ? r.count : null;
      },
      notes: ["Brevo's contact count includes blocklisted (unsubscribed) contacts."],
    });
  },
  async healthCheck(ctx) {
    await accountInfo(await ctx.credentials());
  },
};
