import { pool, type Db } from "../db/pool.js";

export type UsageKind = "ai_message" | "ai_background" | "voice_session" | "tts_characters";

/**
 * Append a metering record. Never throws: usage tracking must not break the
 * feature being metered (a failure is logged for the operator instead).
 */
export async function recordUsage(
  e: { workspaceId: string; businessId?: string | null; userId?: string | null; kind: UsageKind; quantity?: number; meta?: Record<string, unknown> },
  db: Db = pool,
) {
  try {
    await db.query(
      `INSERT INTO usage_events (workspace_id, business_id, user_id, kind, quantity, meta) VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.workspaceId, e.businessId ?? null, e.userId ?? null, e.kind, e.quantity ?? 1, JSON.stringify(e.meta ?? {})],
    );
  } catch (err) {
    console.error("[usage] failed to record", e.kind, (err as Error).message);
  }
}
