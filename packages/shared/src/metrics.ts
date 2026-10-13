/**
 * Metric definitions — the single source of truth for what every number means.
 *
 * Rules enforced by the query engine:
 *  - Base metrics are stored as daily facts by connectors; derived metrics are
 *    computed from *aggregated* numerators and denominators (never averaged ratios).
 *  - Revenue concepts live in separate families and are never added together:
 *    store sales (Shopify), analytics-observed revenue (GA4), ad-platform
 *    attributed conversion value (Google Ads), CRM won/pipeline value (HubSpot).
 *  - Profit is only computed when the cost input (COGS) is available.
 *  - Missing data is `null` (unavailable), never 0.
 */

export type MetricUnit = "currency" | "count" | "percent" | "ratio" | "multiplier" | "number" | "position";
export type MetricCategory = "sales" | "acquisition" | "advertising" | "seo" | "crm" | "profit";

/** Revenue/value families that must never be summed together. */
export type ValueFamily = "store_sales" | "analytics_revenue" | "ad_attributed" | "crm_won" | "crm_pipeline" | "cost";

export const PROVIDERS = {
  shopify: "Shopify",
  ga4: "Google Analytics 4",
  gsc: "Google Search Console",
  google_ads: "Google Ads",
  hubspot: "HubSpot",
  csv: "CSV upload",
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export const DIMENSIONS = {
  channel: "Channel",
  campaign: "Campaign",
  product: "Product",
  country: "Country",
  source_medium: "Source / medium",
  landing_page: "Landing page",
  query: "Search query",
  page: "Page",
  device: "Device",
  deal_stage: "Deal stage",
  pipeline: "Pipeline",
  lifecycle_stage: "Lifecycle stage",
} as const;
export type DimensionId = keyof typeof DIMENSIONS;

interface MetricBase {
  key: string;
  label: string;
  description: string;
  unit: MetricUnit;
  category: MetricCategory;
  higherIsBetter: boolean;
  family?: ValueFamily;
}

export interface BaseMetric extends MetricBase {
  kind: "base";
  /** sum: additive across days and dimension values. snapshot: value at end of period (e.g. open pipeline). */
  aggregation: "sum" | "snapshot";
  /** Providers able to supply the metric, in precedence order (first available wins; never summed across). */
  sources: ProviderId[];
  dimensions: DimensionId[];
}

export interface DerivedMetric extends MetricBase {
  kind: "derived";
  /** numerator / denominator × scale, a − b, or a + b — always evaluated on aggregated inputs. */
  formula:
    | { op: "ratio"; numerator: string; denominator: string; scale?: number }
    | { op: "difference"; minuend: string; subtrahend: string }
    | { op: "sum"; terms: string[] };
  dimensions: DimensionId[];
}

export type MetricDef = BaseMetric | DerivedMetric;

const base = (m: Omit<BaseMetric, "kind">): BaseMetric => ({ kind: "base", ...m });
const derived = (m: Omit<DerivedMetric, "kind">): DerivedMetric => ({ kind: "derived", ...m });

export const METRICS: MetricDef[] = [
  // ---------------------------------------------------------------- store (Shopify)
  base({ key: "store_net_sales", label: "Store net sales", unit: "currency", category: "sales", higherIsBetter: true, family: "store_sales", aggregation: "sum", sources: ["shopify", "csv"], dimensions: ["product", "country", "channel"],
    description: "Order line revenue after discounts and refunds, excluding taxes and shipping, for orders placed in the period (store reporting currency)." }),
  base({ key: "store_gross_sales", label: "Store gross sales", unit: "currency", category: "sales", higherIsBetter: true, family: "store_sales", aggregation: "sum", sources: ["shopify", "csv"], dimensions: ["product", "country", "channel"],
    description: "Order line revenue before discounts, refunds, taxes and shipping." }),
  base({ key: "store_refunds", label: "Store refunds", unit: "currency", category: "sales", higherIsBetter: false, family: "store_sales", aggregation: "sum", sources: ["shopify"], dimensions: ["product", "country"],
    description: "Value refunded on orders placed in the period." }),
  base({ key: "store_orders", label: "Orders", unit: "count", category: "sales", higherIsBetter: true, aggregation: "sum", sources: ["shopify", "csv"], dimensions: ["country", "channel"],
    description: "Number of orders placed (excluding cancelled and test orders)." }),
  base({ key: "store_units", label: "Units sold", unit: "count", category: "sales", higherIsBetter: true, aggregation: "sum", sources: ["shopify", "csv"], dimensions: ["product"],
    description: "Quantity of items sold, net of refunded quantities." }),
  base({ key: "store_new_customers", label: "New customers", unit: "count", category: "sales", higherIsBetter: true, aggregation: "sum", sources: ["shopify"], dimensions: ["country"],
    description: "Orders whose customer had no prior order (first-time buyers)." }),
  base({ key: "store_cogs", label: "Cost of goods sold", unit: "currency", category: "profit", higherIsBetter: false, family: "cost", aggregation: "sum", sources: ["shopify", "csv"], dimensions: ["product"],
    description: "Unit cost × units sold, only for products with a recorded cost. Required for profit metrics." }),
  derived({ key: "aov", label: "Average order value", unit: "currency", category: "sales", higherIsBetter: true, family: "store_sales", dimensions: ["country", "channel"],
    formula: { op: "ratio", numerator: "store_net_sales", denominator: "store_orders" },
    description: "Store net sales ÷ orders (both summed over the period)." }),
  derived({ key: "gross_profit", label: "Gross profit", unit: "currency", category: "profit", higherIsBetter: true, dimensions: ["product"],
    formula: { op: "difference", minuend: "store_net_sales", subtrahend: "store_cogs" },
    description: "Store net sales − cost of goods sold. Only shown when product costs are available." }),
  derived({ key: "gross_margin", label: "Gross margin", unit: "percent", category: "profit", higherIsBetter: true, dimensions: ["product"],
    formula: { op: "ratio", numerator: "gross_profit", denominator: "store_net_sales", scale: 100 },
    description: "Gross profit ÷ store net sales." }),

  // ---------------------------------------------------------------- analytics (GA4)
  base({ key: "sessions", label: "Sessions", unit: "count", category: "acquisition", higherIsBetter: true, aggregation: "sum", sources: ["ga4"], dimensions: ["channel", "source_medium", "country", "device", "landing_page"],
    description: "GA4 sessions." }),
  base({ key: "users", label: "Active users", unit: "count", category: "acquisition", higherIsBetter: true, aggregation: "sum", sources: ["ga4"], dimensions: ["channel", "country", "device"],
    description: "GA4 active users per day, summed across days (not de-duplicated across the period)." }),
  base({ key: "engaged_sessions", label: "Engaged sessions", unit: "count", category: "acquisition", higherIsBetter: true, aggregation: "sum", sources: ["ga4"], dimensions: ["channel", "source_medium", "device"],
    description: "GA4 sessions lasting 10s+, with a key event, or 2+ page views." }),
  base({ key: "key_events", label: "Key events (conversions)", unit: "count", category: "acquisition", higherIsBetter: true, aggregation: "sum", sources: ["ga4"], dimensions: ["channel", "source_medium", "landing_page"],
    description: "GA4 key events (formerly conversions)." }),
  base({ key: "add_to_carts", label: "Add-to-carts", unit: "count", category: "acquisition", higherIsBetter: true, aggregation: "sum", sources: ["ga4"], dimensions: ["channel"],
    description: "GA4 add_to_cart events." }),
  base({ key: "checkouts", label: "Checkouts started", unit: "count", category: "acquisition", higherIsBetter: true, aggregation: "sum", sources: ["ga4"], dimensions: ["channel"],
    description: "GA4 begin_checkout events." }),
  base({ key: "ga4_purchases", label: "Purchases (GA4)", unit: "count", category: "acquisition", higherIsBetter: true, aggregation: "sum", sources: ["ga4"], dimensions: ["channel", "source_medium"],
    description: "GA4 purchase events. Usually lower than store orders (consent, ad blockers)." }),
  base({ key: "ga4_revenue", label: "Purchase revenue (GA4)", unit: "currency", category: "acquisition", higherIsBetter: true, family: "analytics_revenue", aggregation: "sum", sources: ["ga4"], dimensions: ["channel", "source_medium"],
    description: "Revenue observed by GA4 purchase events. Not the same as store sales; never added to it." }),
  derived({ key: "conversion_rate", label: "Session conversion rate", unit: "percent", category: "acquisition", higherIsBetter: true, dimensions: ["channel", "source_medium", "landing_page"],
    formula: { op: "ratio", numerator: "key_events", denominator: "sessions", scale: 100 },
    description: "Key events ÷ sessions." }),
  derived({ key: "engagement_rate", label: "Engagement rate", unit: "percent", category: "acquisition", higherIsBetter: true, dimensions: ["channel", "source_medium", "device"],
    formula: { op: "ratio", numerator: "engaged_sessions", denominator: "sessions", scale: 100 },
    description: "Engaged sessions ÷ sessions." }),

  // ---------------------------------------------------------------- search (GSC)
  base({ key: "organic_clicks", label: "Organic clicks", unit: "count", category: "seo", higherIsBetter: true, aggregation: "sum", sources: ["gsc"], dimensions: ["query", "page", "country", "device"],
    description: "Clicks from Google Search results (Search Console, web search type)." }),
  base({ key: "organic_impressions", label: "Organic impressions", unit: "count", category: "seo", higherIsBetter: true, aggregation: "sum", sources: ["gsc"], dimensions: ["query", "page", "country", "device"],
    description: "Times a site URL appeared in Google Search results." }),
  base({ key: "organic_position_sum", label: "Position × impressions", unit: "number", category: "seo", higherIsBetter: false, aggregation: "sum", sources: ["gsc"], dimensions: ["query", "page", "country", "device"],
    description: "Internal helper: average position weighted by impressions, used to compute average position correctly." }),
  derived({ key: "organic_ctr", label: "Organic CTR", unit: "percent", category: "seo", higherIsBetter: true, dimensions: ["query", "page", "country", "device"],
    formula: { op: "ratio", numerator: "organic_clicks", denominator: "organic_impressions", scale: 100 },
    description: "Organic clicks ÷ organic impressions." }),
  derived({ key: "avg_position", label: "Average position", unit: "position", category: "seo", higherIsBetter: false, dimensions: ["query", "page", "country", "device"],
    formula: { op: "ratio", numerator: "organic_position_sum", denominator: "organic_impressions" },
    description: "Impression-weighted average ranking position (lower is better)." }),

  // ---------------------------------------------------------------- advertising (Google Ads)
  base({ key: "ad_spend", label: "Ad spend", unit: "currency", category: "advertising", higherIsBetter: false, family: "cost", aggregation: "sum", sources: ["google_ads"], dimensions: ["campaign", "channel", "device"],
    description: "Advertising cost reported by the ad platform." }),
  base({ key: "ad_impressions", label: "Ad impressions", unit: "count", category: "advertising", higherIsBetter: true, aggregation: "sum", sources: ["google_ads"], dimensions: ["campaign", "channel", "device"],
    description: "Ad impressions." }),
  base({ key: "ad_clicks", label: "Ad clicks", unit: "count", category: "advertising", higherIsBetter: true, aggregation: "sum", sources: ["google_ads"], dimensions: ["campaign", "channel", "device"],
    description: "Ad clicks." }),
  base({ key: "ad_conversions", label: "Ad conversions", unit: "number", category: "advertising", higherIsBetter: true, aggregation: "sum", sources: ["google_ads"], dimensions: ["campaign", "channel", "device"],
    description: "Conversions attributed by the ad platform (may be fractional with data-driven attribution)." }),
  base({ key: "ad_conversion_value", label: "Ad-attributed revenue", unit: "currency", category: "advertising", higherIsBetter: true, family: "ad_attributed", aggregation: "sum", sources: ["google_ads"], dimensions: ["campaign", "channel", "device"],
    description: "Conversion value the ad platform attributes to its ads. Overlaps with store sales — never added to total revenue." }),
  derived({ key: "ad_ctr", label: "Ad CTR", unit: "percent", category: "advertising", higherIsBetter: true, dimensions: ["campaign", "channel", "device"],
    formula: { op: "ratio", numerator: "ad_clicks", denominator: "ad_impressions", scale: 100 }, description: "Ad clicks ÷ ad impressions." }),
  derived({ key: "cpc", label: "Cost per click", unit: "currency", category: "advertising", higherIsBetter: false, dimensions: ["campaign", "channel", "device"],
    formula: { op: "ratio", numerator: "ad_spend", denominator: "ad_clicks" }, description: "Ad spend ÷ ad clicks." }),
  derived({ key: "cpa", label: "Cost per conversion", unit: "currency", category: "advertising", higherIsBetter: false, dimensions: ["campaign", "channel", "device"],
    formula: { op: "ratio", numerator: "ad_spend", denominator: "ad_conversions" }, description: "Ad spend ÷ ad-platform conversions." }),
  derived({ key: "roas", label: "ROAS (platform-attributed)", unit: "multiplier", category: "advertising", higherIsBetter: true, dimensions: ["campaign", "channel", "device"],
    formula: { op: "ratio", numerator: "ad_conversion_value", denominator: "ad_spend" }, description: "Ad-attributed revenue ÷ ad spend, as reported by the ad platform." }),
  derived({ key: "mer", label: "Marketing efficiency ratio", unit: "multiplier", category: "advertising", higherIsBetter: true, dimensions: [],
    formula: { op: "ratio", numerator: "store_net_sales", denominator: "ad_spend" }, description: "Store net sales ÷ total ad spend (blended, attribution-independent)." }),

  // ---------------------------------------------------------------- CRM (HubSpot)
  base({ key: "crm_new_contacts", label: "New contacts", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot"], dimensions: ["lifecycle_stage", "source_medium"],
    description: "Contacts created in the CRM." }),
  base({ key: "crm_qualified_leads", label: "Qualified leads", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot"], dimensions: ["source_medium"],
    description: "Contacts that became marketing- or sales-qualified leads in the period." }),
  base({ key: "crm_deals_created", label: "Deals created", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot"], dimensions: ["pipeline"],
    description: "Deals created in the period." }),
  base({ key: "crm_deals_won", label: "Deals won", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot"], dimensions: ["pipeline"],
    description: "Deals closed-won in the period." }),
  base({ key: "crm_deals_lost", label: "Deals lost", unit: "count", category: "crm", higherIsBetter: false, aggregation: "sum", sources: ["hubspot"], dimensions: ["pipeline"],
    description: "Deals closed-lost in the period." }),
  base({ key: "crm_won_value", label: "Won deal value", unit: "currency", category: "crm", higherIsBetter: true, family: "crm_won", aggregation: "sum", sources: ["hubspot"], dimensions: ["pipeline"],
    description: "Amount of deals closed-won in the period (CRM bookings, not collected cash)." }),
  base({ key: "crm_open_pipeline", label: "Open pipeline value", unit: "currency", category: "crm", higherIsBetter: true, family: "crm_pipeline", aggregation: "snapshot", sources: ["hubspot"], dimensions: ["deal_stage", "pipeline"],
    description: "Total amount of open deals at the end of the period (snapshot, not summed over days)." }),
  base({ key: "crm_open_deals", label: "Open deals", unit: "count", category: "crm", higherIsBetter: true, aggregation: "snapshot", sources: ["hubspot"], dimensions: ["deal_stage", "pipeline"],
    description: "Number of open deals at the end of the period (snapshot)." }),
  derived({ key: "win_rate", label: "Win rate", unit: "percent", category: "crm", higherIsBetter: true, dimensions: ["pipeline"],
    formula: { op: "ratio", numerator: "crm_deals_won", denominator: "crm_deals_closed", scale: 100 }, description: "Deals won ÷ (deals won + deals lost)." }),
  derived({ key: "crm_deals_closed", label: "Deals closed", unit: "count", category: "crm", higherIsBetter: true, dimensions: ["pipeline"],
    formula: { op: "sum", terms: ["crm_deals_won", "crm_deals_lost"] }, description: "Deals won + deals lost." }),
];

export const METRIC_MAP: ReadonlyMap<string, MetricDef> = new Map(METRICS.map((m) => [m.key, m]));
export const getMetric = (key: string) => METRIC_MAP.get(key);

/** Helper metrics that exist only to compute others correctly; hidden from pickers. */
export const INTERNAL_METRICS = new Set(["organic_position_sum", "crm_deals_closed"]);

/** Base metrics a metric ultimately depends on. */
export function baseDependencies(key: string, seen = new Set<string>()): string[] {
  const m = getMetric(key);
  if (!m || seen.has(m.key)) return [];
  seen.add(m.key);
  if (m.kind === "base") return [m.key];
  const f = m.formula;
  const parts = formulaInputs(f);
  return [...new Set(parts.flatMap((p) => baseDependencies(p, seen)))];
}

export function formulaInputs(f: DerivedMetric["formula"]): string[] {
  return f.op === "ratio" ? [f.numerator, f.denominator] : f.op === "difference" ? [f.minuend, f.subtrahend] : f.terms;
}

export function metricSources(key: string): ProviderId[] {
  return [...new Set(baseDependencies(key).flatMap((k) => (getMetric(k) as BaseMetric).sources))];
}

// ------------------------------------------------------------------ formatting

export function formatMetricValue(value: number | null | undefined, unit: MetricUnit, currency = "USD", opts: { compact?: boolean } = {}): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const compact = opts.compact && Math.abs(value) >= 10_000;
  switch (unit) {
    case "currency":
      return new Intl.NumberFormat(undefined, { style: "currency", currency, notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : Math.abs(value) < 100 ? 2 : 0 }).format(value);
    case "percent":
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1 }).format(value)}%`;
    case "multiplier":
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}×`;
    case "position":
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    default:
      return new Intl.NumberFormat(undefined, { notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : Math.abs(value) < 10 ? 2 : 0 }).format(value);
  }
}
