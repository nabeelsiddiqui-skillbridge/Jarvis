import { createHash } from "node:crypto";
import { ProviderError, providerFetch } from "../http.js";
import { businessTimezone, overridable } from "../kit.js";
import type { ConnectorDefinition, Credentials, SyncContext } from "../types.js";
import { bearer, googleAuthorizeUrl, googleCallback, googleNeedsRefresh, googleRefresh, googleRevoke } from "../google/oauth.js";
import { ownedMetrics, rewriteFromRows, storeTable } from "./csv.js";
import { MAX_ROWS, TableError, parseCsvTable, parseTable, type Cell, type ParsedTable } from "./parse.js";

/**
 * Google Sheets, two ways (both started from the front end):
 *  - Published CSV link (token connect, no app credentials): File → Share → Publish to web →
 *    CSV gives a public docs.google.com/spreadsheets/d/e/…/pub?output=csv URL we fetch as text.
 *  - OAuth with the platform Google app (spreadsheets.readonly): the Sheets API values endpoint
 *    with UNFORMATTED_VALUE + SERIAL_NUMBER, so numbers and dates arrive unformatted.
 * The sheet uses the shared "wide" table format (sheets/parse.ts): a date column and one
 * column per metric. Sheets are small, so every sync re-reads the whole sheet (capped at
 * 50,000 rows) and replaces the connection's facts; rows removed from the sheet disappear.
 */

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const G = overridable("GOOGLE_BASE_URL_OVERRIDE");
const SHEETS = (path: string) => G(`https://sheets.googleapis.com/v4/${path}`);
const PROVIDER = "Google Sheets";

// ------------------------------------------------------------------ published CSV link

/** Validate a "Publish to web" CSV link; returns the canonical URL (always output=csv). */
export function publishedUrl(raw: string): { url: string; id: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ProviderError("permanent", "Paste the full published link (it starts with https://docs.google.com/spreadsheets/d/e/).");
  }
  const m = /^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]{20,})\/pub(?:html)?$/.exec(u.pathname);
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com" || !m) {
    if (u.hostname === "docs.google.com" && /^\/spreadsheets\/d\/[A-Za-z0-9_-]+/.test(u.pathname)) {
      throw new ProviderError("permanent", "That's the sheet's editing link. Use File → Share → Publish to web, choose the tab and \"Comma-separated values (.csv)\", and paste the link it shows.");
    }
    throw new ProviderError("permanent", "That isn't a published Google Sheets link (https://docs.google.com/spreadsheets/d/e/…/pub?output=csv).");
  }
  const q = new URLSearchParams();
  if (u.searchParams.get("gid") && /^\d+$/.test(u.searchParams.get("gid")!)) {
    q.set("gid", u.searchParams.get("gid")!);
    q.set("single", "true");
  }
  q.set("output", "csv");
  return { url: `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?${q}`, id: `${m[1]}${q.get("gid") ? `#${q.get("gid")}` : ""}` };
}

async function fetchPublished(url: string): Promise<string> {
  let res: { data: unknown; headers: Headers };
  try {
    res = await providerFetch(G(url), { provider: PROVIDER, headers: { Accept: "text/csv, text/plain;q=0.9" }, timeoutMs: 60_000 });
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "scope" || e.kind === "auth")) {
      throw new ProviderError("permanent", "Google Sheets couldn't serve that link. Check it's still published to the web (File → Share → Publish to web).", e.status, undefined, e.detail);
    }
    throw e;
  }
  const type = res.headers.get("content-type") ?? "";
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
  if (/text\/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) {
    throw new ProviderError("permanent", "That link returned a web page instead of CSV. Publish the sheet as \"Comma-separated values (.csv)\" and paste that link.");
  }
  if (text.length > 20 * 1024 * 1024) throw new ProviderError("permanent", "The published sheet is too large (over 20 MB).");
  return text;
}

// ------------------------------------------------------------------ Sheets API (OAuth)

