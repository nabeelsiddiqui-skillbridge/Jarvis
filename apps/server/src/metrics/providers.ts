import { IMPLEMENTED } from "../connectors/registry.js";

/** Provider reporting characteristics used for freshness labelling, taken from the connector definitions. */
export const PROVIDER_META: Record<string, { name: string; reportingDelay: string; staleAfterHours: number }> = {
  ...Object.fromEntries(IMPLEMENTED.map((d) => [d.id, { name: d.name, reportingDelay: d.reportingDelay, staleAfterHours: d.staleAfterHours }])),
  csv: { name: "CSV upload", reportingDelay: "Only as current as the last upload", staleAfterHours: 24 * 365 },
};
