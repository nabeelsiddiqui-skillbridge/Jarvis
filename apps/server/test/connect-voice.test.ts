import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, resetDatabase, signup, workspaceWithBusiness } from "./helpers.js";
import { startMockShopify, type MockState } from "./mock-shopify.js";
import { startMockHubSpot, type HubSpotState } from "./mock-providers.js";
import { startMockElevenLabs } from "./mock-elevenlabs.js";

let app: any;
let pool: any;
let shopify: { url: string; state: MockState; close: () => Promise<void> };
let hubspot: { url: string; state: HubSpotState; close: () => Promise<void> };
let eleven: Awaited<ReturnType<typeof startMockElevenLabs>>;
let runAll: () => Promise<number>;
const XI_KEY = "xi-secret-key-123456";
// Fake tokens in the providers' formats, assembled at runtime so they never look like committed secrets.
const SHOP_TOKEN = ["shpat", "0123456789abcdef".repeat(2)].join("_");
const HS_TOKEN = ["pat", "na1", "11111111", "2222", "3333", "4444", "555555555555"].join("-");

beforeAll(async () => {
  shopify = await startMockShopify();
  hubspot = await startMockHubSpot();
  eleven = await startMockElevenLabs(XI_KEY);
  for (const k of ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET", "ELEVENLABS_API_KEY", "DEEPGRAM_API_KEY"]) delete process.env[k];
  Object.assign(process.env, {
    SHOPIFY_BASE_URL_OVERRIDE: shopify.url, HUBSPOT_BASE_URL_OVERRIDE: hubspot.url, ELEVENLABS_BASE_URL_OVERRIDE: eleven.url,
    APP_URL: "http://app.test", API_URL: "https://api.example.test", ANTHROPIC_API_KEY: "test-anthropic-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  });
  await resetDatabase();
  app = await makeApp();
  pool = (await import("../src/db/pool.js")).pool;
  const { claim } = await import("../src/jobs/queue.js");
  const { runJob } = await import("../src/jobs/handlers.js");
  runAll = async () => {
    let n = 0;
    for (let job = await claim("test"); job; job = await claim("test")) { await runJob(job); n++; }
    return n;
  };
});
afterAll(async () => { await shopify?.close(); await hubspot?.close(); await eleven?.close(); });

describe("connecting with an access token (no platform OAuth app)", () => {
  let owner: any, businessId: string;

  it("offers token connect while the OAuth app isn't configured", async () => {
    owner = await signup(app, "Owner");
    ({ businessId } = await workspaceWithBusiness(owner, "Acme"));
    const cat = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    const list = Array.isArray(cat) ? cat : cat.connectors ?? cat.catalog;
    const s = list.find((c: any) => c.id === "shopify");
    expect(s.status).toBe("config_required");
    expect(s.tokenConnect.fields.map((f: any) => f.key)).toEqual(["shop", "accessToken"]);
    expect(s.statusNote).toMatch(/key or token/);
    expect(list.find((c: any) => c.id === "hubspot").tokenConnect.fields[0].key).toBe("accessToken");
    expect(list.find((c: any) => c.id === "ga4").tokenConnect.variants.length).toBe(2); // service account or own client
    expect(list.find((c: any) => c.id === "csv").tokenConnect).toBeNull(); // uploads instead
    // OAuth is still refused until an administrator adds the app credentials.
    expect((await owner.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: "acme.myshopify.com" } })).status).toBe(412);
  });

  it("Shopify: validates the token and its scopes, connects, imports — without refresh, webhooks or revoke", async () => {
    const connect = (input: Record<string, string>) => owner.post(`/api/businesses/${businessId}/connections/shopify/token`, { input });
    expect((await connect({ shop: "acme.myshopify.com", accessToken: "not-a-token" })).body.error.message).toMatch(/shpat_/);
    const rejected = await connect({ shop: "acme.myshopify.com", accessToken: SHOP_TOKEN });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/rejected the token/);
    shopify.state.tokens.add(SHOP_TOKEN);
    shopify.state.appScopes = ["read_orders"];
    const missing = await connect({ shop: "acme.myshopify.com", accessToken: SHOP_TOKEN });
    expect(missing.body.error.message).toMatch(/read_products, read_inventory/);
    shopify.state.appScopes = undefined;
    const ok = await connect({ shop: "acme.myshopify.com", accessToken: SHOP_TOKEN });
    expect(ok.status).toBe(201);
    const id = ok.body.connectionId;
    const conn = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((c: any) => c.id === id);
    expect(conn).toMatchObject({ provider: "shopify", status: "selecting_assets", authMode: "token" });
    expect(conn.assets[0].name).toBe("Acme Outdoors");
    // The token is stored encrypted, like OAuth credentials.
    const stored = (await pool.query(`SELECT credentials_enc FROM connections WHERE id = $1`, [id])).rows[0].credentials_enc;
    expect(stored).not.toContain(SHOP_TOKEN);
    await owner.put(`/api/businesses/${businessId}/connections/${id}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    const after = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((c: any) => c.id === id);
    expect(after.status).toBe("active");
    const facts = await pool.query(`SELECT count(*)::int AS n FROM metric_facts WHERE connection_id = $1 AND metric_key = 'store_orders'`, [id]);
    expect(facts.rows[0].n).toBeGreaterThan(0);
    expect(shopify.state.calls.refresh).toBe(0);
    expect(shopify.state.calls.webhooksCreated).toEqual([]);
    const audit = await pool.query(`SELECT metadata FROM audit_logs WHERE target_id = $1 AND action = 'connection.authorized'`, [id]);
    expect(audit.rows[0].metadata.via).toBe("token");
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain(SHOP_TOKEN);
    await owner.del(`/api/businesses/${businessId}/connections/${id}`, { deleteData: false });
    expect(shopify.state.calls.revoke).toBe(0);
  });

  it("HubSpot: connects a private app token and imports without refreshing it", async () => {
    const bad = await owner.post(`/api/businesses/${businessId}/connections/hubspot/token`, { input: { accessToken: HS_TOKEN } });
    expect(bad.status).toBe(400);
    hubspot.state.accessTokens.add(HS_TOKEN);
    const ok = await owner.post(`/api/businesses/${businessId}/connections/hubspot/token`, { input: { accessToken: HS_TOKEN } });
    expect(ok.status).toBe(201);
    const conn = (await owner.get(`/api/businesses/${businessId}/connections`)).body.find((c: any) => c.id === ok.body.connectionId);
    expect(conn).toMatchObject({ provider: "hubspot", authMode: "token" });
    await owner.put(`/api/businesses/${businessId}/connections/${conn.id}/assets`, { assetIds: [conn.assets[0].id] });
    await runAll();
    const facts = await pool.query(`SELECT count(*)::int AS n FROM metric_facts WHERE connection_id = $1`, [conn.id]);
    expect(facts.rows[0].n).toBeGreaterThan(0);
    expect(hubspot.state.calls.refresh).toBe(0);
  });

  it("only managers can connect, and demo businesses can't", async () => {
    const viewer = await signup(app, "Viewer");
    const ws = (await pool.query(`SELECT workspace_id FROM businesses WHERE id = $1`, [businessId])).rows[0].workspace_id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [ws, viewer.userId]);
    await pool.query(`INSERT INTO business_memberships (workspace_id, business_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`, [ws, businessId, viewer.userId]);
    expect((await viewer.post(`/api/businesses/${businessId}/connections/hubspot/token`, { input: { accessToken: HS_TOKEN } })).status).toBe(403);
    expect((await owner.post(`/api/businesses/${businessId}/connections/csv/token`, { input: {} })).status).toBe(412);
  });
});

describe("provider credentials managed from the admin console", () => {
  let admin: any, owner: any, businessId: string;

  it("lets platform administrators set and clear credentials, never showing secrets", async () => {
    owner = await signup(app, "Merchant");
    ({ businessId } = await workspaceWithBusiness(owner, "Shop Co"));
    admin = await signup(app, "Admin");
    await pool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [admin.userId]);
    expect((await owner.get("/api/admin/settings")).status).toBe(403);
    expect((await owner.put("/api/admin/settings/SHOPIFY_API_KEY", { value: "x" })).status).toBe(403);

    expect((await admin.put("/api/admin/settings/SHOPIFY_API_KEY", { value: "shop-client-id" })).status).toBe(200);
    expect((await admin.put("/api/admin/settings/SHOPIFY_API_SECRET", { value: "shop-client-secret-xyz" })).status).toBe(200);
    expect((await admin.put("/api/admin/settings/DATABASE_URL", { value: "postgres://evil" })).status).toBe(404);
    expect((await admin.put("/api/admin/settings/SHOPIFY_API_KEY", { value: "a\nb" })).status).toBe(400);

    const settings = (await admin.get("/api/admin/settings")).body;
    const id = settings.find((s: any) => s.key === "SHOPIFY_API_KEY");
    const secret = settings.find((s: any) => s.key === "SHOPIFY_API_SECRET");
    expect(id).toMatchObject({ configured: true, source: "admin", value: "shop-client-id" });
    expect(secret).toMatchObject({ configured: true, source: "admin", value: null });
    expect(JSON.stringify(settings)).not.toContain("shop-client-secret-xyz");
    expect(JSON.stringify((await admin.get("/api/admin/config")).body)).not.toContain("shop-client-secret-xyz");
    const row = (await pool.query(`SELECT value_enc FROM platform_secrets WHERE key = 'SHOPIFY_API_SECRET'`)).rows[0];
    expect(row.value_enc).not.toContain("shop-client-secret-xyz");

    // Takes effect at once: one-click Shopify sign-in becomes available.
    const cat = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    const list = Array.isArray(cat) ? cat : cat.connectors ?? cat.catalog;
    expect(list.find((c: any) => c.id === "shopify").status).toBe("available");
    const auth = await owner.post(`/api/businesses/${businessId}/connections/shopify/authorize`, { input: { shop: "shop-co.myshopify.com" } });
    expect(auth.status).toBe(200);
    expect(new URL(auth.body.url).searchParams.get("client_id")).toBe("shop-client-id");

    const audit = (await admin.get("/api/admin/audit?action=admin.setting_changed")).body;
    expect(audit.map((a: any) => a.target_id).sort()).toEqual(["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"]);
    expect(JSON.stringify(audit)).not.toContain("shop-client-secret-xyz");

    expect((await admin.del("/api/admin/settings/SHOPIFY_API_SECRET")).status).toBe(200);
    const again = (await owner.get(`/api/businesses/${businessId}/connectors`)).body;
    expect((Array.isArray(again) ? again : again.connectors ?? again.catalog).find((c: any) => c.id === "shopify").status).toBe("config_required");
  });

  it("refuses to override a value set in the hosting environment", async () => {
    // ANTHROPIC_API_KEY came from the environment when the server started.
    expect((await admin.put("/api/admin/settings/ANTHROPIC_API_KEY", { value: "other" })).status).toBe(409);
    expect((await admin.get("/api/admin/settings")).body.find((s: any) => s.key === "ANTHROPIC_API_KEY").source).toBe("environment");
  });
});

describe("ElevenLabs voices", () => {
  let user: any, businessId: string, admin: any;

  it("explains that voice choice needs ElevenLabs until it is configured", async () => {
    user = await signup(app, "Speaker");
    ({ businessId } = await workspaceWithBusiness(user, "Voice Co"));
    const r = (await user.get("/api/voice/voices")).body;
    expect(r).toMatchObject({ provider: "browser", voices: [] });
    expect(r.note).toMatch(/ElevenLabs/);
  });

  it("lists the account's voices, saves each user's choice and speaks with it", async () => {
    admin = (await pool.query(`SELECT id FROM users WHERE is_platform_admin LIMIT 1`)).rows[0];
    const adminClient = await signup(app, "Admin2");
    await pool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [adminClient.userId]);
    expect((await adminClient.put("/api/admin/settings/ELEVENLABS_API_KEY", { value: XI_KEY })).status).toBe(200);

    const v = (await user.get("/api/voice/voices")).body;
    expect(v.provider).toBe("elevenlabs");
    expect(v.voices.map((x: any) => x.name)).toEqual(["Rachel", "Adam"]);
    expect(v.voices[0]).toMatchObject({ id: "21m00Tcm4TlvDq8ikWAM", accent: "american", gender: "female" });
    expect(JSON.stringify(v)).not.toContain(XI_KEY);

    // Voice sessions now speak through the server (browser recognition, ElevenLabs voice).
    const session = (await user.post(`/api/businesses/${businessId}/voice/session`, {})).body;
    expect(session).toMatchObject({ stt: { provider: "browser" }, tts: { provider: "server" } });

    expect((await user.put("/api/voice/preference", { voiceId: "unknownVoice123" })).status).toBe(412);
    expect((await user.put("/api/voice/preference", { voiceId: "pNInz6obpgDQGcFmaJgB" })).status).toBe(200);
    expect((await user.get("/api/voice/voices")).body.selected).toBe("pNInz6obpgDQGcFmaJgB");

    const speak = await user.post(`/api/businesses/${businessId}/voice/speak`, { text: "Net sales rose five percent." });
    expect(speak.status).toBe(200);
    expect(speak.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(eleven.calls.speak.at(-1)).toMatchObject({ voice: "pNInz6obpgDQGcFmaJgB", model: "eleven_flash_v2_5", text: "Net sales rose five percent.", format: "mp3_44100_128" });
    // A preview can use another voice without changing the saved choice.
    await user.post(`/api/businesses/${businessId}/voice/speak`, { text: "Preview", voiceId: "21m00Tcm4TlvDq8ikWAM" });
    expect(eleven.calls.speak.at(-1)!.voice).toBe("21m00Tcm4TlvDq8ikWAM");
    expect((await user.get("/api/voice/voices")).body.selected).toBe("pNInz6obpgDQGcFmaJgB");
    const usage = await pool.query(`SELECT meta->>'provider' AS p FROM usage_events WHERE kind = 'tts_characters' ORDER BY id DESC LIMIT 1`);
    expect(usage.rows[0].p).toBe("elevenlabs");

    // Another user gets the platform default until they choose.
    const other = await signup(app, "Listener");
    const o = await workspaceWithBusiness(other, "Other Co");
    await other.post(`/api/businesses/${o.businessId}/voice/speak`, { text: "Hello" });
    expect(eleven.calls.speak.at(-1)!.voice).toBe("21m00Tcm4TlvDq8ikWAM");
    // Voices are per user and other businesses' users can't speak through this business.
    expect((await other.post(`/api/businesses/${businessId}/voice/speak`, { text: "Hi" })).status).toBe(404);
  });
});
