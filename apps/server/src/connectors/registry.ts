import type { CatalogStatus, ConnectorDefinition } from "./types.js";
import { config } from "../config.js";
import { guideFor, type ConnectorGuide } from "./guides.js";
import { shopify } from "./shopify/index.js";
import { ga4 } from "./google/ga4.js";
import { gsc } from "./google/gsc.js";
import { googleAds } from "./google/ads.js";
import { hubspot } from "./hubspot/index.js";
import { metaAds } from "./meta/ads.js";
import { facebookPages } from "./meta/pages.js";
import { instagram } from "./meta/instagram.js";
import { tiktokAds } from "./tiktok/index.js";
import { linkedinAds } from "./linkedin/index.js";
import { woocommerce } from "./woocommerce/index.js";
import { stripe } from "./stripe/index.js";
import { klaviyo } from "./klaviyo/index.js";
import { mailchimp } from "./mailchimp/index.js";
import { brevo } from "./brevo/index.js";
import { zendesk } from "./zendesk/index.js";
import { intercom } from "./intercom/index.js";
import { salesforce } from "./salesforce/index.js";
import { gohighlevel } from "./gohighlevel/index.js";
import { quickbooks } from "./quickbooks/index.js";
import { xero } from "./xero/index.js";
import { googleSheets } from "./sheets/index.js";
import { csvUpload } from "./sheets/csv.js";

/**
 * Connector catalog. Implemented connectors carry full definitions; planned ones
 * are listed so users can see the roadmap, and are always shown as "Planned" —
 * never as working integrations.
 */
const ALL: ConnectorDefinition[] = [
  shopify, woocommerce, ga4, gsc, googleAds, metaAds, tiktokAds, linkedinAds, facebookPages, instagram,
  hubspot, salesforce, gohighlevel, stripe, klaviyo, mailchimp, brevo, zendesk, intercom, quickbooks, xero, googleSheets, csvUpload,
];
export const IMPLEMENTED: ConnectorDefinition[] = ALL.filter((d) => d.implemented);

interface PlannedEntry {
  id: string;
  name: string;
  category: ConnectorDefinition["category"];
  description: string;
  stage?: number;
  accessRequirements?: string[];
}

/** Shown as "Planned" until the connector's implementation is registered above. */
const PLANNED: PlannedEntry[] = [
  { id: "meta_ads", name: "Meta Ads", category: "Advertising", description: "Facebook & Instagram ad spend and results." },
  { id: "facebook_pages", name: "Facebook Pages", category: "Social", description: "Page reach, engagement and followers." },
  { id: "instagram", name: "Instagram", category: "Social", description: "Reach, engagement and follower growth." },
  { id: "woocommerce", name: "WooCommerce", category: "Commerce", description: "Orders, revenue and stock from WooCommerce stores." },
  { id: "gohighlevel", name: "GoHighLevel", category: "CRM", description: "Contacts, opportunities and pipelines." },
  { id: "linkedin_ads", name: "LinkedIn Ads", category: "Advertising", description: "LinkedIn Ads spend and results." },
  { id: "tiktok_ads", name: "TikTok Ads", category: "Advertising", description: "TikTok Ads spend and results." },
  { id: "klaviyo", name: "Klaviyo", category: "Email", description: "Email performance and subscribers." },
  { id: "mailchimp", name: "Mailchimp", category: "Email", description: "Campaign opens, clicks and audience size." },
  { id: "brevo", name: "Brevo", category: "Email", description: "Email campaigns and contacts." },
  { id: "salesforce", name: "Salesforce", category: "CRM", description: "Leads, opportunities and pipeline." },
  { id: "stripe", name: "Stripe", category: "Payments", description: "Collected payments, refunds, subscriptions and MRR." },
  { id: "quickbooks", name: "QuickBooks Online", category: "Accounting", description: "Revenue, expenses and profit from your books." },
  { id: "xero", name: "Xero", category: "Accounting", description: "Revenue, expenses and profit from your books." },
  { id: "zendesk", name: "Zendesk", category: "Support", description: "Ticket volume, reply times and satisfaction." },
  { id: "intercom", name: "Intercom", category: "Support", description: "Conversation volume, reply times and ratings." },
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
  /** Has a provider sign-in (OAuth) flow. */
  oauth: boolean;
  /** Connect with an access token instead of OAuth (works without platform app credentials). */
  tokenConnect: { fields: NonNullable<ConnectorDefinition["tokenConnect"]>["fields"]; instructions: string[]; variants: NonNullable<ConnectorDefinition["tokenConnect"]>["variants"] | null } | null;
  /** How to connect, step by step (overview, prerequisites, sign-in, admin setup, troubleshooting). */
  guide: ConnectorGuide | null;
  /** The OAuth callback to register with the provider. */
  redirectUri: string | null;
  docsUrl: string | null;
}

export const redirectUriFor = (id: string) => `${config.apiUrl}/api/oauth/${id}/callback`;

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
        status === "available" ? (d.authorizeUrl || !d.tokenConnect ? "Ready to connect." : "Connect with an API key or token from your account.")
        : status === "config_required" ? (d.tokenConnect ? "Ready to connect with a key or token from your account. One-click sign-in appears once a platform administrator adds the app credentials." : "A platform administrator must add this provider's app credentials (Admin → Credentials) before it can be connected.")
        : "Waiting for the provider to approve access for this platform.",
      missingConfig,
      accessRequirements: d.accessRequirements ?? [],
      scopes: d.scopes,
      metrics: d.metrics,
      actions: d.actions,
      reportingDelay: d.reportingDelay,
      connectFields: d.connectFields,
      supportsWebhooks: d.supportsWebhooks,
      oauth: Boolean(d.authorizeUrl),
      tokenConnect: d.tokenConnect ? { fields: d.tokenConnect.fields, instructions: d.tokenConnect.instructions, variants: d.tokenConnect.variants ?? null } : null,
      guide: guideFor(d.id, redirectUriFor(d.id)),
      redirectUri: d.authorizeUrl ? redirectUriFor(d.id) : null,
      docsUrl: d.docsUrl ?? null,
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
    oauth: false,
    tokenConnect: null,
    guide: null,
    redirectUri: null,
    docsUrl: null,
  }));
  return [...implemented, ...planned];
}
