import { pool } from "../db/pool.js";
import { audit } from "./audit.js";

/**
 * Data retention (Workspace settings → Data retention). Deletes, per workspace,
 * imported source records, conversations, finished job history, webhook receipts
 * and read notifications older than the configured window (open CRM deals are kept:
 * they're current state). Aggregated metrics for purged days are frozen, not recomputed;
 * dashboards, reports, billing usage and audit logs are kept. Deletes run in
 * batches so a large backlog never holds long locks.
 */
const BATCH = 5000;
const MAX_BATCHES = 40;
/**
 * A record is purged only when both its event time and its last change at the source are older
 * than the window (greatest() ignores NULLs). Records still describing current state are kept regardless of age (open CRM deals feed the live pipeline). */
const KEEP = `AND NOT (provider = 'hubspot' AND record_type = 'deal' AND payload->>'status' = 'open')`;

async function batched(sql: string, params: unknown[]) {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await pool.query(sql, params);
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < BATCH) break;
  }
  return total;
}

export async function purgeExpiredData(now = new Date()) {
  const { rows } = await pool.query(`SELECT id, data_retention_days FROM workspaces`);
  const results: { workspaceId: string; deleted: Record<string, number> }[] = [];
  for (const w of rows) {
    const cutoff = new Date(now.getTime() - w.data_retention_days * 86_400_000);
    const p = [w.id, cutoff];
    // Freeze recomputation of purged days first, and keep each Shopify customer's first order.
    await pool.query(
      `UPDATE connection_assets a SET purged_before = greatest(coalesce(a.purged_before, '-infinity'::date), ($2::timestamptz)::date + 2)
        WHERE EXISTS (SELECT 1 FROM source_records r WHERE r.asset_id = a.id AND r.workspace_id = $1 AND greatest(r.occurred_at, r.source_updated_at) < $2 ${KEEP})`, p);
    await pool.query(
      `INSERT INTO customer_first_orders (asset_id, customer_id, first_at)
       SELECT asset_id, payload->>'customerId', min(occurred_at) FROM source_records
        WHERE workspace_id = $1 AND greatest(occurred_at, source_updated_at) < $2 AND provider = 'shopify' AND record_type = 'order' AND payload->>'customerId' IS NOT NULL
          AND NOT coalesce((payload->>'test')::boolean, false) AND NOT coalesce((payload->>'cancelled')::boolean, false)
        GROUP BY 1, 2
       ON CONFLICT (asset_id, customer_id) DO UPDATE SET first_at = least(customer_first_orders.first_at, excluded.first_at)`, p);
    const deleted = {
      sourceRecords: await batched(
        `DELETE FROM source_records WHERE ctid IN (SELECT ctid FROM source_records WHERE workspace_id = $1 AND greatest(occurred_at, source_updated_at) < $2 ${KEEP} LIMIT ${BATCH})`, p),
      conversations: await batched(
        `DELETE FROM conversations WHERE id IN (SELECT id FROM conversations WHERE workspace_id = $1 AND updated_at < $2 LIMIT ${BATCH})`, p),
      jobs: await batched(
        `DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE workspace_id = $1 AND status IN ('succeeded', 'failed', 'cancelled') AND coalesce(finished_at, created_at) < $2 LIMIT ${BATCH})`, p),
      webhookReceipts: await batched(
        `DELETE FROM webhook_receipts WHERE id IN (SELECT r.id FROM webhook_receipts r JOIN businesses b ON b.id = r.business_id WHERE b.workspace_id = $1 AND r.received_at < $2 LIMIT ${BATCH})`, p),
      notifications: await batched(
        `DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE workspace_id = $1 AND read_at IS NOT NULL AND created_at < $2 LIMIT ${BATCH})`, p),
    };
    if (Object.values(deleted).some((n) => n > 0)) {
      await audit(pool, { workspaceId: w.id, actorType: "system", action: "retention.purged", metadata: { retentionDays: w.data_retention_days, cutoff: cutoff.toISOString(), deleted } });
      results.push({ workspaceId: w.id, deleted });
    }
  }
  return results;
}
