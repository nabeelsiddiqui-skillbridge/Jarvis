import express, { Router } from "express";
import { pool, withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { getConnector } from "../connectors/registry.js";
import { enqueue } from "../jobs/queue.js";

/**
 * Inbound provider webhooks. Signature is verified on the raw body, each delivery
 * is recorded once (unique provider delivery id), then processed asynchronously by
 * the worker so the provider gets a fast 200. Duplicate deliveries are acknowledged
 * and ignored.
 */
export const webhooksRouter = Router();

webhooksRouter.post("/webhooks/:provider", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const provider = String(req.params.provider);
  const def = getConnector(provider);
  (req as any).rawBody = req.body;
  const hook = def?.verifyWebhook?.(req as any);
  if (!def || !hook) return res.status(401).json({ error: { code: "invalid_signature", message: "Invalid webhook signature." } });

  const connections = await pool.query(
    `SELECT id, workspace_id, business_id FROM connections WHERE provider = $1 AND external_account_id = $2 AND NOT is_demo`,
    [provider, hook.accountRef],
  );
  const first = connections.rows[0];
  const inserted = await pool.query(
    `INSERT INTO webhook_receipts (provider, delivery_id, topic, account_ref, connection_id, business_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (provider, delivery_id) DO NOTHING RETURNING id`,
    [provider, hook.deliveryId, hook.topic, hook.accountRef, first?.id ?? null, first?.business_id ?? null, JSON.stringify(hook.payload)],
  );
  if (!inserted.rows[0]) return res.status(200).json({ ok: true, duplicate: true });
  const receiptId = inserted.rows[0].id as string;

  await withSystem(async (db) => {
    if (provider === "shopify" && (await handleShopifyLifecycle(db, hook.topic, hook.accountRef, hook.payload, receiptId))) return;
    if (!connections.rowCount) {
      await db.query(`UPDATE webhook_receipts SET status = 'ignored', processed_at = now() WHERE id = $1`, [receiptId]);
      return;
    }
    for (const c of connections.rows) {
      await enqueue(db, { type: "connection.webhook", workspaceId: c.workspace_id, businessId: c.business_id, connectionId: c.id, payload: { receiptId }, priority: 4 });
    }
  });
  res.status(200).json({ ok: true });
});

/** Uninstall and mandatory privacy (compliance) topics. Returns true when fully handled. */
async function handleShopifyLifecycle(db: import("pg").PoolClient, topic: string, shop: string, payload: any, receiptId: string) {
  const conns = (await db.query(`SELECT id, workspace_id, business_id FROM connections WHERE provider = 'shopify' AND external_account_id = $1`, [shop])).rows;
  const done = () => db.query(`UPDATE webhook_receipts SET status = 'processed', processed_at = now() WHERE id = $1`, [receiptId]);
  if (topic === "app/uninstalled") {
    for (const c of conns) {
      await db.query(`UPDATE connections SET status = 'disconnected', disconnected_at = coalesce(disconnected_at, now()), credentials_enc = NULL, last_error = 'The app was uninstalled from the store.' WHERE id = $1`, [c.id]);
      await audit(db, { workspaceId: c.workspace_id, businessId: c.business_id, actorType: "system", action: "connection.uninstalled_by_provider", targetType: "connection", targetId: c.id });
      await db.query("SELECT app.notify_business($1, 'connection_updated', '{}')", [c.business_id]);
    }
    await done();
    return true;
  }
  if (topic === "customers/redact") {
    // We store only Shopify's opaque customer id on orders; remove it for the redacted customer.
    const gid = payload?.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : null;
    if (gid) await db.query(`UPDATE source_records SET payload = payload - 'customerId' WHERE provider = 'shopify' AND connection_id = ANY($1::uuid[]) AND payload->>'customerId' = $2`, [conns.map((c) => c.id), gid]);
    for (const c of conns) await audit(db, { workspaceId: c.workspace_id, businessId: c.business_id, actorType: "system", action: "privacy.customer_redacted", targetType: "connection", targetId: c.id });
    await done();
    return true;
  }
  if (topic === "shop/redact") {
    for (const c of conns) {
      await db.query(`DELETE FROM metric_facts WHERE connection_id = $1`, [c.id]);
      await db.query(`DELETE FROM source_records WHERE connection_id = $1`, [c.id]);
      await db.query(`UPDATE connections SET credentials_enc = NULL, status = 'disconnected', disconnected_at = coalesce(disconnected_at, now()) WHERE id = $1`, [c.id]);
      await audit(db, { workspaceId: c.workspace_id, businessId: c.business_id, actorType: "system", action: "privacy.shop_redacted", targetType: "connection", targetId: c.id });
    }
    await done();
    return true;
  }
  if (topic === "customers/data_request") {
    for (const c of conns) await audit(db, { workspaceId: c.workspace_id, businessId: c.business_id, actorType: "system", action: "privacy.customer_data_requested", targetType: "connection", targetId: c.id, metadata: { note: "Only opaque customer ids are stored; no customer data to export." } });
    await done();
    return true;
  }
  return false;
}
