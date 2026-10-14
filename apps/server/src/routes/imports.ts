import express, { Router } from "express";
import { z } from "zod";
import { addDays, todayIn } from "@bca/shared";
import { withSystem } from "../db/pool.js";
import { requireUser } from "../auth/sessions.js";
import { inBusiness } from "../auth/access.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { assertWithinLimit } from "../billing/entitlements.js";
import { enqueue } from "../jobs/queue.js";
import { storeTable } from "../connectors/sheets/csv.js";
import { TableError, importableMetrics, parseCsvTable } from "../connectors/sheets/parse.js";
import type { AssetRow, ConnectionRow } from "../connectors/types.js";

/**
 * Manual data import: CSV upload of daily figures (see connectors/sheets/parse.ts for the format).
 * An upload creates a "csv" connection with one asset named after the file — or, with
 * `connectionId`, replaces that connection's data — stores the parsed rows and queues a sync
 * that rewrites the connection's facts from them.
 */
export const importsRouter = Router();

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
/** Mounted before the global 1 MB JSON parser so uploads up to 5 MB (plus JSON overhead) fit. */
export const importsBodyParser = express.json({ limit: "6mb" });

importsRouter.get("/businesses/:businessId/imports/columns", requireUser, async (req, res) => {
  await inBusiness(req, req.params.businessId, "connection.read", async () => undefined);
  res.json(importableMetrics("csv").map((m) => ({ key: m.key, label: m.label, unit: m.unit, aggregation: m.aggregation, category: m.category })));
});

const TEMPLATE_COLUMNS = ["store_net_sales", "store_orders", "ad_spend", "acct_revenue", "acct_operating_expenses"];

importsRouter.get("/businesses/:businessId/imports/csv/template", requireUser, async (req, res) => {
  const business = await inBusiness(req, req.params.businessId, "connection.read", async ({ business }) => business);
  const today = todayIn(business.timezone);
  const lines = [
    ["date", ...TEMPLATE_COLUMNS].join(","),
    [addDays(today, -2), "1250.00", "18", "210.50", "1300.00", "640.00"].join(","),
    [addDays(today, -1), "980.40", "15", "195.00", "1010.00", "602.25"].join(","),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="daily-figures-template.csv"');
  res.send(`${lines.join("\r\n")}\r\n`);
});

const uploadBody = z.object({
  fileName: z.string().trim().min(1, "fileName is required").max(200),
  content: z.string().min(1, "The file is empty.").max(MAX_CSV_BYTES, "The file is larger than 5 MB."),
  connectionId: z.uuid().optional(),
});

const perUser = rateLimit({ name: "csv-upload", max: 20, windowMs: 10 * 60_000, key: (r) => r.user?.id ?? r.ip ?? "anon" });

importsRouter.post("/businesses/:businessId/imports/csv", requireUser, perUser, async (req, res) => {
  const parsed = uploadBody.safeParse(req.body);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join(" "));
  const body = parsed.data;
  if (Buffer.byteLength(body.content, "utf8") > MAX_CSV_BYTES) throw badRequest("The file is larger than 5 MB.");
  const name = body.fileName.replace(/[\u0000-\u001f]/g, "").slice(0, 120) || "Uploaded file";

  const out = await inBusiness(req, req.params.businessId, "connection.manage", async ({ business, userId }) => {
    if (business.is_demo) throw badRequest("Demo businesses can't import data. Create a real business first.");
    let table;
    try {
      table = parseCsvTable(body.content, { provider: "csv", defaultCurrency: business.currency });
    } catch (e) {
      if (e instanceof TableError) throw badRequest(e.problems.join(" "), { problems: e.problems });
      throw e;
    }
    if (!body.connectionId) await assertWithinLimit(business.workspace_id, "connections");

    return withSystem(async (db) => {
      let connection: ConnectionRow;
      if (body.connectionId) {
        const c = await db.query(`SELECT * FROM connections WHERE id = $1 AND business_id = $2 AND provider = 'csv' AND disconnected_at IS NULL`, [body.connectionId, business.id]);
        if (!c.rows[0]) throw notFound("Connection");
        connection = (await db.query(`UPDATE connections SET display_name = $2, status = 'syncing', last_error = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [body.connectionId, name])).rows[0];
      } else {
        connection = (await db.query(
          `INSERT INTO connections (workspace_id, business_id, provider, display_name, status, scopes, settings, created_by)
           VALUES ($1, $2, 'csv', $3, 'syncing', '{}', $4, $5) RETURNING *`,
          [business.workspace_id, business.id, name, JSON.stringify({ authMode: "upload" }), userId],
        )).rows[0];
      }
      const asset: AssetRow = (await db.query(
        `INSERT INTO connection_assets (workspace_id, business_id, connection_id, provider_asset_id, name, kind, currency, timezone, selected)
         VALUES ($1, $2, $3, 'upload', $4, 'file', $5, $6, true)
         ON CONFLICT (connection_id, provider_asset_id) DO UPDATE SET name = excluded.name, selected = true
         RETURNING *`,
        [business.workspace_id, business.id, connection.id, name, table.currency, business.timezone],
      )).rows[0];
      const job = await enqueue(db, { type: "connection.sync", workspaceId: business.workspace_id, businessId: business.id, connectionId: connection.id, payload: { mode: "initial" }, dedupeKey: `sync:${connection.id}`, priority: 5, createdBy: userId });
      await storeTable({ db, connection, asset, jobId: job.id }, table);
      await audit(db, {
        workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: body.connectionId ? "import.csv_replaced" : "import.csv_uploaded",
        targetType: "connection", targetId: connection.id, metadata: { fileName: name, rows: table.rows.length, metrics: table.metrics.map((m) => m.key), from: table.from, to: table.to },
      });
      await db.query("SELECT app.notify_business($1, 'connection_updated', $2)", [business.id, JSON.stringify({ connectionId: connection.id })]);
      return {
        connectionId: connection.id,
        rows: table.rows.length,
        metrics: table.metrics,
        from: table.from,
        to: table.to,
        ignoredColumns: table.ignoredColumns,
        warnings: table.warnings,
      };
    });
  });
  res.status(201).json(out);
});
