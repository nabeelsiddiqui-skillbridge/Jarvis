import type { Request } from "express";
import type pg from "pg";
import { can, canWorkspace, type EffectiveBusinessRole, type Permission, type WorkspacePermission, type WorkspaceRole } from "@bca/shared";
import { withUser } from "../db/pool.js";
import { forbidden, notFound, unauthorized } from "../lib/errors.js";

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
  return inBusinessAs(user.id, businessId, permission, fn);
}

/** Same as inBusiness, for work that outlives the request transaction (e.g. assistant tool calls). */
export async function inBusinessAs<T>(
  userId: string,
  businessId: unknown,
  permission: Permission,
  fn: (ctx: BusinessCtx) => Promise<T>,
): Promise<T> {
  if (!isUuid(businessId)) throw notFound("Business");
  return withUser(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT b.*, app.business_role(b.id) AS role FROM businesses b WHERE b.id = $1 AND b.archived_at IS NULL`,
      [businessId],
    );
    const row = rows[0];
    if (!row || !row.role) throw notFound("Business");
    const role = row.role as EffectiveBusinessRole;
    if (!can(role, permission)) throw forbidden(`Your role (${role}) can't do this. Ask a business administrator.`);
    return fn({ db, userId, business: row as BusinessRow, role });
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
