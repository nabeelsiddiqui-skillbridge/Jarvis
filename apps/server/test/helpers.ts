import pg from "pg";
import request from "supertest";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/bca_test";

/** Fresh database per test file run. Must be called before importing the app. */
export async function resetDatabase() {
  const admin = new URL(BASE);
  const name = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
  await c.query(`DROP DATABASE IF EXISTS "${name}"`);
  await c.query(`CREATE DATABASE "${name}"`);
  await c.end();
  process.env.DATABASE_URL = BASE;
  process.env.DEV_DATA_DIR = "/tmp/bca-test-data";
  const { migrate } = await import("../src/db/migrate.js");
  await migrate(BASE, { quiet: true });
}

export async function makeApp() {
  const { createApp } = await import("../src/app.js");
  return createApp();
}

/** A logged-in agent (cookie jar) that sends the CSRF header. */
export function client(app: any) {
  const agent = request.agent(app);
  const wrap = (m: "get" | "post" | "patch" | "put" | "delete") => (url: string, body?: unknown) => {
    const r = agent[m](url).set("X-BCA-Client", "web");
    return body === undefined ? r : r.send(body as object);
  };
  return { agent, get: wrap("get"), post: wrap("post"), patch: wrap("patch"), put: wrap("put"), del: wrap("delete") };
}

export type Client = ReturnType<typeof client>;

export async function signup(app: any, name: string) {
  const c = client(app);
  const email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const r = await c.post("/api/auth/signup", { name, email, password: "correct horse battery" });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  return Object.assign(c, { email, userId: r.body.id as string });
}

export async function workspaceWithBusiness(c: Client, bizName = "Acme") {
  const ws = await c.post("/api/workspaces", { name: `${bizName} WS` });
  const biz = await c.post(`/api/workspaces/${ws.body.id}/businesses`, {
    name: bizName, industry: "ecommerce", timezone: "America/New_York", currency: "USD",
  });
  if (biz.status !== 201) throw new Error(`business create failed: ${JSON.stringify(biz.body)}`);
  return { workspaceId: ws.body.id as string, businessId: biz.body.id as string };
}
