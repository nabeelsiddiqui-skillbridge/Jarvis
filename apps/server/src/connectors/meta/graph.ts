import { createHmac } from "node:crypto";
import { overridable } from "../kit.js";
import { ProviderError, providerFetch } from "../http.js";
import type { CallbackResult, Credentials } from "../types.js";

/**
 * Meta Graph API helpers shared by Meta Ads, Facebook Pages and Instagram.
 *
 * Auth: either a token the user pastes (a Business Manager system-user token or a
 * long-lived user token, `mode: "token"`) or "Sign in with Facebook" through the
 * platform's Meta app (`mode: "oauth"`): the short-lived code token is exchanged for a
 * long-lived user token (~60 days). Meta has no refresh tokens for user tokens, so an
 * expired token surfaces as an auth error and the user reconnects.
 *
 * Tokens are sent in the Authorization header (never in URLs we build). OAuth
 * connections also send appsecret_proof, which Meta requires when the app enables
 * "Require app secret"; pasted tokens may come from another app, so they don't.
 *
 * Graph errors arrive as HTTP 400/401/403/500 with `{error: {code, error_subcode, type}}`;
 * they're mapped to the platform's error kinds by `code`.
 */
export const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION ?? "v23.0";
export const M = overridable("META_BASE_URL_OVERRIDE");
const GRAPH_HOST = "graph.facebook.com";

/** Graph error codes → error kinds (https://developers.facebook.com/docs/graph-api/guides/error-handling). */
const AUTH_CODES = new Set([102, 190, 463, 467]);
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const TRANSIENT_CODES = new Set([1, 2]);
/** 10 and 200–299 are permission errors. */
const isPermissionCode = (c: number) => c === 10 || (c >= 200 && c <= 299);

export class GraphError extends ProviderError {
  constructor(kind: ProviderError["kind"], message: string, public code: number | null, status?: number, retryAfterMs?: number, detail?: string) {
    super(kind, message, status, retryAfterMs, detail);
  }
}

function graphCode(detail: string | undefined): number | null {
  if (!detail) return null;
  try {
    const c = JSON.parse(detail)?.error?.code;
    if (Number.isFinite(Number(c))) return Number(c);
  } catch {
    // body may be truncated; fall back to a pattern match
  }
  const m = /"code"\s*:\s*(\d+)/.exec(detail);
  return m ? Number(m[1]) : null;
}

/** Re-classify a failed Graph request by its error code. */
export function mapGraphError(e: unknown, provider = "Meta"): never {
  if (!(e instanceof ProviderError)) throw e;
  const code = graphCode(e.detail);
  if (code != null) {
    if (AUTH_CODES.has(code)) throw new GraphError("auth", `${provider} rejected the access token (it expired, was revoked, or the user's password changed). Reconnect the account.`, code, e.status, undefined, e.detail);
    if (isPermissionCode(code)) throw new GraphError("scope", `${provider} denied a permission this connection needs. Reconnect and grant all requested permissions.`, code, e.status, undefined, e.detail);
    if (RATE_CODES.has(code)) throw new GraphError("rate_limit", `${provider} rate limit reached; the sync will retry.`, code, e.status, 5 * 60_000, e.detail);
    if (TRANSIENT_CODES.has(code)) throw new GraphError("transient", `${provider} is temporarily unavailable.`, code, e.status, undefined, e.detail);
    if (code === 100) throw new GraphError("permanent", `${provider} rejected a request parameter.`, code, e.status, undefined, e.detail);
    if (code === 803) throw new GraphError("not_found", `${provider} object not found or not accessible.`, code, e.status, undefined, e.detail);
  }
  throw new GraphError(e.kind, e.message, code, e.status, e.retryAfterMs, e.detail);
}

/** appsecret_proof for tokens issued through the platform's own Meta app. */
function proof(creds: Credentials, token: string): Record<string, string> {
  const secret = process.env.META_APP_SECRET;
  if (creds.mode !== "oauth" || !secret) return {};
  return { appsecret_proof: createHmac("sha256", secret).update(token).digest("hex") };
}

export const graphUrl = (path: string, params: Record<string, string> = {}) => {
  const q = new URLSearchParams(params).toString();
  return `https://${GRAPH_HOST}/${GRAPH_VERSION()}/${path.replace(/^\//, "")}${q ? `?${q}` : ""}`;
};

/**
 * GET a Graph path (or a `paging.next` URL). `token` defaults to the user token; Page
 * insights pass the Page's own token.
 */
