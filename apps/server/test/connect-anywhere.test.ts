import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, workspaceWithBusiness } from "./helpers.js";
import { bootApp, connection } from "./kit.js";
import { startMockGoogle, type GoogleState } from "./mock-providers.js";
import { QB, startMockBooks } from "./mock-books.js";
import { startMockElevenLabs } from "./mock-elevenlabs.js";

/**
 * Every connector can be connected from the browser without the platform's own OAuth apps:
 * Google sources with a service-account key or the user's own OAuth client, QuickBooks with
 * the user's own Intuit app. Each catalog entry carries a step-by-step guide. Voice settings:
 * per-user voice + tuning, and platform-admin key/default management.
 */
let app: any, pool: any, runAll: () => Promise<number>;
let google: { url: string; state: GoogleState; close: () => Promise<void> };
let books: Awaited<ReturnType<typeof startMockBooks>>;
let eleven: Awaited<ReturnType<typeof startMockElevenLabs>>;
const XI_KEY = ["xi", "test", "key", "0123456789abcdef"].join("_");

// A throwaway service-account key generated for this run (never committed).
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_EMAIL = "reporting@acme-project.iam.gserviceaccount.com";
const SA_KEY = JSON.stringify({ type: "service_account", project_id: "acme-project", client_email: SA_EMAIL, private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token" });

beforeAll(async () => {
  google = await startMockGoogle();
  books = await startMockBooks();
  eleven = await startMockElevenLabs(XI_KEY);
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "ELEVENLABS_API_KEY", "ELEVENLABS_DEFAULT_VOICE_ID", "ELEVENLABS_MODEL", "DEEPGRAM_API_KEY"]) delete process.env[k];
  Object.assign(process.env, {
    GOOGLE_BASE_URL_OVERRIDE: google.url, QUICKBOOKS_BASE_URL_OVERRIDE: books.url, ELEVENLABS_BASE_URL_OVERRIDE: eleven.url,
    APP_URL: "http://app.test", API_URL: "https://api.example.test", PLATFORM_ADMIN_EMAILS: "",
  });
  ({ app, pool, runAll } = await bootApp());
  google.state.serviceAccounts.set(SA_EMAIL, publicKey.export({ type: "spki", format: "pem" }) as string);
});
afterAll(async () => { await google?.close(); await books?.close(); await eleven?.close(); });

