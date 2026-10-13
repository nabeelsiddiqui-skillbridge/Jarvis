import type pg from "pg";

/** Users who should hear about a business by default: its owners and administrators. */
export async function businessAdmins(db: pg.PoolClient, businessId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT wm.user_id FROM businesses b JOIN workspace_memberships wm ON wm.workspace_id = b.workspace_id AND wm.role = 'owner' WHERE b.id = $1
     UNION SELECT user_id FROM business_memberships WHERE business_id = $1 AND role = 'admin'`,
    [businessId],
  );
  return rows.map((r) => r.user_id);
}

/** Keep only users who currently have access to the business. */
export async function withAccess(db: pg.PoolClient, businessId: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  const { rows } = await db.query(
    `SELECT u.id FROM users u WHERE u.id = ANY($2::uuid[]) AND (
       EXISTS (SELECT 1 FROM businesses b JOIN workspace_memberships wm ON wm.workspace_id = b.workspace_id AND wm.role = 'owner' WHERE b.id = $1 AND wm.user_id = u.id)
       OR EXISTS (SELECT 1 FROM business_memberships bm WHERE bm.business_id = $1 AND bm.user_id = u.id))`,
    [businessId, userIds],
  );
  return rows.map((r) => r.id);
}

/** In-app notifications (system role). De-duplicated per user by `dedupeKey`. */
export async function notifyUsers(db: pg.PoolClient, p: { workspaceId: string; businessId: string; userIds: string[]; kind: string; title: string; body?: string; link?: string; dedupeKey?: string }) {
  const users = await withAccess(db, p.businessId, p.userIds);
  let n = 0;
  for (const u of users) {
    const r = await db.query(
      `INSERT INTO notifications (user_id, workspace_id, business_id, kind, title, body, link, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [u, p.workspaceId, p.businessId, p.kind, p.title, p.body ?? "", p.link ?? null, p.dedupeKey ?? null],
    );
    n += r.rowCount ?? 0;
  }
  if (n) await db.query("SELECT app.notify_business($1, 'notification', '{}')", [p.businessId]);
  return { notified: n, users };
}