/** Spreadsheet id from an editing URL (or a bare id). */
export function spreadsheetId(raw: string): string {
  const s = (raw ?? "").trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m && !s.includes("/spreadsheets/d/e/")) return m[1]!;
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  throw new Error("Enter the spreadsheet's link (https://docs.google.com/spreadsheets/d/…/edit).");
}

async function spreadsheetInfo(creds: Credentials, id: string) {
  const { data } = await providerFetch(SHEETS(`spreadsheets/${encodeURIComponent(id)}?fields=properties.title,sheets.properties.title`), { provider: PROVIDER, headers: bearer(creds) });
  return { title: String(data?.properties?.title ?? "Spreadsheet"), tabs: ((data?.sheets ?? []) as any[]).map((s) => String(s.properties?.title ?? "")).filter(Boolean) };
}

const quoteTab = (t: string) => `'${t.replace(/'/g, "''")}'`;

async function fetchValues(creds: Credentials, id: string, tab: string): Promise<Cell[][]> {
  const range = encodeURIComponent(quoteTab(tab));
  const { data } = await providerFetch(SHEETS(`spreadsheets/${encodeURIComponent(id)}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS`), { provider: PROVIDER, headers: bearer(creds), timeoutMs: 60_000 });
  return (data?.values ?? []) as Cell[][];
}

// ------------------------------------------------------------------ sync

async function businessCurrency(ctx: SyncContext) {
  const { rows } = await ctx.db.query(`SELECT currency FROM businesses WHERE id = $1`, [ctx.connection.business_id]);
  return (rows[0]?.currency as string | undefined) ?? "USD";
}

function asProviderError(e: unknown): never {
  if (e instanceof TableError) throw new ProviderError("permanent", `The sheet couldn't be imported: ${e.problems.join(" ")}`);
  throw e;
}

async function syncSheet(ctx: SyncContext) {
  const creds = await ctx.credentials();
  const opts = { provider: "google_sheets" as const, defaultCurrency: await businessCurrency(ctx), maxRows: MAX_ROWS };
  let table: ParsedTable;
  try {
    if (creds.mode === "published") table = parseCsvTable(await fetchPublished(creds.url), opts);
    else table = parseTable(await fetchValues(creds, creds.spreadsheetId, String(ctx.asset.metadata?.tab ?? creds.tab)), opts);
  } catch (e) {
    asProviderError(e);
  }
  if (!ctx.asset.timezone) {
    const tz = await businessTimezone(ctx);
    await ctx.db.query(`UPDATE connection_assets SET timezone = $2 WHERE id = $1`, [ctx.asset.id, tz]);
  }
  await storeTable(ctx, table);
  await ctx.db.query(`UPDATE connection_assets SET metadata = metadata || $2::jsonb WHERE id = $1`, [ctx.asset.id, JSON.stringify({ metrics: table.metrics, ignoredColumns: table.ignoredColumns })]);
  for (const w of table.warnings) ctx.log(w);
  return rewriteFromRows(ctx, "google_sheets", table.warnings);
}

// ------------------------------------------------------------------ definition