describe("connecting without the platform's OAuth apps", () => {
  let owner: any, businessId: string;

  it("lists every connector as connectable, each with a how-to guide", async () => {
    owner = await signup(app, "Owner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme"));
    const cat = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    const live = cat.filter((c: any) => c.status !== "planned");
    expect(live.length).toBe(23);
    for (const c of live) {
      expect(c.guide?.summary, c.id).toBeTruthy();
      expect(c.id === "csv" || Boolean(c.tokenConnect) || c.status === "available", c.id).toBe(true);
    }
    const ga4 = cat.find((c: any) => c.id === "ga4");
    expect(ga4.status).toBe("config_required");
    expect(ga4.tokenConnect.variants.map((v: any) => v.id)).toEqual(["service_account", "own_client"]);
    expect(ga4.guide.adminSetup.length).toBeGreaterThan(3);
    expect(ga4.redirectUri).toBe("https://api.example.test/api/oauth/ga4/callback");
    expect(cat.find((c: any) => c.id === "google_sheets").tokenConnect.variants.map((v: any) => v.id)).toEqual(["published", "service_account"]);
    expect(cat.find((c: any) => c.id === "quickbooks").tokenConnect.fields.map((f: any) => f.key)).toContain("realmId");
  });

  it("GA4: connects with a service-account key, imports, refreshes by signing a new JWT, and never revokes the key", async () => {
    const connect = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/ga4/token`, { input: { _method: "service_account", ...input } });
    expect((await connect({ serviceAccountKey: "not json" })).body.error.message).toMatch(/valid JSON key/);
    expect((await connect({ serviceAccountKey: JSON.stringify({ type: "authorized_user" }) })).body.error.message).toMatch(/isn't a service-account key/);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    const rejected = await connect({ serviceAccountKey: JSON.stringify({ ...JSON.parse(SA_KEY), private_key: other }) });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).not.toContain("PRIVATE KEY");

    const ok = await connect({ serviceAccountKey: SA_KEY });
    expect(ok.status).toBe(201);
    const id = ok.body.connectionId;
    const conn = await connection(owner, businessId, id);
    expect(conn).toMatchObject({ provider: "ga4", authMode: "token", accountName: "Acme Ltd" });
    const stored = (await pool.query(`SELECT credentials_enc FROM connections WHERE id = $1`, [id])).rows[0].credentials_enc;
    expect(stored).not.toContain("PRIVATE KEY");
    await owner.put(`/api/businesses/${businessId}/connections/${id}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    expect((await connection(owner, businessId, id)).status).toBe("active");
    expect((await pool.query(`SELECT count(*)::int AS n FROM metric_facts WHERE connection_id = $1 AND metric_key = 'sessions'`, [id])).rows[0].n).toBeGreaterThan(0);

    // Expired access token → a new one is minted from the key (no refresh token involved).
    const before = google.state.calls.jwt;
    await pool.query(`UPDATE connections SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    await owner.post(`/api/businesses/${businessId}/connections/${id}/sync`);
    await runAll();
    expect(google.state.calls.jwt).toBe(before + 1);
    expect(google.state.calls.refresh).toBe(0);
    const revokes = google.state.calls.revoke;
    await owner.del(`/api/businesses/${businessId}/connections/${id}`, { deleteData: true });
    expect(google.state.calls.revoke).toBe(revokes);
  });

  it("Search Console: connects with the user's own OAuth client and refresh token", async () => {
    const clientId = "123-own.apps.googleusercontent.com";
    google.state.ownClients.set(clientId, "own-secret");
    google.state.refreshTokens.set("1//own-refresh", ["https://www.googleapis.com/auth/webmasters.readonly"]);
    const connect = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/gsc/token`, { input: { _method: "own_client", ...input } });
    expect((await connect({ clientId: "nope", clientSecret: "x", refreshToken: "y" })).body.error.message).toMatch(/apps\.googleusercontent\.com/);
    expect((await connect({ clientId, clientSecret: "wrong", refreshToken: "1//own-refresh" })).status).toBe(400);
    const ok = await connect({ clientId, clientSecret: "own-secret", refreshToken: "1//own-refresh" });
    expect(ok.status).toBe(201);
    const conn = await connection(owner, businessId, ok.body.connectionId);
    await owner.put(`/api/businesses/${businessId}/connections/${conn.id}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    expect((await connection(owner, businessId, conn.id)).status).toBe("active");
  });

  it("Google Ads: connects with the user's own developer token and OAuth client", async () => {
    owner = await signup(app, "AdsOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Ads Co"));
    const clientId = "456-ads.apps.googleusercontent.com";
    google.state.ownClients.set(clientId, "ads-secret");
    google.state.refreshTokens.set("1//ads-refresh", ["https://www.googleapis.com/auth/adwords"]);
    const devToken = ["Ab", "Cd", "Ef", "0123456789", "XYZ12"].join("");
    const input = { developerToken: devToken, clientId, clientSecret: "ads-secret", refreshToken: "1//ads-refresh" };
    // The developer token isn't known to Google yet → explained, not a generic error.
    const bad = await owner.post(`/api/businesses/${businessId}/connections/google_ads/token`, { input });
    expect(bad.status).toBe(400);
    google.state.devTokens.add(devToken);
    const ok = await owner.post(`/api/businesses/${businessId}/connections/google_ads/token`, { input });
    expect(ok.status).toBe(201);
    const conn = await connection(owner, businessId, ok.body.connectionId);
    expect(conn.assets.length).toBeGreaterThan(0);
    await owner.put(`/api/businesses/${businessId}/connections/${conn.id}/assets`, { assetIds: conn.assets.map((a: any) => a.id) });
    await runAll();
    expect((await connection(owner, businessId, conn.id)).status).toBe("active");
    expect((await pool.query(`SELECT count(*)::int AS n FROM metric_facts WHERE connection_id = $1 AND metric_key = 'ad_spend'`, [conn.id])).rows[0].n).toBeGreaterThan(0);
  });

  it("QuickBooks: connects with the user's own Intuit app, storing the rotated refresh token", async () => {
    owner = await signup(app, "BooksOwner");
    ({ businessId } = await workspaceWithBusiness(owner, "Books Co"));
    books.state.qb.refresh.add("qb-own-refresh");
    const base = { clientId: QB.clientId, clientSecret: QB.clientSecret, refreshToken: "qb-own-refresh", realmId: QB.realmId };
    expect((await owner.post(`/api/businesses/${businessId}/connections/quickbooks/token`, { input: { ...base, realmId: "abc" } })).body.error.message).toMatch(/Realm ID/);
    expect((await owner.post(`/api/businesses/${businessId}/connections/quickbooks/token`, { input: { ...base, clientSecret: "nope" } })).status).toBe(400);
    const ok = await owner.post(`/api/businesses/${businessId}/connections/quickbooks/token`, { input: base });
    expect(ok.status).toBe(201);
    expect(books.state.qb.refresh.has("qb-own-refresh")).toBe(false); // spent: Intuit rotated it
    const conn = await connection(owner, businessId, ok.body.connectionId);
    await owner.put(`/api/businesses/${businessId}/connections/${conn.id}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    expect((await connection(owner, businessId, conn.id)).status).toBe("active");
    expect((await pool.query(`SELECT count(*)::int AS n FROM metric_facts WHERE connection_id = $1 AND metric_key = 'acct_revenue'`, [conn.id])).rows[0].n).toBeGreaterThan(0);
  });
});

