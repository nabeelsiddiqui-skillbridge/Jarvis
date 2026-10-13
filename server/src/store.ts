import { randomUUID } from "node:crypto";
import type { Credentials } from "./connectors/types.js";

/**
 * A connected account. Credentials live only on the server; the browser only
 * ever sees `provider`, `demo`, `label` and `connectedAt`.
 */
export interface Account {
  provider: string;
  creds: Credentials;
  demo: boolean;
  label?: string;
  connectedAt: number;
}

interface Session {
  id: string;
  accounts: Map<string, Account>;
  oauthState?: string;
  lastSeen: number;
}

// In-memory store: restart the server and users reconnect. Swap for a database
// (with encrypted credentials) before running this for real users.
const sessions = new Map<string, Session>();
const TTL = 1000 * 60 * 60 * 24 * 7;

export function getSession(id: string | undefined): Session {
  let s = id ? sessions.get(id) : undefined;
  if (!s) {
    s = { id: randomUUID(), accounts: new Map(), lastSeen: Date.now() };
    sessions.set(s.id, s);
  }
  s.lastSeen = Date.now();
  return s;
}

export const findSession = (id: string) => sessions.get(id);

setInterval(() => {
  const cutoff = Date.now() - TTL;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}, 60 * 60 * 1000).unref();

export function publicAccount(a: Account) {
  return { provider: a.provider, demo: a.demo, label: a.label, connectedAt: a.connectedAt };
}
