import { github } from "./github.js";
import { google } from "./google.js";
import { slackConnector, stripeConnector } from "./business.js";
import { crypto, hackernews } from "./public.js";
import { weather } from "./weather.js";
import { demoMetric, demoUpdates } from "./demo.js";
import type { Connector, WidgetData } from "./types.js";
import { updateCreds, type Account } from "../store.js";

export const CONNECTORS: Connector[] = [google, github, slackConnector, stripeConnector, weather, crypto, hackernews];

export const getConnector = (id: string) => CONNECTORS.find((c) => c.id === id);

/** Public description of a connector — safe to send to the browser and to Claude. */
export const describeConnector = (c: Connector) => ({
  id: c.id,
  name: c.name,
  category: c.category,
  description: c.description,
  auth: c.auth,
  fields: c.fields,
  docsUrl: c.docsUrl,
  metrics: c.metrics,
});

/** Connectors may refresh OAuth tokens in place; save them so the next request reuses them. */
async function withCredRefresh<T>(account: Account, fn: () => Promise<T>): Promise<T> {
  const before = JSON.stringify(account.creds);
  try {
    return await fn();
  } finally {
    if (JSON.stringify(account.creds) !== before) updateCreds(account);
  }
}

export async function accountUpdates(account: Account): Promise<string> {
  const c = getConnector(account.provider)!;
  if (account.demo) return demoUpdates(c.id);
  return withCredRefresh(account, () => c.updates(account.creds));
}

export async function accountMetric(account: Account, metric: string): Promise<WidgetData> {
  const c = getConnector(account.provider)!;
  if (!c.metrics.some((m) => m.id === metric)) throw new Error(`${c.name} has no metric "${metric}"`);
  if (account.demo) return demoMetric(c.id, metric);
  return withCredRefresh(account, () => c.fetchMetric(metric, account.creds));
}

export type { Connector, WidgetData };