export const googleSheets: ConnectorDefinition = {
  id: "google_sheets",
  name: "Google Sheets",
  category: "Data import",
  description: "Sync daily figures you maintain in a spreadsheet: a date column and one column per metric (sales, ad spend, books, email…).",
  implemented: true,
  configKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  accessRequirements: [
    "For sign-in with Google: the platform Google OAuth client (Admin → Credentials) with redirect URI <API_URL>/api/oauth/google_sheets/callback and the Google Sheets API enabled. Published CSV links work without it.",
  ],
  scopes: [{ scope: SCOPE, reason: "Read the values of the spreadsheet you choose (read-only)" }],
  metrics: ownedMetrics("google_sheets"),
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "Re-read every few hours; published links can lag edits by about 5 minutes",
  staleAfterHours: 30,
  syncIntervalMinutes: 180,
  reconcileDays: 0,
  docsUrl: "https://support.google.com/docs/answer/183965",
  connectFields: [
    { key: "spreadsheetUrl", label: "Spreadsheet link", placeholder: "https://docs.google.com/spreadsheets/d/…/edit", help: "The sheet's normal link from the address bar." },
    { key: "tab", label: "Tab name (optional)", placeholder: "Sheet1", help: "Leave empty to use the first tab." },
  ],
  tokenConnect: {
    fields: [{ key: "url", label: "Published CSV link", placeholder: "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv", help: "File → Share → Publish to web → choose the tab → Comma-separated values (.csv)." }],
    instructions: [
      "Lay the sheet out with a header row: a \"date\" column (YYYY-MM-DD) and one column per metric, named by metric (e.g. store_net_sales, ad_spend, acct_revenue). Download the CSV template on the CSV upload card for every supported column.",
      "In Google Sheets choose File → Share → Publish to web.",
      "Under Link, pick the tab with your figures and \"Comma-separated values (.csv)\", then click Publish.",
      "Copy the link it shows (https://docs.google.com/spreadsheets/d/e/…/pub?…output=csv) and paste it here. Anyone with the link can read the published tab; use \"Sign in with Google\" instead to keep the sheet private.",
    ],
    async connect(input) {
      const { url, id } = publishedUrl(input.url ?? "");
      const text = await fetchPublished(url);
      try {
        parseCsvTable(text, { provider: "google_sheets", defaultCurrency: "USD" }); // validate the layout before connecting
      } catch (e) {
        asProviderError(e);
      }
      const extId = `pub:${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
      return { credentials: { mode: "published", url }, scopes: [], externalAccountId: extId, displayName: "Published Google Sheet", tokenExpiresAt: null, settings: { authMode: "token" } };
    },
  },
  authorizeUrl({ state, redirectUri, input }) {
    spreadsheetId(input.spreadsheetUrl ?? ""); // validated before sending the user to Google
    return googleAuthorizeUrl([SCOPE], state, redirectUri);
  },
  async handleCallback({ query, redirectUri, input }) {
    const id = spreadsheetId(input.spreadsheetUrl ?? "");
    const { creds, scopes, expiresAt } = await googleCallback(query, redirectUri, [SCOPE]);
    let info: Awaited<ReturnType<typeof spreadsheetInfo>>;
    try {
      info = await spreadsheetInfo(creds, id);
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "scope")) throw new ProviderError("permanent", "That spreadsheet wasn't found, or this Google account can't open it.");
      throw e;
    }
    const wanted = (input.tab ?? "").trim();
    const tab = wanted ? info.tabs.find((t) => t.toLowerCase() === wanted.toLowerCase()) : info.tabs[0];
    if (!tab) throw new ProviderError("permanent", wanted ? `The spreadsheet has no tab named "${wanted}".` : "The spreadsheet has no tabs.");
    return { credentials: { ...creds, mode: "oauth", spreadsheetId: id, tab }, scopes, externalAccountId: `${id}:${tab}`, displayName: `${info.title} · ${tab}`, tokenExpiresAt: expiresAt };
  },
  needsRefresh: (c, expiresAt) => c.mode !== "published" && googleNeedsRefresh(c, expiresAt),
  refreshCredentials: googleRefresh,
  async discoverAssets(creds) {
    if (creds.mode === "published") {
      return [{ providerAssetId: publishedUrl(creds.url).id, name: "Published Google Sheet", kind: "sheet", currency: null, timezone: null, metadata: {} }];
    }
    const info = await spreadsheetInfo(creds, creds.spreadsheetId);
    return [{ providerAssetId: `${creds.spreadsheetId}:${creds.tab}`, name: `${info.title} · ${creds.tab}`, kind: "sheet", currency: null, timezone: null, metadata: { tab: creds.tab } }];
  },
  sync: syncSheet,
  async healthCheck(ctx) {
    const creds = await ctx.credentials();
    if (creds.mode === "published") await fetchPublished(creds.url);
    else await spreadsheetInfo(creds, creds.spreadsheetId);
  },
  async revoke(creds) {
    if (creds.mode === "published") return; // the owner unpublishes the sheet in Google
    await googleRevoke(creds);
  },
};
