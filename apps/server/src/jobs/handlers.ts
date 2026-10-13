import type pg from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { getCredentials } from "../connectors/credentials.js";
import { ProviderError } from "../connectors/http.js";
import { getConnector } from "../connectors/registry.js";
import type { AssetRow, ConnectionRow, ConnectorDefinition, SyncContext } from "../connectors/types.js";
import { complete, enqueue, fail, type Job } from "./queue.js";

async function loadConnection(db: pg.PoolClient, id: string): Promise<ConnectionRow | null> {
  const { rows } = await db.query(`SELECT * FROM connections WHERE id = $1 AND disconnected_at IS NULL`, [id]);
  return rows[0] ?? null;
}

async function selectedAssets(db: pg.PoolClient, connectionId: string): Promise<AssetRow[]> {
  return (await db.query(`SELECT * FROM connection_assets WHERE connection_id = $1 AND selected ORDER BY created_at`, [connectionId])).rows;
}

function makeCtx(db: pg.PoolClient, def: ConnectorDefinition, connection: ConnectionRow, asset: AssetRow, jobId: string, mode: SyncContext["mode"]): SyncContext {
  return {
    db,
    connection,
    asset,
    jobId,
    mode,
    credentials: () => getCredentials(def, connection.id),
    log: (m) => console.log(`[sync ${connection.provider}:${connection.id.slice(0, 8)}] ${m}`),
  };
}

const notify = (db: pg.PoolClient, businessId: string, kind: string, payload: Record<string, unknown> = {}) =>
  db.query("SELECT app.notify_business($1, $2, $3)", [businessId, kind, JSON.stringify(payload)]);

/** Translate a failure into connection state + retry decision. */
async function recordFailure(db: pg.PoolClient, job: Job, connection: ConnectionRow, err: unknown) {
  const pe = err instanceof ProviderError ? err : null;
  const kind = pe?.kind ?? "transient";
  const message = pe?.message ?? "Unexpected error while syncing";
  if (!pe) console.error(`[job ${job.id}]`, err);
  else if (pe.detail) console.warn(`[job ${job.id}] ${pe.kind} ${pe.status ?? ""}: ${pe.detail.slice(0, 300)}`);
  const status = kind === "auth" ? "reauth_required" : kind === "scope" ? "error" : null;
  const outcome = await fail(db, job, message, { retryable: pe ? pe.retryable : true, retryAfterMs: pe?.retryAfterMs });
  await db.query(
    `UPDATE connections SET last_error = $2, last_error_at = now(), consecutive_failures = consecutive_failures + 1,
            status = CASE WHEN $3::text IS NOT NULL THEN $3 WHEN $4 = 'failed' THEN 'error' ELSE status END, updated_at = now()
      WHERE id = $1`,
    [connection.id, message, status, outcome],
  );
  if (outcome === "failed" || status) {
    await audit(db, { workspaceId: connection.workspace_id, businessId: connection.business_id, actorType: "system", action: "connection.sync_failed", targetType: "connection", targetId: connection.id, metadata: { kind, message } });
  }
  await notify(db, connection.business_id, "connection_updated", { connectionId: connection.id });
}

export async function runJob(job: Job) {
  const db = await pool.connect();
  try {
    switch (job.type) {
      case "connection.sync":
        return await syncJob(db, job);
      case "connection.webhook":
        return await webhookJob(db, job);
      case "connection.health":
        return await healthJob(db, job);
      case "connection.register_webhooks":
        return await registerWebhooksJob(db, job);
      default:
        await fail(db, job, `Unknown job type ${job.type}`, { retryable: false });
    }
  } finally {
    db.release();
  }
}

async function syncJob(db: pg.PoolClient, job: Job) {
  const connection = await loadConnection(db, job.connection_id!);
  if (!connection) return complete(db, job.id, { skipped: "connection removed" });
  const def = getConnector(connection.provider);
  if (!def?.sync) return fail(db, job, `No sync implementation for ${connection.provider}`, { retryable: false });
  const mode = (job.payload.mode ?? "incremental") as SyncContext["mode"];
  await db.query(`UPDATE connections SET status = CASE WHEN status IN ('reauth_required') THEN status ELSE 'syncing' END, last_sync_started_at = now() WHERE id = $1`, [connection.id]);
  await notify(db, connection.business_id, "connection_updated", { connectionId: connection.id });
  try {
    const assets = await selectedAssets(db, connection.id);
    const results = [];
    for (const asset of assets) results.push({ asset: asset.name, ...(await def.sync(makeCtx(db, def, connection, asset, job.id, mode))) });
    await db.query(
      `UPDATE connections SET status = 'active', last_success_at = now(), last_error = NULL, consecutive_failures = 0,
              settings = CASE WHEN $2 THEN settings || jsonb_build_object('lastReconcileAt', now()) ELSE settings END, updated_at = now()
        WHERE id = $1`,
      [connection.id, mode === "reconcile"],
    );
    await complete(db, job.id, { mode, results });
    await notify(db, connection.business_id, "data_updated", { connectionId: connection.id });
    await notify(db, connection.business_id, "connection_updated", { connectionId: connection.id });
    if (mode === "initial") {
      await audit(db, { workspaceId: connection.workspace_id, businessId: connection.business_id, actorType: "system", action: "connection.initial_sync_completed", targetType: "connection", targetId: connection.id, metadata: { results } });
      if (def.registerWebhooks) await enqueue(db, { type: "connection.register_webhooks", workspaceId: connection.workspace_id, businessId: connection.business_id, connectionId: connection.id, dedupeKey: `hooks:${connection.id}` });
    }
  } catch (err) {
    await recordFailure(db, job, connection, err);
  }
}

