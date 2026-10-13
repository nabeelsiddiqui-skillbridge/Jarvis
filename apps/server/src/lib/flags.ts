import { pool } from "../db/pool.js";
import { prerequisite } from "./errors.js";

/**
 * Platform feature flags (managed in the admin console). A flag is on unless a
 * platform administrator switched it off globally or for this workspace;
 * a per-workspace override wins over the global value.
 */
export const FLAG_KEYS = ["assistant", "voice", "external_actions"] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

const LABEL: Record<FlagKey, string> = {
  assistant: "The AI assistant",
  voice: "Voice conversations",
  external_actions: "External actions",
};

export async function flagsFor(workspaceId: string): Promise<Record<FlagKey, boolean>> {
  // Platform configuration, read with the system pool (the request role has no access to it).
  const { rows } = await pool.query(`SELECT key, enabled, overrides FROM feature_flags WHERE key = ANY($1)`, [FLAG_KEYS as unknown as string[]]);
  const out = Object.fromEntries(FLAG_KEYS.map((k) => [k, true])) as Record<FlagKey, boolean>;
  for (const r of rows) {
    const o = r.overrides?.[workspaceId];
    out[r.key as FlagKey] = typeof o === "boolean" ? o : r.enabled;
  }
  return out;
}

export async function isEnabled(key: FlagKey, workspaceId: string) {
  return (await flagsFor(workspaceId))[key];
}

export async function assertEnabled(key: FlagKey, workspaceId: string) {
  if (!(await isEnabled(key, workspaceId))) throw prerequisite(`${LABEL[key]} is turned off for this workspace by the platform administrator.`, { flag: key });
}
