import { PROVIDERS } from "@bca/shared";
import { IMPLEMENTED } from "../connectors/registry.js";

/** Provider reporting characteristics used for freshness labelling, taken from the connector definitions. */
export const PROVIDER_META: Record<string, { name: string; reportingDelay: string; staleAfterHours: number }> = {
  ...Object.fromEntries(Object.entries(PROVIDERS).map(([id, name]) => [id, { name, reportingDelay: "", staleAfterHours: 26 }])),
  csv: { name: "CSV upload", reportingDelay: "Only as current as the last upload", staleAfterHours: 24 * 365 },
  ...Object.fromEntries(IMPLEMENTED.map((d) => [d.id, { name: d.name, reportingDelay: d.reportingDelay, staleAfterHours: d.staleAfterHours }])),
};
