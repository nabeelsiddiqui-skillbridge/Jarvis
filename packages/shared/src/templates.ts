import { baseDependencies, getMetric, type DimensionId } from "./metrics.js";
import type { DashboardSpec, WidgetQueryInput, WidgetSpec, WidgetType } from "./widgets.js";
import { widgetSpec } from "./widgets.js";

/**
 * Dashboard templates. Instantiated against the metrics a business actually has,
 * so templates never contain widgets that can't show data — those are reported
 * back as `omitted` with the connection that would enable them.
 */

export interface Blueprint {
  type: WidgetType;
  title: string;
  query?: WidgetQueryInput;
  options?: Record<string, unknown>;
  w: number;
  h: number;
}

const kpi = (metric: string, title?: string): Blueprint => ({ type: "kpi", title: title ?? getMetric(metric)?.label ?? metric, query: { metric, granularity: "day" }, w: 3, h: 4 });
const trend = (metric: string, title?: string, type: WidgetType = "area"): Blueprint => ({ type, title: title ?? `${getMetric(metric)?.label} trend`, query: { metric, granularity: "day" }, w: 6, h: 8 });
const by = (type: WidgetType, metric: string, dimension: DimensionId, title: string, w = 6, h = 8): Blueprint => ({ type, title, query: { metric, dimension, limit: 10 }, w, h });

export const TEMPLATES: Record<string, { name: string; description: string; industries: string[]; widgets: Blueprint[] }> = {
  executive: {
    name: "Executive overview",
    description: "Headline sales, traffic, marketing efficiency and pipeline.",
    industries: ["*"],
    widgets: [
      kpi("store_net_sales"), kpi("store_orders"), kpi("aov"), kpi("mer"),
      kpi("sessions"), kpi("conversion_rate"), kpi("crm_open_pipeline"), kpi("crm_won_value"),
      trend("store_net_sales", "Store net sales"), trend("sessions", "Sessions", "line"),
      by("bar", "ad_spend", "campaign", "Ad spend by campaign"),
      by("pipeline", "crm_open_pipeline", "deal_stage", "Open pipeline by stage"),
      { type: "freshness", title: "Data freshness", w: 6, h: 6 },
    ],
  },
  ecommerce: {
    name: "Ecommerce performance",
    description: "Sales, orders, AOV, ad spend, MER and top products.",
    industries: ["ecommerce"],
    widgets: [
      kpi("store_net_sales"), kpi("store_orders"), kpi("aov"), kpi("ad_spend"), kpi("mer"), kpi("store_new_customers"),
      trend("store_net_sales", "Daily net sales"),
      { type: "funnel", title: "Shopping funnel", query: { metric: "sessions", metrics: ["add_to_carts", "checkouts", "ga4_purchases"] }, w: 6, h: 8 },
      by("ranking", "store_net_sales", "product", "Top products by net sales"),
      by("geo", "store_net_sales", "country", "Sales by country"),
      { type: "freshness", title: "Data freshness", w: 12, h: 5 },
    ],
  },
  marketing: {
    name: "Marketing & acquisition",
    description: "Traffic, channels, ad efficiency and conversion.",
    industries: ["*"],
    widgets: [
      kpi("sessions"), kpi("engagement_rate"), kpi("ad_spend"), kpi("roas"),
      trend("sessions", "Sessions over time", "line"),
      by("bar", "sessions", "channel", "Sessions by channel"),
      by("table", "ad_spend", "campaign", "Campaign performance", 12, 9),
      by("donut", "key_events", "channel", "Key events by channel"),
      by("bar", "cpa", "campaign", "Cost per conversion by campaign"),
    ],
  },
  seo: {
    name: "Organic search",
    description: "Clicks, impressions, CTR, position and top queries.",
    industries: ["*"],
    widgets: [
      kpi("organic_clicks"), kpi("organic_impressions"), kpi("organic_ctr"), kpi("avg_position"),
      trend("organic_clicks", "Organic clicks", "line"),
      by("ranking", "organic_clicks", "query", "Top queries"),
      by("table", "organic_clicks", "page", "Top landing pages", 12, 9),
    ],
  },
  sales: {
    name: "Sales pipeline",
    description: "Pipeline value, deal flow, win rate and qualified leads.",
    industries: ["saas", "b2b", "agency", "local_services"],
    widgets: [
      kpi("crm_open_pipeline"), kpi("crm_won_value"), kpi("win_rate"), kpi("crm_qualified_leads"),
      by("pipeline", "crm_open_pipeline", "deal_stage", "Pipeline by stage", 6, 8),
      trend("crm_qualified_leads", "Qualified leads", "bar"),
      by("bar", "crm_deals_won", "pipeline", "Deals won by pipeline"),
      by("bar", "crm_new_contacts", "source_medium", "New contacts by source"),
    ],
  },
};
export type TemplateId = keyof typeof TEMPLATES;

/** Pack blueprints into a 12-column grid, left to right. */
export function pack(blueprints: { w: number; h: number }[], startY = 0): { x: number; y: number; w: number; h: number }[] {
  let x = 0, y = startY, rowH = 0;
  return blueprints.map((b) => {
    if (x + b.w > 12) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const pos = { x, y, w: b.w, h: b.h };
    x += b.w;
    rowH = Math.max(rowH, b.h);
    return pos;
  });
}

export function blueprintMetrics(b: Blueprint): string[] {
  return b.query ? [b.query.metric, ...(b.query.metrics ?? [])] : [];
}

/**
 * Build a validated dashboard spec from blueprints, keeping only widgets whose
 * base metrics are all available. `available` is the set of base metric keys the
 * business has data for.
 */
export function instantiate(
  name: string,
  blueprints: Blueprint[],
  available: ReadonlySet<string>,
  makeId: () => string,
): { spec: DashboardSpec; omitted: { title: string; missing: string[] }[] } {
  const omitted: { title: string; missing: string[] }[] = [];
  const kept = blueprints.filter((b) => {
    const missing = [...new Set(blueprintMetrics(b).flatMap((k) => baseDependencies(k)))].filter((k) => !available.has(k));
    if (missing.length) omitted.push({ title: b.title, missing });
    return !missing.length;
  });
  const layout = pack(kept);
  const widgets: WidgetSpec[] = kept.map((b, i) => widgetSpec.parse({ id: makeId(), type: b.type, title: b.title, query: b.query ?? null, options: b.options ?? {}, layout: layout[i] }));
  return { spec: { name, description: "", dateRange: { preset: "last_30_days" }, widgets }, omitted };
}
