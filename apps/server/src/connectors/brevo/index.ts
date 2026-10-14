import type { ConnectorDefinition } from "../types.js";

/** Placeholder until the connector is implemented (not listed as available). */
export const brevo: ConnectorDefinition = {
  id: "brevo",
  name: "Brevo",
  category: "Email",
  description: "",
  implemented: false,
  configKeys: [],
  scopes: [],
  metrics: [],
  actions: [],
  supportsWebhooks: false,
  reportingDelay: "",
  staleAfterHours: 26,
  syncIntervalMinutes: 360,
  reconcileDays: 7,
};
