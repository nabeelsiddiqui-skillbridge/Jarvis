/**
 * Metric definitions — the single source of truth for what every number means.
 *
 * Rules enforced by the query engine:
 *  - Base metrics are stored as daily facts by connectors; derived metrics are
 *    computed from *aggregated* numerators and denominators (never averaged ratios).
 *  - Revenue concepts live in separate families and are never added together:
 *    store sales (Shopify, WooCommerce), analytics-observed revenue (GA4), ad-platform
 *    attributed conversion value, CRM won/pipeline value, collected payments
 *    (Stripe) and booked revenue from accounting (QuickBooks, Xero).
 *  - A metric marked `combine: "sum"` is added up across distinct platforms (two ad
 *    networks, two stores); manual sources (CSV, Google Sheets) are used only when
 *    no platform supplies it. Other metrics use the first available source.
 *  - Profit is only computed when the cost input (COGS) is available.
 *  - Missing data is `null` (unavailable), never 0.
 */

export type MetricUnit = "currency" | "count" | "percent" | "ratio" | "multiplier" | "number" | "position";
export type MetricCategory = "sales" | "acquisition" | "advertising" | "seo" | "crm" | "profit" | "payments" | "email" | "social" | "support" | "accounting" | "inventory";

/** Revenue/value families that must never be summed together. */
export type ValueFamily = "store_sales" | "analytics_revenue" | "ad_attributed" | "crm_won" | "crm_pipeline" | "cost" | "payments" | "recurring" | "books";

export const PROVIDERS = {
  shopify: "Shopify",
  ga4: "Google Analytics 4",
  gsc: "Google Search Console",
  google_ads: "Google Ads",
  hubspot: "HubSpot",
  meta_ads: "Meta Ads",
  tiktok_ads: "TikTok Ads",
  linkedin_ads: "LinkedIn Ads",
  facebook_pages: "Facebook Pages",
  instagram: "Instagram",
  woocommerce: "WooCommerce",
  salesforce: "Salesforce",
  gohighlevel: "GoHighLevel",
  stripe: "Stripe",
  klaviyo: "Klaviyo",
  mailchimp: "Mailchimp",
  brevo: "Brevo",
  zendesk: "Zendesk",
  intercom: "Intercom",
  quickbooks: "QuickBooks Online",
  xero: "Xero",
  google_sheets: "Google Sheets",
  csv: "CSV upload",
} as const;
export type ProviderId = keyof typeof PROVIDERS;

