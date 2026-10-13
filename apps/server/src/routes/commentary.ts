import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { dateRangeSpec, widgetQuery, type MetricEvidence } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { notFound, prerequisite } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { getDashboard } from "../dashboards/store.js";
import { loadAvailability, loadCalcs, runQuery } from "../metrics/engine.js";
import { toMetricEvidence } from "../metrics/evidence.js";
import { NARRATIVE_RULES, aiConfigured, aiText } from "../ai/complete.js";

/**
 * AI commentary widget: a short summary of what the dashboard's own widgets
 * show, citing each widget's evidence. Cached per dashboard version, date range
 * and data freshness, so it's regenerated only when something changed.
 */
export const commentaryRouter = Router();
commentaryRouter.use(requireUser);

commentaryRouter.get("/businesses/:businessId/dashboards/:dashboardId/commentary", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business, userId, role }) => {
    if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
    await getDashboard(db, business.id, String(req.params.dashboardId), userId, role); // access check
    const r = (await db.query(`SELECT id, text, evidence, model, created_at, cache_key FROM dashboard_commentary WHERE dashboard_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.dashboardId])).rows[0];
    return { commentary: r ? { id: r.id, text: r.text, evidence: r.evidence, createdAt: r.created_at, cacheKey: r.cache_key } : null, aiConfigured: aiConfigured() };
  });
  res.json(out);
});

commentaryRouter.post(
  "/businesses/:businessId/dashboards/:dashboardId/commentary",
  rateLimit({ name: "commentary", max: 12, windowMs: 60_000, key: (r) => r.user?.id ?? r.ip ?? "" }),
  async (req, res) => {
    const body = z.object({ dateRange: dateRangeSpec.optional() }).parse(req.body ?? {});
    const out = await inBusiness(req, req.params.businessId, "dashboard.read", async ({ db, business, userId, role }) => {
      if (!isUuid(req.params.dashboardId)) throw notFound("Dashboard");
      const d = await getDashboard(db, business.id, String(req.params.dashboardId), userId, role);
      const range = body.dateRange ?? d.spec.dateRange;
      const ctx = { db, business, availability: await loadAvailability(db, business), calcs: await loadCalcs(db, business.id), dashboardRange: range };
      const evidence: MetricEvidence[] = [];
      for (const w of d.spec.widgets.filter((x) => x.query).slice(0, 12)) {
        const q = widgetQuery.parse({ ...w.query, granularity: "none", limit: Math.min(w.query!.limit, 8) });
        const r = await runQuery(ctx, q);
        evidence.push(toMetricEvidence(`C${evidence.length + 1}`, r, q, w.title));
      }
      if (!evidence.length) return { commentary: null, reason: "Add widgets with metrics to this dashboard to get commentary." };
      const fresh = evidence.map((e) => e.freshness.lastSyncedAt ?? "").sort().pop();
      const cacheKey = createHash("sha256").update(JSON.stringify([d.version, evidence[0]!.range, fresh, evidence.map((e) => e.total)])).digest("hex").slice(0, 32);
      const cached = (await db.query(`SELECT id, text, evidence, created_at FROM dashboard_commentary WHERE dashboard_id = $1 AND cache_key = $2`, [d.id, cacheKey])).rows[0];
      if (cached) return { commentary: { id: cached.id, text: cached.text, evidence: cached.evidence, createdAt: cached.created_at, cacheKey }, cached: true };
      if (!aiConfigured()) throw prerequisite("AI commentary needs ANTHROPIC_API_KEY on the platform.");
      const payload = { business: { name: business.name, demo: business.is_demo }, dashboard: d.name, widgets: evidence.map((e) => ({ id: e.id, widget: e.question, metric: e.metric.label, unit: e.metric.unit, currency: e.currency, period: e.range, comparison: e.comparisonRange, availability: e.availability, total: e.total, comparison_total: e.comparisonTotal, change_pct: e.change == null ? null : Math.round(e.change * 10) / 10, breakdown: e.rows?.slice(0, 5), limitations: e.limitations })) };
      const ai = await aiText({ system: `${NARRATIVE_RULES}\n\nTask: in at most 110 words, summarize what this dashboard shows for the period: the most important movements first, then anything that needs attention. Cite widget evidence ids (C1, C2…).`, user: JSON.stringify(payload), maxTokens: 2500 });
      const id = randomUUID();
      await db.query(`INSERT INTO dashboard_commentary (id, dashboard_id, business_id, cache_key, text, evidence, model, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dashboard_id, cache_key) DO NOTHING`,
        [id, d.id, business.id, cacheKey, ai.text, JSON.stringify(evidence), ai.model, userId]);
      return { commentary: { id, text: ai.text, evidence, createdAt: new Date().toISOString(), cacheKey }, cached: false };
    });
    res.json(out);
  },
);