export async function graphGet<T = any>(creds: Credentials, pathOrUrl: string, params: Record<string, string> = {}, opts: { token?: string; provider?: string } = {}): Promise<T> {
  const token = opts.token ?? creds.access_token;
  let url: URL;
  if (/^https:\/\//.test(pathOrUrl)) {
    url = new URL(pathOrUrl);
    // Only ever follow paging links back to the Graph API.
    if (url.host !== GRAPH_HOST) throw new ProviderError("permanent", "Unexpected paging link from Meta.");
    url.searchParams.delete("access_token");
  } else {
    url = new URL(graphUrl(pathOrUrl, params));
  }
  for (const [k, v] of Object.entries(proof(creds, token))) url.searchParams.set(k, v);
  try {
    const { data } = await providerFetch<T>(M(url.toString()), { provider: opts.provider ?? "Meta", headers: { Authorization: `Bearer ${token}` }, timeoutMs: 120_000 });
    return data;
  } catch (e) {
    mapGraphError(e, opts.provider);
  }
}

/** All items of a paged edge, following `paging.next`. */
export async function graphAll<T = any>(creds: Credentials, path: string, params: Record<string, string>, opts: { token?: string; provider?: string; maxPages?: number } = {}): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  let first = true;
  for (let page = 0; next && page < (opts.maxPages ?? 500); page++) {
    const data: any = await graphGet(creds, next, first ? params : {}, opts);
    first = false;
    out.push(...((data?.data ?? []) as T[]));
    next = data?.paging?.next ?? null;
  }
  return out;
}

// ------------------------------------------------------------------ identity & permissions

export async function me(creds: Credentials, provider = "Meta") {
  return graphGet<{ id: string; name?: string }>(creds, "me", { fields: "id,name" }, { provider });
}

/** Granted permissions, or null when the token type doesn't expose them. */
export async function grantedPermissions(creds: Credentials, provider = "Meta"): Promise<string[] | null> {
  try {
    const data = await graphGet<{ data?: { permission: string; status: string }[] }>(creds, "me/permissions", {}, { provider });
    if (!Array.isArray(data?.data)) return null;
    return data.data.filter((p) => p.status === "granted").map((p) => p.permission);
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === "auth" || e.kind === "rate_limit" || e.kind === "transient")) throw e;
    return null;
  }
}

function assertPermissions(granted: string[] | null, required: string[], provider: string) {
  if (!granted) return;
  const missing = required.filter((p) => !granted.includes(p));
  if (missing.length) throw new ProviderError("scope", `This ${provider} token is missing the permission${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. Create a new token with ${required.join(", ")} and try again.`);
}

// ------------------------------------------------------------------ token connect

export const META_TOKEN_FIELD = {
  key: "accessToken",
  label: "Access token",
  placeholder: "EAA…",
  help: "A system-user token from Meta Business Settings, or a long-lived user token.",
  secret: true,
};

export const metaTokenInstructions = (permissions: string[], what: string) => [
  "Open Meta Business Settings (business.facebook.com/settings) → Users → System users, and add a system user (Admin or Employee).",
  `Click “Assign assets” and give the system user access to the ${what} you want to report on.`,
  `Click “Generate new token”, choose your Meta app, and tick ${permissions.join(", ")}. Choose “Never” as the expiry if offered.`,
  "Copy the token (it starts with EAA) and paste it here. A long-lived user token from the Graph API Explorer also works, but it expires after about 60 days.",
];

/** Validate a pasted Meta token: format, identity and permissions. */
export async function metaTokenCredentials(input: Record<string, string>, required: string[], provider: string) {
  const token = (input.accessToken ?? "").trim();
  if (!/^EA[A-Za-z0-9]{20,}$/.test(token)) throw new ProviderError("permanent", `That doesn't look like a Meta access token (it starts with EAA and is about 200 characters long).`);
  const creds: Credentials = { access_token: token, mode: "token" };
  const user = await me(creds, provider);
  assertPermissions(await grantedPermissions(creds, provider), required, provider);
  return { creds, user };
}

// ------------------------------------------------------------------ OAuth ("Sign in with Facebook")

export const META_OAUTH_KEYS = ["META_APP_ID", "META_APP_SECRET"];

