import { ProviderError, providerFetch, providerUrl } from "../http.js";
import type { CallbackResult, Credentials } from "../types.js";

/**
 * Google OAuth 2.0 (web server flow) shared by GA4, Search Console and Google Ads.
 * Each connector requests only its own read scope; offline access gives a refresh
 * token. Access tokens last ~1 hour.
 */
export const G = (url: string) => providerUrl(url, "GOOGLE_BASE_URL_OVERRIDE");

export function googleAuthorizeUrl(scopes: string[], state: string, redirectUri: string) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent", // guarantees a refresh token on re-authorization
    include_granted_scopes: "false",
    state,
  });
  return `${G("https://accounts.google.com/o/oauth2/v2/auth")}?${q}`;
}

export async function googleExchangeCode(code: string, redirectUri: string) {
  const { data } = await providerFetch(G("https://oauth2.googleapis.com/token"), {
    provider: "Google",
    method: "POST",
    form: { code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, grant_type: "authorization_code" },
    retries: 0,
  });
  if (!data.refresh_token) throw new ProviderError("permanent", "Google didn't return offline access. Remove the app from your Google account's third-party access and try again.");
  return data as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}

export async function googleCallback(query: Record<string, string>, redirectUri: string, requiredScopes: string[]): Promise<{ creds: Credentials; scopes: string[]; expiresAt: Date }> {
  if (!query.code) throw new ProviderError("permanent", "Google didn't return an authorization code.");
  const t = await googleExchangeCode(query.code, redirectUri);
  const scopes = t.scope.split(" ").filter(Boolean);
  const missing = requiredScopes.filter((s) => !scopes.includes(s));
  if (missing.length) throw new ProviderError("scope", "Some requested permissions weren't granted. Please approve all requested access to continue.");
  return { creds: { access_token: t.access_token, refresh_token: t.refresh_token }, scopes, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
}

export function googleNeedsRefresh(_creds: Credentials, expiresAt: Date | null) {
  return !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60_000;
}

export async function googleRefresh(creds: Credentials) {
  try {
    const { data } = await providerFetch(G("https://oauth2.googleapis.com/token"), {
      provider: "Google",
      method: "POST",
      form: { client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, refresh_token: creds.refresh_token, grant_type: "refresh_token" },
      idempotent: true, // Google refresh tokens are reusable
    });
    return { credentials: { ...creds, access_token: data.access_token, refresh_token: data.refresh_token ?? creds.refresh_token }, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
  } catch (e) {
    // invalid_grant = revoked or expired authorization.
    if (e instanceof ProviderError && e.status === 400) throw new ProviderError("auth", "Google access was revoked or expired. Reconnect the account.", 400, undefined, e.detail);
    throw e;
  }
}

export async function googleRevoke(creds: Credentials) {
  await providerFetch(G("https://oauth2.googleapis.com/revoke"), { provider: "Google", method: "POST", form: { token: creds.refresh_token ?? creds.access_token }, retries: 0 });
}

export const bearer = (creds: Credentials) => ({ Authorization: `Bearer ${creds.access_token}` });

export type { CallbackResult };
