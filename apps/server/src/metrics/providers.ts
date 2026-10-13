/** Provider reporting characteristics used for freshness labelling. Extended by connector definitions in Stage 3. */
export const PROVIDER_META: Record<string, { name: string; reportingDelay: string; staleAfterHours: number }> = {
  shopify: { name: "Shopify", reportingDelay: "Orders appear within minutes", staleAfterHours: 6 },
  ga4: { name: "Google Analytics 4", reportingDelay: "Data is typically complete after 24–48 hours", staleAfterHours: 30 },
  gsc: { name: "Google Search Console", reportingDelay: "Data is typically 2–3 days behind", staleAfterHours: 30 },
  google_ads: { name: "Google Ads", reportingDelay: "Cost updates within hours; conversions can change for up to 30 days", staleAfterHours: 8 },
  hubspot: { name: "HubSpot", reportingDelay: "Changes appear within minutes", staleAfterHours: 6 },
  csv: { name: "CSV upload", reportingDelay: "Only as current as the last upload", staleAfterHours: 24 * 365 },
};
