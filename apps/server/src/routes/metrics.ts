import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  CalcError,
  DIMENSIONS,
  INTERNAL_METRICS,
  METRICS,
  baseDependencies,
  calcRefs,
  dateRangeSpec,
  getMetric,
  parseCalc,
  widgetQuery,
  type BaseMetric,
} from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { availableBaseMetrics, loadAvailability, loadCalcs, runQuery } from "../metrics/engine.js";
import { PROVIDER_META } from "../metrics/providers.js";

export const metricsRouter = Router();
metricsRouter.use(requireUser);

/** Every metric with its definition and whether this business has the data for it. */
metricsRouter.get("/businesses/:businessId/metrics/catalog", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business }) => {
    const av = await loadAvailability(db, business);
    const available = availableBaseMetrics(av);
    const calcs = await loadCalcs(db, business.id);
    const metrics = METRICS.filter((m) => !INTERNAL_METRICS.has(m.key)).map((m) => {
      const deps = baseDependencies(m.key);
      const missing = deps.filter((d) => !available.has(d));
      return {
        key: m.key,
        label: m.label,
        description: m.description,
        unit: m.unit,
        category: m.category,
        kind: m.kind,
        family: m.family ?? null,
        dimensions: m.dimensions,
        sources: [...new Set(deps.flatMap((d) => (getMetric(d) as BaseMetric).sources))],
        available: missing.length === 0,
        missing: missing.map((d) => ({ metric: d, label: getMetric(d)?.label, needs: (getMetric(d) as BaseMetric).sources.map((p) => PROVIDER_META[p]?.name ?? p) })),
        coverage: deps.length ? { from: deps.map((d) => av.providers.get(d)?.[0]?.minDate).filter(Boolean).sort().pop() ?? null, to: deps.map((d) => av.providers.get(d)?.[0]?.maxDate).filter(Boolean).sort().shift() ?? null } : null,
      };
    });
    const calculated = [...calcs.values()].map((c) => {
      const refs = calcRefs(c.ast);
      const deps = [...new Set(refs.flatMap((r) => baseDependencies(r)))];
      return {
        key: `calc:${c.id}`,
        label: c.name,
        description: c.description ?? c.expression,
        expression: c.expression,
        unit: c.unit,
        category: "calculated",
        kind: "calculated",
        dimensions: refs.map((r) => getMetric(r)?.dimensions ?? []).reduce((a, b) => a.filter((d) => b.includes(d))),
        available: deps.every((d) => available.has(d)),
        missing: deps.filter((d) => !available.has(d)).map((d) => ({ metric: d, label: getMetric(d)?.label })),
      };
    });
    return { metrics, calculated, dimensions: DIMENSIONS, sources: av.sources, isDemo: business.is_demo };
  });
  res.json(out);
});

const queryBody = z.object({
  query: widgetQuery,
  dashboardRange: dateRangeSpec.optional(),
});

metricsRouter.post("/businesses/:businessId/metrics/query", async (req, res) => {
  const body = queryBody.parse(req.body);
  const result = await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business }) => {
    const ctx = {
      db,
      business,
      availability: await loadAvailability(db, business),
      calcs: await loadCalcs(db, business.id),
      dashboardRange: body.dashboardRange ?? { preset: "last_30_days" as const },
    };
    if (body.query.metric.startsWith("calc:") && !ctx.calcs.has(body.query.metric.slice(5))) throw notFound("Calculated metric");
    return runQuery(ctx, body.query);
  });
  res.json(result);
});

// ------------------------------------------------------------------ calculated metrics

const calcInput = z.object({
  name: z.string().trim().min(1).max(80),
  expression: z.string().trim().min(1).max(500),
  unit: z.enum(["currency", "count", "percent", "multiplier", "number"]),
  description: z.string().trim().max(300).optional(),
});

/** Validate without saving (used by the editor for live feedback). */
metricsRouter.post("/businesses/:businessId/calculated-metrics/validate", async (req, res) => {
  const body = z.object({ expression: z.string().max(500) }).parse(req.body);
  await inBusiness(req, req.params.businessId, "dashboard.read", async () => undefined);
  try {
    const ast = parseCalc(body.expression);
    res.json({ ok: true, refs: calcRefs(ast) });
  } catch (e) {
    res.json({ ok: false, error: e instanceof CalcError ? e.message : "Invalid formula" });
  }
});

metricsRouter.post("/businesses/:businessId/calculated-metrics", async (req, res) => {
  const body = calcInput.parse(req.body);
  let ast;
  try {
    ast = parseCalc(body.expression);
  } catch (e) {
    throw badRequest(e instanceof CalcError ? e.message : "Invalid formula");
  }
  const row = await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId }) => {
    const rows = [{ id: randomUUID() }];
    await db.query(
      `INSERT INTO calculated_metrics (id, workspace_id, business_id, name, expression, ast, unit, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [rows[0]!.id, business.workspace_id, business.id, body.name, body.expression, JSON.stringify(ast), body.unit, body.description ?? null, userId],
    );
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "metric.calculated_created", targetType: "calculated_metric", targetId: rows[0].id, metadata: { name: body.name, expression: body.expression } });
    return rows[0];
  });
  res.status(201).json({ id: row.id, key: `calc:${row.id}` });
});

metricsRouter.delete("/businesses/:businessId/calculated-metrics/:id", async (req, res) => {
  await inBusiness(req, req.params.businessId, "dashboard.write", async ({ db, business, userId }) => {
    if (!isUuid(req.params.id)) throw notFound("Calculated metric");
    const used = await db.query(`SELECT count(*)::int AS n FROM dashboard_widgets WHERE business_id = $1 AND (query->>'metric' = $2 OR query->'metrics' ? $2)`, [business.id, `calc:${req.params.id}`]);
    if (used.rows[0].n) throw badRequest(`This metric is used by ${used.rows[0].n} widget(s). Remove them first.`);
    await db.query("DELETE FROM calculated_metrics WHERE id = $1 AND business_id = $2", [req.params.id, business.id]);
    await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "metric.calculated_deleted", targetType: "calculated_metric", targetId: String(req.params.id) });
  });
  res.json({ ok: true });
});
