import { createSign } from "node:crypto";
import { ProviderError, providerFetch } from "../http.js";
import type { CallbackResult, ConnectorDefinition, Credentials } from "../types.js";
import { G, googleNeedsRefresh, googleRefresh as platformRefresh, googleRevoke } from "./oauth.js";

/**
 * Ways to reach Google APIs without the platform's own OAuth app, so Google sources can be
 * connected from the browser even before an administrator sets one up:
 *  - service account: the user creates a key in Google Cloud and grants that service account
 *    read access to their GA4 property / Search Console property / spreadsheet. Tokens are
 *    minted from the key (signed JWT, RFC 7523), one hour at a time.
 *  - own OAuth client: the user's own Google Cloud OAuth client + a refresh token they
 *    generated for it (e.g. with the OAuth 2.0 Playground). Refreshed with their client.
 * Credentials carry `mode`; platform OAuth connections have no mode (or "oauth").
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface ServiceAccountKey { client_email: string; private_key: string; project_id?: string; token_uri?: string }

/** Validate a pasted service-account JSON key (never echo its contents in errors). */
export function parseServiceAccountKey(text: string): ServiceAccountKey {
  let k: any;
  try {
    k = JSON.parse(text.trim());
  } catch {
    throw new ProviderError("permanent", "That isn't a valid JSON key file. Paste the whole contents of the .json file you downloaded from Google Cloud.");
  }
  if (k?.type !== "service_account" || typeof k.client_email !== "string" || typeof k.private_key !== "string" || !k.private_key.includes("PRIVATE KEY")) {
    throw new ProviderError("permanent", "That JSON isn't a service-account key. In Google Cloud open IAM & Admin → Service accounts → your account → Keys → Add key → JSON.");
  }
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(k.client_email)) throw new ProviderError("permanent", "The key's client_email doesn't look like a service account.");
  return { client_email: k.client_email, private_key: k.private_key, project_id: k.project_id, token_uri: k.token_uri };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export async function serviceAccountToken(key: ServiceAccountKey, scopes: string[]) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: scopes.join(" "), aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  let signature: string;
  try {
    signature = b64url(createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key));
  } catch {
    throw new ProviderError("permanent", "The service-account key's private key couldn't be read. Download a new JSON key and paste it again.");
  }
  try {
    const { data } = await providerFetch(G(TOKEN_URL), {
      provider: "Google",
      method: "POST",
      form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` },
      idempotent: true,
    });
    return { access_token: data.access_token as string, expiresAt: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000) };
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) throw new ProviderError("auth", "Google rejected the service-account key (it may have been deleted or disabled). Create a new key and reconnect.", e.status, undefined, e.detail);
    throw e;
  }
}

export async function ownClientToken(c: { client_id: string; client_secret: string; refresh_token: string }) {
  try {
    const { data } = await providerFetch(G(TOKEN_URL), {
      provider: "Google",
      method: "POST",
      form: { client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token" },
      idempotent: true,
    });
    return { access_token: data.access_token as string, scopes: String(data.scope ?? "").split(" ").filter(Boolean), expiresAt: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000) };
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) throw new ProviderError("auth", "Google rejected the client ID, secret or refresh token. Check they belong together and that the refresh token wasn't revoked.", e.status, undefined, e.detail);
    throw e;
  }
}

/** Refresh any kind of Google credentials. */
export async function googleRefresh(creds: Credentials) {
  if (creds.mode === "service_account") {
    const t = await serviceAccountToken(creds.key, creds.scopes ?? []);
    return { credentials: { ...creds, access_token: t.access_token }, expiresAt: t.expiresAt };
  }
  if (creds.mode === "own_client") {
    const t = await ownClientToken(creds as any);
    return { credentials: { ...creds, access_token: t.access_token }, expiresAt: t.expiresAt };
  }
  return platformRefresh(creds);
}

export { googleNeedsRefresh };

/** Revoke only grants made through the platform's own app (keys and user-owned clients stay with their owner). */
export async function googleRevokeIfOwned(creds: Credentials) {
  if (creds.mode === "service_account" || creds.mode === "own_client" || creds.mode === "published") return;
  await googleRevoke(creds);
}

type Field = NonNullable<ConnectorDefinition["tokenConnect"]>["fields"][number];

export const SA_FIELD: Field = { key: "serviceAccountKey", label: "Service-account JSON key", placeholder: '{ "type": "service_account", … }', secret: true, multiline: true, help: "Paste the full contents of the .json key file. It's encrypted and never shown again." };
export const OWN_CLIENT_FIELDS: Field[] = [
  { key: "clientId", label: "OAuth client ID", placeholder: "…apps.googleusercontent.com" },
  { key: "clientSecret", label: "OAuth client secret", secret: true },
  { key: "refreshToken", label: "Refresh token", placeholder: "1//…", secret: true },
];

export const ownClientSteps = (scope: string, api: string) => [
  `In Google Cloud (console.cloud.google.com) pick or create a project and enable the ${api}.`,
  "APIs & Services → OAuth consent screen: set it up (External or Internal) and add yourself as a test user if it's in testing.",
  "APIs & Services → Credentials → Create credentials → OAuth client ID → Web application. Add https://developers.google.com/oauthplayground as an authorized redirect URI. Copy the client ID and secret.",
  "Open the OAuth 2.0 Playground (developers.google.com/oauthplayground), click the gear icon, tick “Use your own OAuth credentials” and paste the client ID and secret.",
  `In “Input your own scopes” enter ${scope}, click Authorize APIs and sign in with the Google account that has access.`,
  "Click “Exchange authorization code for tokens” and copy the Refresh token. Paste the client ID, secret and refresh token here.",
  "Note: while the consent screen is in Testing, Google expires refresh tokens after 7 days — publish it (In production) to keep the connection working.",
];

/** Verify credentials from either variant and return them with a fresh access token. */
export async function connectGoogleVariant(input: Record<string, string>, scopes: string[]): Promise<{ creds: Credentials; expiresAt: Date; identity: string; scopes: string[] }> {
  if ((input._method ?? "service_account") === "own_client") {
    const c = { client_id: (input.clientId ?? "").trim(), client_secret: (input.clientSecret ?? "").trim(), refresh_token: (input.refreshToken ?? "").trim() };
    if (!/\.apps\.googleusercontent\.com$/.test(c.client_id)) throw new ProviderError("permanent", "The client ID should end in .apps.googleusercontent.com.");
    if (!c.client_secret || !c.refresh_token) throw new ProviderError("permanent", "Enter the client secret and the refresh token.");
    const t = await ownClientToken(c);
    if (t.scopes.length && !scopes.every((s) => t.scopes.includes(s))) throw new ProviderError("scope", `The refresh token wasn't granted ${scopes.join(", ")}. Authorize that scope in the OAuth Playground and copy the new refresh token.`);
    return { creds: { mode: "own_client", ...c, access_token: t.access_token }, expiresAt: t.expiresAt, identity: c.client_id.split("-")[0] ?? c.client_id, scopes: t.scopes.length ? t.scopes : scopes };
  }
  const key = parseServiceAccountKey(input.serviceAccountKey ?? "");
  const t = await serviceAccountToken(key, scopes);
  return { creds: { mode: "service_account", key, scopes, access_token: t.access_token }, expiresAt: t.expiresAt, identity: key.client_email, scopes };
}

/** CallbackResult for a Google token connection. */
export function googleTokenResult(v: Awaited<ReturnType<typeof connectGoogleVariant>>, p: { externalAccountId: string; displayName: string; extra?: Credentials }): CallbackResult {
  return {
    credentials: { ...v.creds, ...(p.extra ?? {}) },
    scopes: v.scopes,
    externalAccountId: p.externalAccountId,
    displayName: p.displayName,
    tokenExpiresAt: v.expiresAt,
    settings: { authMode: "token", googleMode: v.creds.mode, ...(v.creds.mode === "service_account" ? { serviceAccount: v.identity } : {}) },
  };
}
