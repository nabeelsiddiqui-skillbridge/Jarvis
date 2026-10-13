import { pool } from "../db/pool.js";
import { getConnector } from "../connectors/registry.js";
import { enqueue, recoverStuck } from "./queue.js";

/**
 * Periodic work, safe to run from several workers (dedupe keys collapse duplicates):
 *  - incremental syncs when a connection is due (provider sync interval)
 *  - daily reconciliation that re-imports recent days to catch late changes
 *  - daily health checks
 *  - lease recovery for jobs whose worker died
 */
export async function scheduleDueWork() {
  await recoverStuck();
  const { rows } = await pool.query(
    `SELECT id, workspace_id, business_id, provider, last_success_at, last_sync_started_at, status, settings
       FROM connections WHERE disconnected_at IS NULL AND NOT is_demo AND status IN ('active', 'error', 'syncing')`,
  );
  const now = Date.now();
  for (const c of rows) {
    const def = getConnector(c.provider);
    if (!def) continue;
    const last = c.last_success_at ? new Date(c.last_success_at).getTime() : 0;
    const base = { workspaceId: c.workspace_id, businessId: c.business_id, connectionId: c.id };
    if (now - last > def.syncIntervalMinutes * 60_000) {
      await enqueue(pool, { ...base, type: "connection.sync", payload: { mode: "incremental" }, dedupeKey: `sync:${c.id}` });
    }
    const lastReconcile = c.settings?.lastReconcileAt ? new Date(c.settings.lastReconcileAt).getTime() : last;
    if (now - lastReconcile > 24 * 3_600_000) {
      await enqueue(pool, { ...base, type: "connection.sync", payload: { mode: "reconcile" }, dedupeKey: `sync:${c.id}`, priority: -1 });
    }
    const lastHealth = c.settings?.lastHealthCheckAt ? new Date(c.settings.lastHealthCheckAt).getTime() : 0;
    if (now - lastHealth > 24 * 3_600_000) {
      await enqueue(pool, { ...base, type: "connection.health", dedupeKey: `health:${c.id}`, priority: -2 });
    }
  }
}