/** Figures people maintain by hand: used only when no connected platform supplies a metric. */
export const MANUAL_SOURCES: readonly ProviderId[] = ["csv", "google_sheets"];

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
  /** The connected platform the figure came from (for metrics combined across platforms). */
  platform: "Platform",
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
  /** "sum": add up across the platforms in `sources` that have data (they measure separate things). */
  combine?: "sum";
  /** Shown when the figure is combined across platforms (e.g. attribution caveats). */
  combineNote?: string;
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
  // ---------------------------------------------------------------- store (Shopify, WooCommerce)
  base({ key: "store_net_sales", label: "Store net sales", unit: "currency", category: "sales", higherIsBetter: true, family: "store_sales", aggregation: "sum", sources: ["shopify", "woocommerce", "csv", "google_sheets"], combine: "sum", dimensions: ["product", "country", "channel", "platform"],
    description: "Order line revenue after discounts and refunds, excluding taxes and shipping, for orders placed in the period (store reporting currency)." }),
  base({ key: "store_gross_sales", label: "Store gross sales", unit: "currency", category: "sales", higherIsBetter: true, family: "store_sales", aggregation: "sum", sources: ["shopify", "woocommerce", "csv", "google_sheets"], combine: "sum", dimensions: ["product", "country", "channel", "platform"],
    description: "Order line revenue before discounts, refunds, taxes and shipping." }),
  base({ key: "store_refunds", label: "Store refunds", unit: "currency", category: "sales", higherIsBetter: false, family: "store_sales", aggregation: "sum", sources: ["shopify", "woocommerce"], combine: "sum", dimensions: ["product", "country", "platform"],
    description: "Value refunded on orders placed in the period." }),
  base({ key: "store_orders", label: "Orders", unit: "count", category: "sales", higherIsBetter: true, aggregation: "sum", sources: ["shopify", "woocommerce", "csv", "google_sheets"], combine: "sum", dimensions: ["country", "channel", "platform"],
    description: "Number of orders placed (excluding cancelled and test orders)." }),
  base({ key: "store_units", label: "Units sold", unit: "count", category: "sales", higherIsBetter: true, aggregation: "sum", sources: ["shopify", "woocommerce", "csv", "google_sheets"], combine: "sum", dimensions: ["product", "platform"],
    description: "Quantity of items sold, net of refunded quantities." }),
  base({ key: "store_new_customers", label: "New customers", unit: "count", category: "sales", higherIsBetter: true, aggregation: "sum", sources: ["shopify"], dimensions: ["country"],
    description: "Orders whose customer had no prior order (first-time buyers)." }),
  base({ key: "store_cogs", label: "Cost of goods sold", unit: "currency", category: "profit", higherIsBetter: false, family: "cost", aggregation: "sum", sources: ["shopify", "csv", "google_sheets"], combine: "sum", dimensions: ["product", "platform"],
    description: "Unit cost × units sold, only for products with a recorded cost. Required for profit metrics." }),
  derived({ key: "aov", label: "Average order value", unit: "currency", category: "sales", higherIsBetter: true, family: "store_sales", dimensions: ["country", "channel", "platform"],
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

  // ---------------------------------------------------------------- advertising (Google, Meta, TikTok, LinkedIn)
  base({ key: "ad_spend", label: "Ad spend", unit: "currency", category: "advertising", higherIsBetter: false, family: "cost", aggregation: "sum", sources: ["google_ads", "meta_ads", "tiktok_ads", "linkedin_ads", "csv", "google_sheets"], combine: "sum", dimensions: ["campaign", "channel", "device", "platform"],
    description: "Advertising cost reported by the ad platform." }),
  base({ key: "ad_impressions", label: "Ad impressions", unit: "count", category: "advertising", higherIsBetter: true, aggregation: "sum", sources: ["google_ads", "meta_ads", "tiktok_ads", "linkedin_ads", "csv", "google_sheets"], combine: "sum", dimensions: ["campaign", "channel", "device", "platform"],
    description: "Ad impressions." }),
  base({ key: "ad_clicks", label: "Ad clicks", unit: "count", category: "advertising", higherIsBetter: true, aggregation: "sum", sources: ["google_ads", "meta_ads", "tiktok_ads", "linkedin_ads", "csv", "google_sheets"], combine: "sum", dimensions: ["campaign", "channel", "device", "platform"],
    description: "Ad clicks." }),
  base({ key: "ad_conversions", label: "Ad conversions", unit: "number", category: "advertising", higherIsBetter: true, aggregation: "sum", sources: ["google_ads", "meta_ads", "tiktok_ads", "linkedin_ads", "csv", "google_sheets"], combine: "sum", combineNote: "Each ad platform attributes conversions with its own model and window, so a sale can be counted by more than one platform.", dimensions: ["campaign", "channel", "device", "platform"],
    description: "Conversions attributed by the ad platform (may be fractional with data-driven attribution)." }),
  base({ key: "ad_conversion_value", label: "Ad-attributed revenue", unit: "currency", category: "advertising", higherIsBetter: true, family: "ad_attributed", aggregation: "sum", sources: ["google_ads", "meta_ads", "tiktok_ads", "linkedin_ads", "csv", "google_sheets"], combine: "sum", combineNote: "Each ad platform attributes conversions with its own model and window, so a sale can be counted by more than one platform.", dimensions: ["campaign", "channel", "device", "platform"],
    description: "Conversion value the ad platform attributes to its ads. Overlaps with store sales — never added to total revenue." }),
  derived({ key: "ad_ctr", label: "Ad CTR", unit: "percent", category: "advertising", higherIsBetter: true, dimensions: ["campaign", "channel", "device", "platform"],
    formula: { op: "ratio", numerator: "ad_clicks", denominator: "ad_impressions", scale: 100 }, description: "Ad clicks ÷ ad impressions." }),
  derived({ key: "cpc", label: "Cost per click", unit: "currency", category: "advertising", higherIsBetter: false, dimensions: ["campaign", "channel", "device", "platform"],
    formula: { op: "ratio", numerator: "ad_spend", denominator: "ad_clicks" }, description: "Ad spend ÷ ad clicks." }),
  derived({ key: "cpa", label: "Cost per conversion", unit: "currency", category: "advertising", higherIsBetter: false, dimensions: ["campaign", "channel", "device", "platform"],
    formula: { op: "ratio", numerator: "ad_spend", denominator: "ad_conversions" }, description: "Ad spend ÷ ad-platform conversions." }),
  derived({ key: "roas", label: "ROAS (platform-attributed)", unit: "multiplier", category: "advertising", higherIsBetter: true, dimensions: ["campaign", "channel", "device", "platform"],
    formula: { op: "ratio", numerator: "ad_conversion_value", denominator: "ad_spend" }, description: "Ad-attributed revenue ÷ ad spend, as reported by the ad platform." }),
  derived({ key: "mer", label: "Marketing efficiency ratio", unit: "multiplier", category: "advertising", higherIsBetter: true, dimensions: [],
    formula: { op: "ratio", numerator: "store_net_sales", denominator: "ad_spend" }, description: "Store net sales ÷ total ad spend (blended, attribution-independent)." }),

  // ---------------------------------------------------------------- CRM (HubSpot, Salesforce, GoHighLevel)
  base({ key: "crm_new_contacts", label: "New contacts", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["lifecycle_stage", "source_medium", "platform"],
    description: "Contacts created in the CRM." }),
  base({ key: "crm_qualified_leads", label: "Qualified leads", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["source_medium", "platform"],
    description: "Contacts that became marketing- or sales-qualified leads in the period." }),
  base({ key: "crm_deals_created", label: "Deals created", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["pipeline", "platform"],
    description: "Deals created in the period." }),
  base({ key: "crm_deals_won", label: "Deals won", unit: "count", category: "crm", higherIsBetter: true, aggregation: "sum", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["pipeline", "platform"],
    description: "Deals closed-won in the period." }),
  base({ key: "crm_deals_lost", label: "Deals lost", unit: "count", category: "crm", higherIsBetter: false, aggregation: "sum", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["pipeline", "platform"],
    description: "Deals closed-lost in the period." }),
  base({ key: "crm_won_value", label: "Won deal value", unit: "currency", category: "crm", higherIsBetter: true, family: "crm_won", aggregation: "sum", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["pipeline", "platform"],
    description: "Amount of deals closed-won in the period (CRM bookings, not collected cash)." }),
  base({ key: "crm_open_pipeline", label: "Open pipeline value", unit: "currency", category: "crm", higherIsBetter: true, family: "crm_pipeline", aggregation: "snapshot", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["deal_stage", "pipeline", "platform"],
    description: "Total amount of open deals at the end of the period (snapshot, not summed over days)." }),
  base({ key: "crm_open_deals", label: "Open deals", unit: "count", category: "crm", higherIsBetter: true, aggregation: "snapshot", sources: ["hubspot", "salesforce", "gohighlevel"], combine: "sum", dimensions: ["deal_stage", "pipeline", "platform"],
    description: "Number of open deals at the end of the period (snapshot)." }),
  derived({ key: "win_rate", label: "Win rate", unit: "percent", category: "crm", higherIsBetter: true, dimensions: ["pipeline", "platform"],
    formula: { op: "ratio", numerator: "crm_deals_won", denominator: "crm_deals_closed", scale: 100 }, description: "Deals won ÷ (deals won + deals lost)." }),
  derived({ key: "crm_deals_closed", label: "Deals closed", unit: "count", category: "crm", higherIsBetter: true, dimensions: ["pipeline", "platform"],
    formula: { op: "sum", terms: ["crm_deals_won", "crm_deals_lost"] }, description: "Deals won + deals lost." }),

  // ---------------------------------------------------------------- inventory (Shopify, WooCommerce, sheets)
  base({ key: "inv_units_on_hand", label: "Units in stock", unit: "count", category: "inventory", higherIsBetter: true, aggregation: "snapshot", sources: ["shopify", "woocommerce", "csv", "google_sheets"], combine: "sum", dimensions: ["product", "platform"],
    description: "Units on hand across stock-tracked products at the end of the period (snapshot, recorded at each sync)." }),
  base({ key: "inv_out_of_stock", label: "Products out of stock", unit: "count", category: "inventory", higherIsBetter: false, aggregation: "snapshot", sources: ["shopify", "woocommerce", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Stock-tracked products (or variations) with no units available at the end of the period." }),
  base({ key: "inv_low_stock", label: "Products low on stock", unit: "count", category: "inventory", higherIsBetter: false, aggregation: "snapshot", sources: ["shopify", "woocommerce", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Stock-tracked products at or below their low-stock threshold (but not out of stock)." }),

  // ---------------------------------------------------------------- payments (Stripe)
  base({ key: "pay_gross_volume", label: "Payments collected", unit: "currency", category: "payments", higherIsBetter: true, family: "payments", aggregation: "sum", sources: ["stripe", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Successful card and other payments, by the day they were made (before refunds and fees). Collected cash — not the same as store sales or booked revenue." }),
  base({ key: "pay_refunds", label: "Payments refunded", unit: "currency", category: "payments", higherIsBetter: false, family: "payments", aggregation: "sum", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Refunds issued in the period (including partial refunds)." }),
  base({ key: "pay_fees", label: "Payment fees", unit: "currency", category: "payments", higherIsBetter: false, family: "cost", aggregation: "sum", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Processing fees charged by the payment provider." }),
  base({ key: "pay_charges", label: "Successful payments", unit: "count", category: "payments", higherIsBetter: true, aggregation: "sum", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Number of successful payments." }),
  base({ key: "pay_new_customers", label: "New paying customers", unit: "count", category: "payments", higherIsBetter: true, aggregation: "sum", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Customer records created in the payment provider." }),
  base({ key: "sub_new", label: "New subscriptions", unit: "count", category: "payments", higherIsBetter: true, aggregation: "sum", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Subscriptions started in the period (trials included)." }),
  base({ key: "sub_canceled", label: "Canceled subscriptions", unit: "count", category: "payments", higherIsBetter: false, aggregation: "sum", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Subscriptions that ended in the period." }),
  base({ key: "sub_active", label: "Active subscriptions", unit: "count", category: "payments", higherIsBetter: true, aggregation: "snapshot", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Active and past-due subscriptions at the end of the period (snapshot, recorded at each sync)." }),
  base({ key: "sub_mrr", label: "Monthly recurring revenue", unit: "currency", category: "payments", higherIsBetter: true, family: "recurring", aggregation: "snapshot", sources: ["stripe"], combine: "sum", dimensions: ["platform"],
    description: "Normalized monthly value of active subscriptions after discounts at the end of the period (snapshot; excludes trials and one-off charges)." }),
  derived({ key: "pay_net_volume", label: "Net payments", unit: "currency", category: "payments", higherIsBetter: true, family: "payments", dimensions: ["platform"],
    formula: { op: "difference", minuend: "pay_gross_volume", subtrahend: "pay_refunds" }, description: "Payments collected − refunds (before fees)." }),
  derived({ key: "arpu", label: "Average revenue per subscription", unit: "currency", category: "payments", higherIsBetter: true, family: "recurring", dimensions: ["platform"],
    formula: { op: "ratio", numerator: "sub_mrr", denominator: "sub_active" }, description: "MRR ÷ active subscriptions." }),

  // ---------------------------------------------------------------- email (Klaviyo, Mailchimp, Brevo)
  base({ key: "email_sends", label: "Emails delivered", unit: "count", category: "email", higherIsBetter: true, aggregation: "sum", sources: ["klaviyo", "mailchimp", "brevo", "csv", "google_sheets"], combine: "sum", dimensions: ["campaign", "platform"],
    description: "Marketing emails sent/delivered. Klaviyo counts by delivery day; Mailchimp and Brevo by campaign send day." }),
  base({ key: "email_opens", label: "Email opens", unit: "count", category: "email", higherIsBetter: true, aggregation: "sum", sources: ["klaviyo", "mailchimp", "brevo", "csv", "google_sheets"], combine: "sum", dimensions: ["campaign", "platform"],
    description: "Unique opens. Inflated by privacy features that pre-load images (e.g. Apple Mail Privacy Protection)." }),
  base({ key: "email_clicks", label: "Email clicks", unit: "count", category: "email", higherIsBetter: true, aggregation: "sum", sources: ["klaviyo", "mailchimp", "brevo", "csv", "google_sheets"], combine: "sum", dimensions: ["campaign", "platform"],
    description: "Unique recipients who clicked a link." }),
  base({ key: "email_unsubscribes", label: "Unsubscribes", unit: "count", category: "email", higherIsBetter: false, aggregation: "sum", sources: ["klaviyo", "mailchimp", "brevo"], combine: "sum", dimensions: ["campaign", "platform"],
    description: "Recipients who unsubscribed." }),
  base({ key: "email_list_size", label: "Email subscribers", unit: "count", category: "email", higherIsBetter: true, aggregation: "snapshot", sources: ["mailchimp", "brevo", "klaviyo"], combine: "sum", dimensions: ["platform"],
    description: "Subscribed contacts at the end of the period (snapshot, recorded at each sync). Contacts on several platforms are counted on each." }),
  derived({ key: "email_open_rate", label: "Email open rate", unit: "percent", category: "email", higherIsBetter: true, dimensions: ["campaign", "platform"],
    formula: { op: "ratio", numerator: "email_opens", denominator: "email_sends", scale: 100 }, description: "Unique opens ÷ emails delivered." }),
  derived({ key: "email_click_rate", label: "Email click rate", unit: "percent", category: "email", higherIsBetter: true, dimensions: ["campaign", "platform"],
    formula: { op: "ratio", numerator: "email_clicks", denominator: "email_sends", scale: 100 }, description: "Unique clicks ÷ emails delivered." }),

  // ---------------------------------------------------------------- social (Facebook, Instagram)
  base({ key: "social_reach", label: "Social reach", unit: "count", category: "social", higherIsBetter: true, aggregation: "sum", sources: ["facebook_pages", "instagram", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Accounts reached per day, summed across days (not de-duplicated across the period or across platforms)." }),
  base({ key: "social_engagements", label: "Social engagements", unit: "count", category: "social", higherIsBetter: true, aggregation: "sum", sources: ["facebook_pages", "instagram", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Reactions, comments, shares, saves and other interactions with your posts." }),
  base({ key: "social_new_followers", label: "New followers", unit: "count", category: "social", higherIsBetter: true, aggregation: "sum", sources: ["facebook_pages", "instagram"], combine: "sum", dimensions: ["platform"],
    description: "Accounts that started following in the period." }),
  base({ key: "social_followers", label: "Followers", unit: "count", category: "social", higherIsBetter: true, aggregation: "snapshot", sources: ["facebook_pages", "instagram", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Followers at the end of the period (snapshot, recorded at each sync)." }),
  derived({ key: "social_engagement_rate", label: "Engagement per reach", unit: "percent", category: "social", higherIsBetter: true, dimensions: ["platform"],
    formula: { op: "ratio", numerator: "social_engagements", denominator: "social_reach", scale: 100 }, description: "Engagements ÷ reach." }),

  // ---------------------------------------------------------------- support (Zendesk, Intercom)
  base({ key: "support_tickets_created", label: "Tickets created", unit: "count", category: "support", higherIsBetter: false, aggregation: "sum", sources: ["zendesk", "intercom", "csv", "google_sheets"], combine: "sum", dimensions: ["channel", "platform"],
    description: "Support tickets (Zendesk) or conversations (Intercom) opened in the period." }),
  base({ key: "support_tickets_solved", label: "Tickets solved", unit: "count", category: "support", higherIsBetter: true, aggregation: "sum", sources: ["zendesk", "intercom"], combine: "sum", dimensions: ["channel", "platform"],
    description: "Tickets solved or conversations closed in the period (by the most recent solve)." }),
  base({ key: "support_open_tickets", label: "Open tickets", unit: "count", category: "support", higherIsBetter: false, aggregation: "snapshot", sources: ["zendesk", "intercom"], combine: "sum", dimensions: ["platform"],
    description: "Unsolved tickets/open conversations at the end of the period (snapshot, recorded at each sync)." }),
  base({ key: "support_first_reply_minutes", label: "First reply minutes (total)", unit: "number", category: "support", higherIsBetter: false, aggregation: "sum", sources: ["zendesk", "intercom"], combine: "sum", dimensions: ["channel", "platform"],
    description: "Internal helper: sum of first-reply times (calendar minutes) of tickets created in the period." }),
  base({ key: "support_first_replies", label: "Tickets with a first reply", unit: "count", category: "support", higherIsBetter: true, aggregation: "sum", sources: ["zendesk", "intercom"], combine: "sum", dimensions: ["channel", "platform"],
    description: "Tickets created in the period that have received a first agent reply." }),
  base({ key: "support_csat_good", label: "Positive ratings", unit: "count", category: "support", higherIsBetter: true, aggregation: "sum", sources: ["zendesk", "intercom"], combine: "sum", dimensions: ["platform"],
    description: "Satisfaction ratings that were positive (Zendesk “good”; Intercom 4–5 stars), for tickets created in the period." }),
  base({ key: "support_csat_rated", label: "Satisfaction ratings", unit: "count", category: "support", higherIsBetter: true, aggregation: "sum", sources: ["zendesk", "intercom"], combine: "sum", dimensions: ["platform"],
    description: "Satisfaction ratings received, for tickets created in the period." }),
  derived({ key: "support_avg_first_reply", label: "Average first reply time (min)", unit: "number", category: "support", higherIsBetter: false, dimensions: ["channel", "platform"],
    formula: { op: "ratio", numerator: "support_first_reply_minutes", denominator: "support_first_replies" }, description: "Mean minutes from ticket creation to the first agent reply (calendar time)." }),
  derived({ key: "support_csat", label: "Customer satisfaction (CSAT)", unit: "percent", category: "support", higherIsBetter: true, dimensions: ["platform"],
    formula: { op: "ratio", numerator: "support_csat_good", denominator: "support_csat_rated", scale: 100 }, description: "Positive ratings ÷ all ratings." }),

  // ---------------------------------------------------------------- accounting (QuickBooks, Xero)
  base({ key: "acct_revenue", label: "Revenue (books)", unit: "currency", category: "accounting", higherIsBetter: true, family: "books", aggregation: "sum", sources: ["quickbooks", "xero", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Operating income recorded in your accounting system (accrual basis), by transaction date. Booked revenue — not the same as store sales or collected payments." }),
  base({ key: "acct_cost_of_sales", label: "Cost of sales (books)", unit: "currency", category: "accounting", higherIsBetter: false, family: "cost", aggregation: "sum", sources: ["quickbooks", "xero", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Cost of goods sold / direct costs recorded in your books." }),
  base({ key: "acct_operating_expenses", label: "Operating expenses", unit: "currency", category: "accounting", higherIsBetter: false, family: "cost", aggregation: "sum", sources: ["quickbooks", "xero", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Operating expenses and overheads recorded in your books." }),
  base({ key: "acct_net_profit", label: "Net profit (books)", unit: "currency", category: "accounting", higherIsBetter: true, family: "books", aggregation: "sum", sources: ["quickbooks", "xero", "csv", "google_sheets"], combine: "sum", dimensions: ["platform"],
    description: "Net income as your accounting system reports it (income − all expenses, including other income and expenses)." }),
  derived({ key: "acct_gross_profit", label: "Gross profit (books)", unit: "currency", category: "accounting", higherIsBetter: true, family: "books", dimensions: ["platform"],
    formula: { op: "difference", minuend: "acct_revenue", subtrahend: "acct_cost_of_sales" }, description: "Revenue − cost of sales, from your books." }),
  derived({ key: "acct_net_margin", label: "Net margin (books)", unit: "percent", category: "accounting", higherIsBetter: true, dimensions: ["platform"],
    formula: { op: "ratio", numerator: "acct_net_profit", denominator: "acct_revenue", scale: 100 }, description: "Net profit ÷ revenue, from your books." }),
];

export const METRIC_MAP: ReadonlyMap<string, MetricDef> = new Map(METRICS.map((m) => [m.key, m]));
export const getMetric = (key: string) => METRIC_MAP.get(key);

/** Helper metrics that exist only to compute others correctly; hidden from pickers. */
export const INTERNAL_METRICS = new Set(["organic_position_sum", "crm_deals_closed", "support_first_reply_minutes"]);

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
