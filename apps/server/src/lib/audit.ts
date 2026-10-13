import type { Db } from "../db/pool.js";

export interface AuditEntry {
  workspaceId?: string | null;
  businessId?: string | null;
  actorUserId?: string | null;
  actorType?: "user" | "system" | "support";
  action: string;
  targetType?: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Append an audit record. Never put secrets or tokens in metadata. */
export async function audit(db: Db, e: AuditEntry) {
  await db.query(
    `INSERT INTO audit_logs (workspace_id, business_id, actor_user_id, actor_type, action, target_type, target_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet)`,
    [
      e.workspaceId ?? null,
      e.businessId ?? null,
      e.actorUserId ?? null,
      e.actorType ?? "user",
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      JSON.stringify(e.metadata ?? {}),
      e.ip && /^[0-9a-f:.]+$/i.test(e.ip) ? e.ip : null,
    ],
  );
}