export function metaAuthorizeUrl(scopes: string[], state: string, redirectUri: string) {
  const q = new URLSearchParams({ client_id: process.env.META_APP_ID!, redirect_uri: redirectUri, state, scope: scopes.join(","), response_type: "code" });
  // Business apps (Facebook Login for Business) ask for the permissions in a login configuration instead of `scope`.
  const configId = process.env.META_LOGIN_CONFIG_ID?.trim();
  if (configId) { q.delete("scope"); q.set("config_id", configId); }
  return `${M(`https://www.facebook.com/${GRAPH_VERSION()}/dialog/oauth`)}?${q}`;
}

async function oauthToken(params: Record<string, string>) {
  try {
    const { data } = await providerFetch(M(graphUrl("oauth/access_token", params)), { provider: "Meta", retries: 0 });
    return data as { access_token: string; token_type?: string; expires_in?: number };
  } catch (e) {
    if (e instanceof ProviderError && e.status === 400) throw new ProviderError("permanent", "Meta didn't accept the sign-in. Please try connecting again.", 400, undefined, e.detail);
    mapGraphError(e);
  }
}

/**
 * Code → short-lived token → long-lived token (~60 days). Returns the identity and the
 * expiry; there is no refresh token, so the user reconnects when it lapses.
 */
export async function metaCallback(query: Record<string, string>, redirectUri: string, required: string[], provider: string) {
  if (!query.code) throw new ProviderError("permanent", "Meta didn't return an authorization code.");
  const appId = process.env.META_APP_ID!;
  const secret = process.env.META_APP_SECRET!;
  const short = await oauthToken({ client_id: appId, client_secret: secret, redirect_uri: redirectUri, code: query.code });
  const long = await oauthToken({ grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: short.access_token });
  const creds: Credentials = { access_token: long.access_token, mode: "oauth" };
  const user = await me(creds, provider);
  const granted = await grantedPermissions(creds, provider);
  const missing = required.filter((p) => granted && !granted.includes(p));
  if (missing.length) throw new ProviderError("scope", "Some requested permissions weren't granted. Please approve all requested access to continue.");
  // Long-lived user tokens last ~60 days; Meta usually reports expires_in.
  const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : new Date(Date.now() + 60 * 86_400_000);
  return { creds, user, scopes: granted ?? required, expiresAt };
}

/** Build the CallbackResult shared by the three Meta connectors. */
export function metaResult(p: { creds: Credentials; user: { id: string; name?: string }; scopes: string[]; expiresAt: Date | null; displayName: string; token: boolean }): CallbackResult {
  return {
    credentials: p.creds,
    scopes: p.scopes,
    externalAccountId: `meta:${p.user.id}`,
    displayName: p.displayName,
    tokenExpiresAt: p.expiresAt,
    settings: p.token ? { authMode: "token" } : { authMode: "oauth" },
  };
}

// ------------------------------------------------------------------ Pages (shared by Pages and Instagram)

export interface MetaPage {
  id: string;
  name: string;
  access_token?: string;
  followers_count?: number;
  fan_count?: number;
  instagram_business_account?: { id: string; username?: string; followers_count?: number };
}

export async function listPages(creds: Credentials, fields: string, provider: string): Promise<MetaPage[]> {
  return graphAll<MetaPage>(creds, "me/accounts", { fields, limit: "100" }, { provider });
}

/**
 * A Page access token, fetched at sync time with the user/system-user token (Page
 * tokens are never stored in asset metadata, which users can see).
 */
export async function pageToken(creds: Credentials, pageId: string, provider: string): Promise<string> {
  const data = await graphGet<{ access_token?: string }>(creds, pageId, { fields: "access_token" }, { provider });
  if (!data?.access_token) throw new ProviderError("scope", `${provider} didn't return an access token for this Page. Make sure the connected user or system user has a task on the Page.`);
  return data.access_token;
}

/** Insights are reported in Pacific time; `end_time` is the end of the reported day. */
export const META_INSIGHTS_TZ = "America/Los_Angeles";
export function insightsDay(endTime: string): string {
  // end_time is local midnight after the day (07:00 or 08:00 UTC); step back a few hours.
  const t = new Date(Date.parse(endTime) - 3 * 3600_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: META_INSIGHTS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

/** Unix seconds of local midnight (Pacific) starting day `date`, for insights since/until. */
export function insightsMidnight(date: string): number {
  for (const h of [7, 8]) {
    const t = Date.parse(`${date}T0${h}:00:00Z`);
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: META_INSIGHTS_TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(t));
    if (Number(hour) === 0) return t / 1000;
  }
  return Date.parse(`${date}T08:00:00Z`) / 1000;
}
