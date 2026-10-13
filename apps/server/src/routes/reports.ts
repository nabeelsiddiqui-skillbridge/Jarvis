import { Router } from "express";
import { z } from "zod";
import { formatMetricValue, type MetricUnit, type Report, type ReportSummary } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { withSystem } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { buildReport, reportPeriod, saveReport } from "../reports/build.js";

/** Reports and briefings: list, view, generate now, export (permission-controlled), delete. */
export const reportsRouter = Router();
reportsRouter.use(requireUser);

const toSummary = (r: any): ReportSummary => ({ id: r.id, kind: r.kind, title: r.title, period: r.period, narrativeStatus: r.narrative_status, isDemo: r.is_demo, createdAt: r.created_at, createdBy: r.created_by_name ?? (r.automation_run_id ? "Automation" : null) });

reportsRouter.get("/businesses/:businessId/reports", async (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : null;
  const out = await inBusiness(req, req.params.businessId, "report.read", async ({ db, business }) => {
    const { rows } = await db.query(
      `SELECT r.id, r.kind, r.title, r.period, r.narrative_status, r.is_demo, r.created_at, r.automation_run_id, u.name AS created_by_name
         FROM reports r LEFT JOIN users u ON u.id = r.created_by WHERE r.business_id = $1 AND ($2::text IS NULL OR r.kind = $2) ORDER BY r.created_at DESC LIMIT 200`,
      [business.id, kind],
    );
    return rows.map(toSummary);
  });
  res.json(out);
});

async function load(db: import("pg").PoolClient, businessId: string, id: unknown) {
  if (!isUuid(id)) throw notFound("Report");
  const r = (await db.query(`SELECT r.*, u.name AS created_by_name FROM reports r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1 AND r.business_id = $2`, [id, businessId])).rows[0];
  if (!r) throw notFound("Report");
  return r;
}

reportsRouter.get("/businesses/:businessId/reports/latest-briefing", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "report.read", async ({ db, business }) => {
    const r = (await db.query(`SELECT r.*, NULL AS created_by_name FROM reports r WHERE r.business_id = $1 AND r.kind = 'daily_briefing' ORDER BY r.created_at DESC LIMIT 1`, [business.id])).rows[0];
    const automation = (await db.query(`SELECT id, enabled, next_run_at FROM automations WHERE business_id = $1 AND kind = 'daily_briefing' ORDER BY enabled DESC, created_at LIMIT 1`, [business.id])).rows[0] ?? null;
    return { report: r ? ({ ...toSummary(r), comparison: r.comparison, content: r.content, narrative: r.narrative } as Report) : null, automation };
  });
  res.json(out);
});

reportsRouter.get("/businesses/:businessId/reports/:reportId", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "report.read", async ({ db, business }) => {
    const r = await load(db, business.id, req.params.reportId);
    return { ...toSummary(r), comparison: r.comparison, content: r.content, narrative: r.narrative } as Report;
  });
  res.json(out);
});

const generateBody = z.object({
  kind: z.enum(["daily_briefing", "weekly_report", "custom"]),
  period: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).optional(),
});

reportsRouter.post("/businesses/:businessId/reports", rateLimit({ name: "report-generate", max: 10, windowMs: 60_000, key: (r) => r.user?.id ?? r.ip ?? "" }), async (req, res) => {
  const body = generateBody.parse(req.body);
  if (body.kind === "custom" && (!body.period || body.period.from > body.period.to)) throw badRequest("Choose a valid period for a custom report.");
  if (body.period && (Date.parse(body.period.to) - Date.parse(body.period.from)) / 86_400_000 > 366) throw badRequest("Reports cover at most one year.");
  const business = await inBusiness(req, req.params.businessId, "report.write", async ({ db, business, userId }) => {
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "report.generated", targetType: "report", metadata: { kind: body.kind } });
    return business;
  });
  const { period, label } = reportPeriod(body.kind, business.timezone, body.period);
  const id = await withSystem(async (db) => saveReport(db, business, body.kind, period, await buildReport(db, business, body.kind, period, label), { createdBy: req.user!.id }));
  res.status(201).json({ id });
});

reportsRouter.delete("/businesses/:businessId/reports/:reportId", async (req, res) => {
  await inBusiness(req, req.params.businessId, "report.write", async ({ db, business, userId }) => {
    const r = await load(db, business.id, req.params.reportId);
    await db.query(`DELETE FROM reports WHERE id = $1`, [r.id]);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "report.deleted", targetType: "report", targetId: r.id });
  });
  res.json({ ok: true });
});

/** CSV export of a report's figures. Requires the data export permission and is audited. */
reportsRouter.get("/businesses/:businessId/reports/:reportId/export.csv", async (req, res) => {
  const csv = await inBusiness(req, req.params.businessId, "data.export", async ({ db, business, userId }) => {
    const r = await load(db, business.id, req.params.reportId);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "report.exported", targetType: "report", targetId: r.id });
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
    const lines = [["evidence_id", "metric", "period_from", "period_to", "value", "formatted", "comparison_value", "change_pct", "availability", "sources", "limitations"].join(",")];
    for (const e of r.content.headline ?? []) {
      lines.push([e.id, e.metric.label, e.range.from, e.range.to, e.total, formatMetricValue(e.total, e.metric.unit as MetricUnit, e.currency), e.comparisonTotal, e.change == null ? "" : e.change.toFixed(2), e.availability,
        e.sources.map((s: any) => `${s.provider}:${s.assetName ?? s.accountName}`).join("; "), e.limitations.join(" | ")].map(esc).join(","));
    }
    return `${r.is_demo ? "# DEMO BUSINESS - sample data\n" : ""}${lines.join("\n")}\n`;
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="report-${String(req.params.reportId).slice(0, 8)}.csv"`);
  res.send(csv);
});
