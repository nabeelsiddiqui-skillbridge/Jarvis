import type { Request } from "express";
import type pg from "pg";
import { can, canWorkspace, type EffectiveBusinessRole, type Permission, type WorkspacePermission, type WorkspaceRole } from "@bca/shared";
import { withSystem, withUser } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { forbidden, notFound, unauthorized } from "../lib/errors.js";

/**
 * What a platform administrator may do with an active support grant: read-only views.
 * No assistant (it would create conversations and spend the customer's quota), no exports.
 */
const SUPPORT_PERMISSIONS: ReadonlySet<Permission> = new Set(["business.read", "dashboard.read", "insight.read", "report.read", "connection.read", "automation.read"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export interface BusinessRow {
  id: string;
  workspace_id: string;
  name: string;
  logo_url: string | null;
  industry: string;
  website: string | null;
  timezone: string;
  currency: string;
  description: string | null;
  is_demo: boolean;
  created_at: Date;
  archived_at: Date | null;
}

export interface BusinessCtx {
  db: pg.PoolClient;
  userId: string;
  business: BusinessRow;
  role: EffectiveBusinessRole;
  /** Access comes from a platform administrator's time-limited support grant (read-only, audited). */
  support: boolean;
}

/**
 * Open a user-scoped transaction for one business and enforce `permission`.
 * The business id from the URL is only a lookup key: membership is resolved
 * in the database for the authenticated user (and RLS re-checks every query).
 * Unknown and inaccessible businesses both return 404 so ids can't be probed.
 */
export async function inBusiness<T>(
  req: Request,
  businessId: unknown,
  permission: Permission,
  fn: (ctx: BusinessCtx) => Promise<T>,
): Promise<T> {
  const user = req.user;
  if (!user) throw unauthorized();
  return inBusinessAs(user.id, businessId, permission, fn, { method: req.method, path: req.originalUrl?.split("?")[0] ?? req.path, ip: req.ip });
}

/** Same as inBusiness, for work that outlives the request transaction (e.g. assistant tool calls). */
export async function inBusinessAs<T>(
  userId: string,
  businessId: unknown,
  permission: Permission,
  fn: (ctx: BusinessCtx) => Promise<T>,
  request?: { method: string; path: string; ip?: string },
): Promise<T> {
  if (!isUuid(businessId)) throw notFound("Business");
  return withUser(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT b.*, app.business_role(b.id) AS role, app.is_support_access(b.id) AS support FROM businesses b WHERE b.id = $1 AND b.archived_at IS NULL`,
      [businessId],
    );
    const row = rows[0];
    if (!row || !row.role) throw notFound("Business");
    const role = row.role as EffectiveBusinessRole;
    const support = Boolean(row.support);
    if (support) {
      const entry = { workspaceId: row.workspace_id, businessId: row.id, actorUserId: userId, actorType: "support" as const, targetType: "business", targetId: row.id, metadata: { permission, request: request ? `${request.method} ${request.path}` : "background" }, ip: request?.ip };
      if (!SUPPORT_PERMISSIONS.has(permission)) {
        // Denied attempts are recorded too, outside this (about to be rolled back) transaction.
        await withSystem((sys) => audit(sys, { ...entry, action: "support.access_denied" }));
        throw forbidden("Support access is read-only.");
      }
      // Recorded in the customer's own audit log, which workspace owners can read.
      await audit(db, { ...entry, action: "support.data_viewed" });
    }
    if (!can(role, permission)) throw forbidden(`Your role (${role}) can't do this. Ask a business administrator.`);
    return fn({ db, userId, business: row as BusinessRow, role, support });
  });
}

export interface WorkspaceCtx {
  db: pg.PoolClient;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export async function inWorkspace<T>(
  req: Request,
  workspaceId: unknown,
  permission: WorkspacePermission | null,
  fn: (ctx: WorkspaceCtx) => Promise<T>,
): Promise<T> {
  const user = req.user;
  if (!user) throw unauthorized();
  if (!isUuid(workspaceId)) throw notFound("Workspace");
  return withUser(user.id, async (db) => {
    const { rows } = await db.query(`SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, user.id]);
    const role = rows[0]?.role as WorkspaceRole | undefined;
    if (!role) throw notFound("Workspace");
    if (permission && !canWorkspace(role, permission)) throw forbidden("Only workspace owners can do this.");
    return fn({ db, userId: user.id, workspaceId, role });
  });
}

export function toBusiness(row: BusinessRow & { role?: string }) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    logoUrl: row.logo_url,
    industry: row.industry,
    website: row.website,
    timezone: row.timezone,
    currency: row.currency,
    description: row.description,
    isDemo: row.is_demo,
    createdAt: new Date(row.created_at).toISOString(),
    role: row.role,
  };
}