async function webhookJob(db: pg.PoolClient, job: Job) {
  const { rows } = await db.query(`SELECT * FROM webhook_receipts WHERE id = $1`, [job.payload.receiptId]);
  const receipt = rows[0];
  // Processing is idempotent (records are upserted, days recomputed), so each connection subscribed to the store processes it.
  if (!receipt) return complete(db, job.id, { skipped: "receipt missing" });
  const connection = job.connection_id ? await loadConnection(db, job.connection_id) : null;
  const def = connection && getConnector(connection.provider);
  if (!connection || !def?.handleWebhook) {
    await db.query(`UPDATE webhook_receipts SET status = 'ignored', processed_at = now() WHERE id = $1`, [receipt.id]);
    return complete(db, job.id, { ignored: true });
  }
  try {
    let total = 0;
    for (const asset of await selectedAssets(db, connection.id)) {
      const r = await def.handleWebhook(makeCtx(db, def, connection, asset, job.id, "incremental"), { deliveryId: receipt.delivery_id, topic: receipt.topic, accountRef: receipt.account_ref, payload: receipt.payload });
      total += r.datesRecomputed;
    }
    await db.query(`UPDATE webhook_receipts SET status = 'processed', processed_at = now() WHERE id = $1`, [receipt.id]);
    await complete(db, job.id, { datesRecomputed: total });
    if (total) await notify(db, connection.business_id, "data_updated", { connectionId: connection.id, via: "webhook" });
  } catch (err) {
    await db.query(`UPDATE webhook_receipts SET error = $2 WHERE id = $1`, [receipt.id, (err as Error).message]);
    await recordFailure(db, job, connection, err);
  }
}

async function healthJob(db: pg.PoolClient, job: Job) {
  const connection = await loadConnection(db, job.connection_id!);
  const def = connection && getConnector(connection.provider);
  if (!connection || !def?.healthCheck) return complete(db, job.id, { skipped: true });
  const [asset] = await selectedAssets(db, connection.id);
  try {
    await def.healthCheck(makeCtx(db, def, connection, asset!, job.id, "incremental"));
    await db.query(`UPDATE connections SET settings = settings || jsonb_build_object('lastHealthCheckAt', now()) WHERE id = $1`, [connection.id]);
    if (connection.status === "error" || connection.status === "reauth_required") {
      await db.query(`UPDATE connections SET status = 'active', last_error = NULL WHERE id = $1`, [connection.id]);
      await notify(db, connection.business_id, "connection_updated", { connectionId: connection.id });
    }
    await complete(db, job.id, { healthy: true });
  } catch (err) {
    await recordFailure(db, job, connection, err);
  }
}

async function registerWebhooksJob(db: pg.PoolClient, job: Job) {
  const connection = await loadConnection(db, job.connection_id!);
  const def = connection && getConnector(connection.provider);
  if (!connection || !def?.registerWebhooks) return complete(db, job.id, { skipped: true });
  const [asset] = await selectedAssets(db, connection.id);
  const url = `${config.apiUrl}/api/webhooks/${connection.provider}`;
  try {
    const topics = await def.registerWebhooks(makeCtx(db, def, connection, asset!, job.id, "incremental"), url);
    await db.query(`UPDATE connections SET settings = settings || jsonb_build_object('webhookTopics', $2::jsonb, 'webhookUrl', $3::text) WHERE id = $1`, [connection.id, JSON.stringify(topics), topics.length ? url : null]);
    await complete(db, job.id, { topics, note: topics.length ? undefined : "Webhooks need a public HTTPS API_URL; using scheduled syncs instead." });
  } catch (err) {
    await recordFailure(db, job, connection, err);
  }
}
