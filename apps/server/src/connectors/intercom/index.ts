import type { ConnectorDefinition } from "../types.js";

/** Placeholder until the connector is implemented (not listed as available). */
export const intercom: ConnectorDefinition = {
  id: "intercom",
  name: "Intercom",
  category: "Support",
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
