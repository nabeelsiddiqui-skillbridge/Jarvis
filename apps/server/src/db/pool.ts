import pg from "pg";
import { config } from "../config.js";

// numeric → number is safe for business metrics within float precision; bigints stay strings
// unless they fit (counts). int8 (20) → number, numeric (1700) → number.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// Keep DATE (1082) as 'YYYY-MM-DD' strings — reporting dates are timezone-less calendar days.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => console.error("[db] idle client error", err.message));

export type Db = pg.PoolClient | pg.Pool;

/**
 * Run `fn` in a transaction as the restricted `bca_app` role with the user id
 * set, so row-level security applies. Use for every user-initiated request.
 */
export async function withUser<T>(userId: string, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE bca_app");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Privileged transaction (table owner, RLS bypassed). Only for system work —
 * auth, the worker, webhooks — and every query inside must scope explicitly.
 */
export async function withSystem<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
