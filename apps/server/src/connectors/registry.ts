import type { CatalogStatus, ConnectorDefinition } from "./types.js";
import { shopify } from "./shopify/index.js";

/**
 * Connector catalog. Implemented connectors carry full definitions; planned ones
 * are listed so users can see the roadmap, and are always shown as "Planned" —
 * never as working integrations.
 */
export const IMPLEMENTED: ConnectorDefinition[] = [shopify];

interface PlannedEntry {
  id: string;
  name: string;
  category: ConnectorDefinition["category"];
  description: string;
  stage?: number;
  accessRequirements?: string[];
}

const PLANNED: PlannedEntry[] = [
  { id: "ga4", name: "Google Analytics 4", category: "Analytics", description: "Sessions, users, engagement, key events and ecommerce funnel.", stage: 4 },
  { id: "gsc", name: "Google Search Console", category: "Search", description: "Organic clicks, impressions, CTR, position by query and page.", stage: 4 },
  { id: "google_ads", name: "Google Ads", category: "Advertising", description: "Spend, clicks, conversions and conversion value by campaign.", stage: 4,
    accessRequirements: ["A Google Ads developer token with Basic or Standard access (approved by Google)."] },
  { id: "hubspot", name: "HubSpot", category: "CRM", description: "Contacts, qualified leads, deals, pipeline and won value.", stage: 4 },
  { id: "meta_ads", name: "Meta Ads", category: "Advertising", description: "Facebook & Instagram ad spend and results.", accessRequirements: ["Meta app review for ads_read."] },
  { id: "facebook_pages", name: "Facebook Pages", category: "Social", description: "Page reach, engagement and followers." },
  { id: "instagram", name: "Instagram (professional)", category: "Social", description: "Reach, engagement and follower growth." },
  { id: "woocommerce", name: "WooCommerce", category: "Commerce", description: "Orders and revenue from WooCommerce stores." },
  { id: "gohighlevel", name: "GoHighLevel", category: "CRM", description: "Contacts, opportunities and pipelines." },
  { id: "linkedin", name: "LinkedIn", category: "Social", description: "Page analytics and LinkedIn Ads.", accessRequirements: ["LinkedIn Marketing Developer Platform approval."] },
  { id: "tiktok", name: "TikTok", category: "Advertising", description: "TikTok Ads spend and results." },
  { id: "klaviyo", name: "Klaviyo", category: "Email", description: "Email and SMS campaign performance and attributed revenue." },
  { id: "mailchimp", name: "Mailchimp", category: "Email", description: "Campaign opens, clicks and list growth." },
  { id: "brevo", name: "Brevo", category: "Email", description: "Email campaigns and contacts." },
  { id: "salesforce", name: "Salesforce", category: "CRM", description: "Leads, opportunities and pipeline." },
  { id: "stripe", name: "Stripe", category: "Payments", description: "Collected revenue, refunds, subscriptions and MRR." },
  { id: "accounting", name: "Accounting (QuickBooks, Xero)", category: "Accounting", description: "Revenue, expenses and profit from your books." },
  { id: "support", name: "Support (Zendesk, Intercom)", category: "Support", description: "Ticket volume, response times and satisfaction." },
  { id: "inventory", name: "Inventory systems", category: "Inventory", description: "Stock levels and stock-outs." },
  { id: "csv", name: "CSV upload", category: "Data import", description: "Upload your own daily figures as CSV." },
  { id: "google_sheets", name: "Google Sheets", category: "Data import", description: "Sync figures maintained in a spreadsheet." },
];

export const getConnector = (id: string) => IMPLEMENTED.find((c) => c.id === id);

export function connectorStatus(def: ConnectorDefinition): { status: CatalogStatus; missingConfig: string[] } {
  const missingConfig = def.configKeys.filter((k) => !process.env[k]?.trim());
  if (missingConfig.length) return { status: "config_required", missingConfig };
  // Provider approvals we can't detect from here are surfaced as requirements, not as a blocked status,
  // unless the operator marks them pending explicitly.
  if ((process.env.PROVIDER_ACCESS_PENDING ?? "").split(",").includes(def.id)) return { status: "access_pending", missingConfig };
  return { status: "available", missingConfig };
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  status: CatalogStatus;
  statusNote: string;
  missingConfig: string[];
  accessRequirements: string[];
  scopes: { scope: string; reason: string; optional?: boolean }[];
  metrics: string[];
  actions: string[];
  reportingDelay: string | null;
  connectFields: ConnectorDefinition["connectFields"];
  supportsWebhooks: boolean;
}

export function catalog(): CatalogEntry[] {
  const implemented = IMPLEMENTED.map((d): CatalogEntry => {
    const { status, missingConfig } = connectorStatus(d);
    return {
      id: d.id,
      name: d.name,
      category: d.category,
      description: d.description,
      status,
      statusNote:
        status === "available" ? "Ready to connect."
        : status === "config_required" ? "The platform operator must add provider credentials before this can be connected."
        : "Waiting for the provider to approve access for this platform.",
      missingConfig,
      accessRequirements: d.accessRequirements ?? [],
      scopes: d.scopes,
      metrics: d.metrics,
      actions: d.actions,
      reportingDelay: d.reportingDelay,
      connectFields: d.connectFields,
      supportsWebhooks: d.supportsWebhooks,
    };
  });
  const planned = PLANNED.filter((p) => !IMPLEMENTED.some((d) => d.id === p.id)).map((p): CatalogEntry => ({
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    status: "planned",
    statusNote: p.stage ? `Planned — scheduled for build stage ${p.stage}.` : "Planned — not yet available.",
    missingConfig: [],
    accessRequirements: p.accessRequirements ?? [],
    scopes: [],
    metrics: [],
    actions: [],
    reportingDelay: null,
    connectFields: [],
    supportsWebhooks: false,
  }));
  return [...implemented, ...planned];
}
