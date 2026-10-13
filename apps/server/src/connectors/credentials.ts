import type pg from "pg";
import { pool } from "../db/pool.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { ProviderError } from "./http.js";
import type { ConnectorDefinition, Credentials } from "./types.js";

/**
 * Credentials never leave the server: they're stored AES-256-GCM encrypted and
 * decrypted only inside the worker/API process when a provider call is made.
 */
export async function saveCredentials(db: pg.PoolClient | pg.Pool, connectionId: string, creds: Credentials, expiresAt: Date | null) {
  await db.query(`UPDATE connections SET credentials_enc = $2, token_expires_at = $3, updated_at = now() WHERE id = $1`, [connectionId, encryptJson(creds), expiresAt]);
}

async function readCredentials(db: pg.PoolClient | pg.Pool, connectionId: string): Promise<{ creds: Credentials; expiresAt: Date | null }> {
  const { rows } = await db.query(`SELECT credentials_enc, token_expires_at, disconnected_at FROM connections WHERE id = $1`, [connectionId]);
  const r = rows[0];
  if (!r || r.disconnected_at || !r.credentials_enc) throw new ProviderError("auth", "This connection has no valid credentials. Reconnect the account.");
  return { creds: decryptJson<Credentials>(r.credentials_enc), expiresAt: r.token_expires_at ? new Date(r.token_expires_at) : null };
}

/**
 * Get usable credentials, refreshing if they're about to expire. Refresh runs under
 * a per-connection advisory lock in its own transaction: rotating refresh tokens
 * (Shopify, Google, HubSpot) are single-use, so two workers must never refresh at once,
 * and the new pair is persisted before the lock is released.
 */
export async function getCredentials(def: ConnectorDefinition, connectionId: string): Promise<Credentials> {
  const first = await readCredentials(pool, connectionId);
  if (!def.refreshCredentials || !def.needsRefresh?.(first.creds, first.expiresAt)) return first.creds;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`refresh:${connectionId}`]);
    // Another worker may have refreshed while we waited.
    const current = await readCredentials(client, connectionId);
    if (!def.needsRefresh(current.creds, current.expiresAt)) {
      await client.query("COMMIT");
      return current.creds;
    }
    const next = await def.refreshCredentials(current.creds);
    await saveCredentials(client, connectionId, next.credentials, next.expiresAt);
    await client.query("COMMIT");
    return next.credentials;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
