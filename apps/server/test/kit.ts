import express from "express";
import type { Server } from "node:http";
import { makeApp, resetDatabase } from "./helpers.js";

/**
 * Shared harness for connector tests: a local provider stand-in (routes are host-prefixed,
 * matching providerUrl(): http://mock/<host>/<path>), a fresh database and app, a job runner,
 * and helpers to connect with a token, select assets and query metrics.
 */

export async function startMock(setup: (app: express.Express) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: false }));
  setup(app);
  app.use((req, res) => res.status(404).json({ error: `mock: no route for ${req.method} ${req.path}` }));
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const p = (server.address() as any).port;
      resolve({ url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Fresh database + app + job runner. Set provider env (overrides, keys) before calling. */
export async function bootApp() {
  await resetDatabase();
  const app = await makeApp();
  const pool = (await import("../src/db/pool.js")).pool;
  const { claim } = await import("../src/jobs/queue.js");
  const { runJob } = await import("../src/jobs/handlers.js");
  const runAll = async () => {
    let n = 0;
    for (let job = await claim("test"); job; job = await claim("test")) {
      await runJob(job);
      n++;
    }
    return n;
  };
  return { app, pool, runAll };
}

/** Connect with a token, select every discovered asset (or those matching `pick`) and run the initial sync. */
export async function connectWithToken(c: any, businessId: string, provider: string, input: Record<string, string>, runAll: () => Promise<number>, pick?: (a: any) => boolean) {
  const r = await c.post(`/api/businesses/${businessId}/connections/${provider}/token`, { input });
  if (r.status !== 201) throw new Error(`token connect failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.connectionId as string;
  const conn = await connection(c, businessId, id);
  const assetIds = conn.assets.filter((a: any) => (pick ? pick(a) : true)).map((a: any) => a.id);
  const sel = await c.put(`/api/businesses/${businessId}/connections/${id}/assets`, { assetIds });
  if (sel.status !== 200) throw new Error(`asset selection failed: ${sel.status} ${JSON.stringify(sel.body)}`);
  await runAll();
  return { id, conn: await connection(c, businessId, id) };
}

export async function connection(c: any, businessId: string, id: string) {
  return (await c.get(`/api/businesses/${businessId}/connections`)).body.find((x: any) => x.id === id);
}

/** Run a metric query (no comparison unless given). */
export async function metric(c: any, businessId: string, q: Record<string, unknown>) {
  const r = await c.post(`/api/businesses/${businessId}/metrics/query`, { query: { comparison: "none", ...q } });
  if (r.status !== 200) throw new Error(`query failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Fake credentials in a provider's format, assembled at runtime so they never look like committed secrets. */
export const fakeToken = (...parts: string[]) => parts.join("");

/** Local date (YYYY-MM-DD) of an instant in a timezone. */
export const localDay = (iso: string | Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