describe("voice settings", () => {
  let admin: any, user: any;

  it("lets a platform admin add the ElevenLabs key (checked first) and set the default voice", async () => {
    admin = await signup(app, "Admin");
    user = await signup(app, "User");
    await pool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [admin.userId]);
    const before = (await admin.get("/api/voice/voices")).body;
    expect(before).toMatchObject({ provider: "browser", admin: { canManage: true } });
    expect((await user.get("/api/voice/voices")).body.admin.canManage).toBe(false);
    expect((await user.put("/api/voice/elevenlabs-key", { apiKey: XI_KEY })).status).toBe(403);
    expect((await admin.put("/api/voice/elevenlabs-key", { apiKey: "x".repeat(24) })).status).toBe(412);
    expect((await admin.put("/api/voice/elevenlabs-key", { apiKey: XI_KEY })).status).toBe(200);
    const list = (await admin.get("/api/voice/voices")).body;
    expect(list.provider).toBe("elevenlabs");
    expect(list.voices.length).toBeGreaterThan(1);
    const pick = list.voices[1].id;
    expect((await user.put("/api/voice/default", { voiceId: pick })).status).toBe(403);
    expect((await admin.put("/api/voice/default", { voiceId: pick })).status).toBe(200);
    expect((await user.get("/api/voice/voices")).body.defaultVoice).toBe(pick);
    const audit = await pool.query(`SELECT metadata FROM audit_logs WHERE action = 'admin.setting_changed' AND target_id = 'ELEVENLABS_API_KEY'`);
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows)).not.toContain(XI_KEY);
  });

  it("saves a user's voice and tuning and uses them when speaking", async () => {
    const { businessId } = await workspaceWithBusiness(user, "Voice Co");
    const list = (await user.get("/api/voice/voices")).body;
    const mine = list.voices[0].id;
    expect((await user.put("/api/voice/preference", { voiceId: mine })).status).toBe(200);
    expect((await user.put("/api/voice/preference", { settings: { speed: 3 } })).status).toBe(400);
    expect((await user.put("/api/voice/preference", { settings: { model: "eleven_multilingual_v2", speed: 1.1, stability: 0.4 } })).status).toBe(200);
    const after = (await user.get("/api/voice/voices")).body;
    expect(after.selected).toBe(mine); // saving tuning keeps the chosen voice
    expect(after.settings).toEqual({ model: "eleven_multilingual_v2", speed: 1.1, stability: 0.4 });
    const spoken = await user.post(`/api/businesses/${businessId}/voice/speak`, { text: "Hello there." });
    expect(spoken.status).toBe(200);
    const last = eleven.calls.speak.at(-1)!;
    expect(last).toMatchObject({ voice: mine, model: "eleven_multilingual_v2", settings: { speed: 1.1, stability: 0.4 } });
  });
});
