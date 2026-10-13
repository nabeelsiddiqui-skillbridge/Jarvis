import { Router } from "express";
import { availableBaseMetrics, loadAvailability } from "../metrics/engine.js";
import { requireUser } from "../auth/sessions.js";
import { inBusiness } from "../auth/access.js";
import { baseDependencies } from "@bca/shared";

export const overviewRouter = Router();
overviewRouter.use(requireUser);

/** KPI preferences per industry, most important first. Only metrics with data are returned. */
const KPI_PRIORITY: Record<string, string[]> = {
  ecommerce: ["store_net_sales", "store_orders", "aov", "mer", "sessions", "conversion_rate", "ad_spend", "roas", "organic_clicks", "store_new_customers"],
  saas: ["crm_won_value", "crm_open_pipeline", "crm_qualified_leads", "win_rate", "sessions", "conversion_rate", "ad_spend", "cpa", "organic_clicks"],
  b2b: ["crm_won_value", "crm_open_pipeline", "crm_qualified_leads", "win_rate", "sessions", "key_events", "ad_spend", "cpa", "organic_clicks"],
  agency: ["crm_won_value", "crm_open_pipeline", "crm_qualified_leads", "sessions", "key_events", "ad_spend", "roas", "organic_clicks"],
  local_services: ["crm_qualified_leads", "key_events", "sessions", "ad_spend", "cpa", "organic_clicks", "crm_won_value"],
  default: ["store_net_sales", "crm_won_value", "sessions", "key_events", "conversion_rate", "ad_spend", "roas", "organic_clicks", "crm_open_pipeline"],
};

const TRENDS: Record<string, string[]> = {
  revenue: ["store_net_sales", "crm_won_value", "ga4_revenue"],
  acquisition: ["sessions", "organic_clicks", "ad_clicks", "crm_new_contacts"],
};

const QUESTIONS: Record<string, string[]> = {
  ecommerce: ["How is my business doing this month?", "Which products generated the most revenue?", "Compare ad channels over the last 30 days.", "What is my marketing efficiency ratio trend?"],
  default: ["How is my business doing this month?", "Why have qualified leads declined?", "Summarize outstanding CRM opportunities.", "Compare ad channels over the last 30 days."],
};

overviewRouter.get("/businesses/:businessId/overview", async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "business.read", async ({ db, business, role }) => {
    const av = await loadAvailability(db, business);
    const available = availableBaseMetrics(av);
    const has = (k: string) => baseDependencies(k).every((d) => available.has(d));
    const kpis = (KPI_PRIORITY[business.industry] ?? KPI_PRIORITY.default!).filter(has).slice(0, 8);
    const revenueTrend = TRENDS.revenue!.find(has) ?? null;
    const acquisitionTrend = TRENDS.acquisition!.find(has) ?? null;
    const salesView = has("crm_open_pipeline") ? { type: "pipeline", metric: "crm_open_pipeline", dimension: "deal_stage" } : has("store_net_sales") ? { type: "ranking", metric: "store_net_sales", dimension: "product" } : null;
    const goals = await db.query("SELECT id, title, metric_key, target_value, period FROM business_goals WHERE business_id = $1 ORDER BY created_at", [business.id]);
    const activity = role === "owner" || role === "admin"
      ? await db.query(
          `SELECT a.action, a.created_at, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE a.business_id = $1 ORDER BY a.created_at DESC LIMIT 8`,
          [business.id],
        )
      : { rows: [] };
    return {
      isDemo: business.is_demo,
      kpis,
      revenueTrend,
      acquisitionTrend,
      salesView,
      sources: av.sources,
      goals: goals.rows.map((g) => ({ id: g.id, title: g.title, metricKey: g.metric_key, targetValue: g.target_value, period: g.period, trackable: Boolean(g.metric_key && has(g.metric_key)) })),
      activity: activity.rows.map((a) => ({ action: a.action, at: a.created_at, actor: a.actor })),
      suggestedQuestions: QUESTIONS[business.industry] ?? QUESTIONS.default,
    };
  });
  res.json(out);
});
