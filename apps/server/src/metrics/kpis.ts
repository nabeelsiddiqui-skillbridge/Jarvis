/** KPI preferences per industry, most important first. Callers keep only metrics with data. */
export const KPI_PRIORITY: Record<string, string[]> = {
  ecommerce: ["store_net_sales", "store_orders", "aov", "mer", "sessions", "conversion_rate", "ad_spend", "roas", "organic_clicks", "store_new_customers"],
  saas: ["crm_won_value", "crm_open_pipeline", "crm_qualified_leads", "win_rate", "sessions", "conversion_rate", "ad_spend", "cpa", "organic_clicks"],
  b2b: ["crm_won_value", "crm_open_pipeline", "crm_qualified_leads", "win_rate", "sessions", "key_events", "ad_spend", "cpa", "organic_clicks"],
  agency: ["crm_won_value", "crm_open_pipeline", "crm_qualified_leads", "sessions", "key_events", "ad_spend", "roas", "organic_clicks"],
  local_services: ["crm_qualified_leads", "key_events", "sessions", "ad_spend", "cpa", "organic_clicks", "crm_won_value"],
  default: ["store_net_sales", "crm_won_value", "sessions", "key_events", "conversion_rate", "ad_spend", "roas", "organic_clicks", "crm_open_pipeline"],
};
export const kpisFor = (industry: string) => KPI_PRIORITY[industry] ?? KPI_PRIORITY.default!;
