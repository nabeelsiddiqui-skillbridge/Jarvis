import { beforeAll, describe, expect, it } from "vitest";
import { client, makeApp, resetDatabase, signup, workspaceWithBusiness } from "./helpers.js";

let app: any;
beforeAll(async () => {
  await resetDatabase();
  app = await makeApp();
});

describe("authentication", () => {
  it("rejects anonymous access and requires the client header for writes", async () => {
    const anon = client(app);
    expect((await anon.get("/api/auth/me")).status).toBe(401);
    const noHeader = await anon.agent.post("/api/auth/login").send({ email: "a@b.co", password: "x" });
    expect(noHeader.status).toBe(403);
  });

  it("signs up, signs in, rejects wrong passwords with a generic message", async () => {
    const a = await signup(app, "Alice");
    const me = await a.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(a.email);
    const anon = client(app);
    const bad = await anon.post("/api/auth/login", { email: a.email, password: "wrong password!!" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe("Wrong email or password.");
    const unknown = await anon.post("/api/auth/login", { email: "nobody@example.com", password: "wrong password!!" });
    expect(unknown.body.error.message).toBe("Wrong email or password.");
  });

  it("enforces password length and unique emails", async () => {
    const anon = client(app);
    const short = await anon.post("/api/auth/signup", { name: "S", email: "s@example.com", password: "short" });
    expect(short.status).toBe(400);
    const a = await signup(app, "Dup");
    const dup = await client(app).post("/api/auth/signup", { name: "D", email: a.email.toUpperCase(), password: "long enough password" });
    expect(dup.status).toBe(409);
  });
});

describe("business isolation", () => {
  it("never exposes another user's business, goals or audit trail", async () => {
    const alice = await signup(app, "Alice");
    const bob = await signup(app, "Bob");
    const a = await workspaceWithBusiness(alice, "Alice Co");
    const b = await workspaceWithBusiness(bob, "Bob Co");

    // Bob cannot read, edit, list or probe Alice's business — and gets 404, not 403.
    expect((await bob.get(`/api/businesses/${a.businessId}`)).status).toBe(404);
    expect((await bob.patch(`/api/businesses/${a.businessId}`, { name: "pwned" })).status).toBe(404);
    expect((await bob.get(`/api/businesses/${a.businessId}/goals`)).status).toBe(404);
    expect((await bob.post(`/api/businesses/${a.businessId}/goals`, { title: "x" })).status).toBe(404);
    expect((await bob.get(`/api/workspaces/${a.workspaceId}/businesses`)).status).toBe(404);
    expect((await bob.post(`/api/workspaces/${a.workspaceId}/businesses`, { name: "x", industry: "other", timezone: "UTC", currency: "USD" })).status).toBe(404);
    expect((await bob.get(`/api/workspaces/${a.workspaceId}/members`)).status).toBe(404);

    // Each sees only their own.
    const bobList = await bob.get(`/api/workspaces/${b.workspaceId}/businesses`);
    expect(bobList.body.map((x: any) => x.id)).toEqual([b.businessId]);
    const name = await alice.get(`/api/businesses/${a.businessId}`);
    expect(name.body.name).toBe("Alice Co");
    expect(name.body.role).toBe("owner");
  });

  it("scopes invited members to the businesses they were granted", async () => {
    const owner = await signup(app, "Owner");
    const { workspaceId, businessId: biz1 } = await workspaceWithBusiness(owner, "Client One");
    const biz2 = (await owner.post(`/api/workspaces/${workspaceId}/businesses`, { name: "Client Two", industry: "saas", timezone: "UTC", currency: "EUR" })).body.id;

    const viewer = await signup(app, "Viewer");
    const inv = await owner.post(`/api/workspaces/${workspaceId}/invitations`, { email: viewer.email, role: "member", businessGrants: [{ businessId: biz1, role: "viewer" }] });
    expect(inv.status).toBe(201);
    const token = inv.body.inviteUrl.split("/invite/")[1];

    // Someone else can't redeem it.
    const stranger = await signup(app, "Stranger");
    expect((await stranger.post(`/api/invites/${token}/accept`)).status).toBe(403);

    expect((await viewer.post(`/api/invites/${token}/accept`)).status).toBe(200);
    const list = await viewer.get(`/api/workspaces/${workspaceId}/businesses`);
    expect(list.body.map((x: any) => x.name)).toEqual(["Client One"]);
    expect(list.body[0].role).toBe("viewer");
    expect((await viewer.get(`/api/businesses/${biz2}`)).status).toBe(404);

    // Viewer can read but not write.
    expect((await viewer.get(`/api/businesses/${biz1}/goals`)).status).toBe(200);
    expect((await viewer.post(`/api/businesses/${biz1}/goals`, { title: "Grow" })).status).toBe(403);
    expect((await viewer.patch(`/api/businesses/${biz1}`, { name: "x" })).status).toBe(403);
    expect((await viewer.post(`/api/workspaces/${workspaceId}/businesses`, { name: "x", industry: "other", timezone: "UTC", currency: "USD" })).status).toBe(403);

    // Upgrade to analyst → can write goals; access removal takes effect immediately.
    expect((await owner.put(`/api/businesses/${biz1}/access/${viewer.userId}`, { role: "analyst" })).status).toBe(200);
    expect((await viewer.post(`/api/businesses/${biz1}/goals`, { title: "Grow", targetValue: 1000 })).status).toBe(201);
    expect((await owner.put(`/api/businesses/${biz1}/access/${viewer.userId}`, { role: null })).status).toBe(200);
    expect((await viewer.get(`/api/businesses/${biz1}`)).status).toBe(404);

    // Invitation can't be reused.
    expect((await viewer.post(`/api/invites/${token}/accept`)).status).toBe(404);
  });

  it("row-level security blocks cross-tenant reads even for raw SQL as the app role", async () => {
    const { pool, withUser } = await import("../src/db/pool.js");
    const x = await signup(app, "Xavier");
    const y = await signup(app, "Yolanda");
    const xb = await workspaceWithBusiness(x, "X Co");
    await workspaceWithBusiness(y, "Y Co");
    await x.post(`/api/businesses/${xb.businessId}/goals`, { title: "Secret goal" });

    const seen = await withUser(y.userId, async (db) => ({
      businesses: (await db.query("SELECT name FROM businesses")).rows.map((r) => r.name),
      goals: (await db.query("SELECT title FROM business_goals")).rows,
      users: (await db.query("SELECT email FROM users")).rows.map((r) => r.email),
    }));
    expect(seen.businesses).toEqual(["Y Co"]);
    expect(seen.goals).toEqual([]);
    expect(seen.users).toEqual([y.email]);

    // Writes into a foreign business are rejected by policy.
    await expect(
      withUser(y.userId, (db) =>
        db.query("INSERT INTO business_goals (workspace_id, business_id, title) VALUES ($1, $2, 'injected')", [xb.workspaceId, xb.businessId]),
      ),
    ).rejects.toThrow(/row-level security/);
    // The app role cannot touch credentials tables at all.
    await expect(withUser(y.userId, (db) => db.query("SELECT password_hash FROM users"))).rejects.toThrow(/permission denied/);
    await expect(withUser(y.userId, (db) => db.query("SELECT * FROM sessions"))).rejects.toThrow(/permission denied/);
    void pool;
  });
});
