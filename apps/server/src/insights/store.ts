import type pg from "pg";
import type { Candidate } from "./detect.js";

/**
 * Persist detected insights (system role). Re-detecting the same finding updates
 * it in place (same dedupe key) instead of duplicating it; dismissed or resolved
 * findings stay closed. Data-health insights resolve themselves once the
 * connection recovers.
 */
export async function upsertInsights(db: pg.PoolClient, business: { id: string; workspace_id: string; is_demo: boolean }, found: Candidate[], automationId: string | null = null) {
  const created: string[] = [];
  for (const c of found) {
    const dash = c.metricKey
      ? (await db.query(
          `SELECT d.id FROM dashboards d JOIN dashboard_widgets w ON w.dashboard_id = d.id
            WHERE d.business_id = $1 AND d.visibility = 'business' AND (w.query->>'metric' = $2 OR w.query->'metrics' ? $2)
            ORDER BY d.updated_at DESC LIMIT 1`,
          [business.id, c.metricKey],
        )).rows[0]?.id ?? null
      : null;
    const { rows } = await db.query(
      `INSERT INTO insights (workspace_id, business_id, rule, dedupe_key, severity, title, finding, impact, next_step, metric_key, period, comparison, evidence, drivers, dashboard_id, is_demo, automation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (business_id, dedupe_key) DO UPDATE SET
         severity = excluded.severity, title = excluded.title, finding = excluded.finding, impact = excluded.impact, next_step = excluded.next_step,
         period = excluded.period, comparison = excluded.comparison, evidence = excluded.evidence, drivers = excluded.drivers,
         dashboard_id = COALESCE(excluded.dashboard_id, insights.dashboard_id), updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [business.workspace_id, business.id, c.rule, c.dedupeKey, c.severity, c.title, c.finding, c.impact, c.nextStep, c.metricKey,
        c.period && JSON.stringify(c.period), c.comparison && JSON.stringify(c.comparison), JSON.stringify(c.evidence), JSON.stringify(c.drivers), dash, business.is_demo, automationId],
    );
    if (rows[0].inserted) created.push(rows[0].id);
  }
  // Connection problems that are no longer detected are resolved automatically.
  const active = found.filter((c) => c.rule === "data_health").map((c) => c.dedupeKey);
  const resolved = await db.query(
    `UPDATE insights SET status = 'resolved', status_at = now(), updated_at = now()
      WHERE business_id = $1 AND rule = 'data_health' AND status IN ('open', 'acknowledged') AND NOT (dedupe_key = ANY($2::text[])) RETURNING id`,
    [business.id, active],
  );
  return { created, resolved: resolved.rowCount ?? 0 };
}

export function toInsight(r: any) {
  return {
    id: r.id, rule: r.rule, severity: r.severity, title: r.title, finding: r.finding, impact: r.impact, nextStep: r.next_step, metricKey: r.metric_key,
    period: r.period, comparison: r.comparison, evidence: r.evidence, drivers: r.drivers, dashboardId: r.dashboard_id,
    explanation: r.explanation, explanationStatus: r.explanation_status, status: r.status, statusBy: r.status_by_name ?? null, statusAt: r.status_at,
    isDemo: r.is_demo, detectedAt: r.detected_at, updatedAt: r.updated_at,
  };
}
