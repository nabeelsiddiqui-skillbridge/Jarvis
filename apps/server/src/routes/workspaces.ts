import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { BUSINESS_ROLES } from "@bca/shared";
import { config } from "../config.js";
import { pool, withSystem, withUser } from "../db/pool.js";
import { requireUser } from "../auth/sessions.js";
import { inWorkspace, isUuid } from "../auth/access.js";
import { audit } from "../lib/audit.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { assertWithinLimit } from "../billing/entitlements.js";

export const workspacesRouter = Router();
workspacesRouter.use(requireUser);

workspacesRouter.post("/", async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1, "Name your workspace").max(120) }).parse(req.body);
  const id = randomUUID();
  await withUser(req.user!.id, async (db) => {
    await db.query("SELECT app.create_workspace($1, $2)", [id, body.name]);
    await db.query(
      `INSERT INTO user_preferences (user_id, last_workspace_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET last_workspace_id = $2`,
      [req.user!.id, id],
    );
    await audit(db, { workspaceId: id, actorUserId: req.user!.id, action: "workspace.created", targetType: "workspace", targetId: id, ip: req.ip });
  });
  res.status(201).json({ id });
});

workspacesRouter.patch("/:workspaceId", async (req, res) => {
  const body = z
    .object({ name: z.string().trim().min(1).max(120).optional(), retentionDays: z.number().int().min(30).max(3650).optional() })
    .parse(req.body);
  await inWorkspace(req, req.params.workspaceId, "workspace.manage", async ({ db, workspaceId, userId }) => {
    if (body.name) await db.query("UPDATE workspaces SET name = $2 WHERE id = $1", [workspaceId, body.name]);
    if (body.retentionDays) await db.query("UPDATE workspaces SET data_retention_days = $2 WHERE id = $1", [workspaceId, body.retentionDays]);
    await audit(db, { workspaceId, actorUserId: userId, action: "workspace.updated", targetType: "workspace", targetId: workspaceId, metadata: body, ip: req.ip });
  });
  res.json({ ok: true });
});

workspacesRouter.delete("/:workspaceId", async (req, res) => {
  const body = z.object({ confirmName: z.string() }).parse(req.body);
  await inWorkspace(req, req.params.workspaceId, "workspace.manage", async ({ db, workspaceId, userId }) => {
    const { rows } = await db.query("SELECT name FROM workspaces WHERE id = $1", [workspaceId]);
    if (rows[0]?.name !== body.confirmName) throw badRequest("Type the workspace name exactly to confirm deletion.");
    await audit(db, { workspaceId: null, actorUserId: userId, action: "workspace.deleted", targetType: "workspace", targetId: workspaceId, metadata: { name: rows[0].name }, ip: req.ip });
    await db.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ team

workspacesRouter.get("/:workspaceId/members", async (req, res) => {
  const data = await inWorkspace(req, req.params.workspaceId, null, async ({ db, workspaceId, role }) => {
    const members = await db.query(
      `SELECT u.id, u.name, u.email, wm.role, wm.created_at,
              coalesce(json_agg(json_build_object('businessId', bm.business_id, 'role', bm.role)) FILTER (WHERE bm.business_id IS NOT NULL), '[]') AS businesses
         FROM workspace_memberships wm
         JOIN users u ON u.id = wm.user_id
         LEFT JOIN business_memberships bm ON bm.user_id = wm.user_id AND bm.workspace_id = wm.workspace_id
        WHERE wm.workspace_id = $1
        GROUP BY u.id, wm.role, wm.created_at ORDER BY wm.created_at`,
      [workspaceId],
    );
    const invites =
      role === "owner"
        ? await db.query(
            `SELECT id, email, workspace_role, business_grants, created_at, expires_at FROM workspace_invitations
              WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
            [workspaceId],
          )
        : { rows: [] };
    return { members: members.rows, invitations: invites.rows };
  });
  res.json({
    members: data.members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joinedAt: m.created_at, businesses: m.businesses })),
    invitations: data.invitations.map((i) => ({ id: i.id, email: i.email, role: i.workspace_role, businessGrants: i.business_grants, createdAt: i.created_at, expiresAt: i.expires_at })),
  });
});

const grant = z.object({ businessId: z.uuid(), role: z.enum(BUSINESS_ROLES) });

workspacesRouter.post("/:workspaceId/invitations", async (req, res) => {
  const body = z
    .object({
      email: z.string().trim().toLowerCase().pipe(z.email()),
      role: z.enum(["owner", "member"]).default("member"),
      businessGrants: z.array(grant).max(200).default([]),
    })
    .parse(req.body);
  const token = randomToken(24);
  const result = await inWorkspace(req, req.params.workspaceId, "workspace.members.manage", async ({ db, workspaceId, userId }) => {
    await assertWithinLimit(workspaceId, "members");
    if (body.businessGrants.length) {
      const ids = body.businessGrants.map((g) => g.businessId);
      const { rows } = await db.query("SELECT count(*)::int AS n FROM businesses WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, ids]);
      if (rows[0].n !== new Set(ids).size) throw badRequest("One of the selected businesses isn't in this workspace.");
    }
    const already = await db.query(
      "SELECT 1 FROM workspace_memberships wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = $1 AND u.email = $2",
      [workspaceId, body.email],
    );
    if (already.rowCount) throw conflict("That person is already a member of this workspace.");
    const id = randomUUID();
    await db.query(
      `INSERT INTO workspace_invitations (id, workspace_id, email, workspace_role, business_grants, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '7 days')`,
      [id, workspaceId, body.email, body.role, JSON.stringify(body.businessGrants), sha256(token), userId],
    );
    await audit(db, { workspaceId, actorUserId: userId, action: "member.invited", targetType: "invitation", targetId: id, metadata: { email: body.email, role: body.role, grants: body.businessGrants }, ip: req.ip });
    return { id };
  });
  // No email provider is required: the owner can copy the link. (Emailed when SMTP_URL is configured — Stage 7.)
  res.status(201).json({ id: result.id, inviteUrl: `${config.appUrl}/invite/${token}` });
});

workspacesRouter.delete("/:workspaceId/invitations/:id", async (req, res) => {
  await inWorkspace(req, req.params.workspaceId, "workspace.members.manage", async ({ db, workspaceId, userId }) => {
    if (!isUuid(req.params.id)) throw notFound("Invitation");
    await db.query("UPDATE workspace_invitations SET revoked_at = now() WHERE id = $1 AND workspace_id = $2", [req.params.id, workspaceId]);
    await audit(db, { workspaceId, actorUserId: userId, action: "member.invitation_revoked", targetType: "invitation", targetId: String(req.params.id), ip: req.ip });
  });
  res.json({ ok: true });
});

workspacesRouter.patch("/:workspaceId/members/:userId", async (req, res) => {
  const body = z.object({ role: z.enum(["owner", "member"]) }).parse(req.body);
  await inWorkspace(req, req.params.workspaceId, "workspace.members.manage", async ({ db, workspaceId, userId }) => {
    const target = String(req.params.userId);
    if (!isUuid(target)) throw notFound("Member");
    if (body.role === "member") {
      const owners = await db.query("SELECT count(*)::int AS n FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner' AND user_id <> $2", [workspaceId, target]);
      if (owners.rows[0].n === 0) throw badRequest("A workspace needs at least one owner.");
    }
    const r = await db.query("UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [workspaceId, target, body.role]);
    if (!r.rowCount) throw notFound("Member");
    await audit(db, { workspaceId, actorUserId: userId, action: "member.role_changed", targetType: "user", targetId: target, metadata: body, ip: req.ip });
  });
  res.json({ ok: true });
});

workspacesRouter.delete("/:workspaceId/members/:userId", async (req, res) => {
  await inWorkspace(req, req.params.workspaceId, null, async ({ db, workspaceId, userId, role }) => {
    const target = String(req.params.userId);
    if (!isUuid(target)) throw notFound("Member");
    // Owners remove anyone; members may remove themselves (leave).
    if (role !== "owner" && target !== userId) throw forbidden("Only workspace owners can remove members.");
    const owners = await db.query("SELECT count(*)::int AS n FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner' AND user_id <> $2", [workspaceId, target]);
    if (owners.rows[0].n === 0) throw badRequest("A workspace needs at least one owner. Transfer ownership first.");
    // Members can't delete their own membership under RLS; use the owner path or a system statement for leaving.
    if (role === "owner") {
      await db.query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, target]);
    } else {
      await pool.query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
    }
    await audit(db, { workspaceId, actorUserId: userId, action: target === userId ? "member.left" : "member.removed", targetType: "user", targetId: target, ip: req.ip });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ accept invitation

export const invitesRouter = Router();

invitesRouter.get("/:token", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.email, i.workspace_role, w.name AS workspace_name, u.name AS invited_by
       FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
    [sha256(String(req.params.token))],
  );
  if (!rows[0]) throw notFound("Invitation (it may have expired or been used)");
  res.json({ email: rows[0].email, role: rows[0].workspace_role, workspaceName: rows[0].workspace_name, invitedBy: rows[0].invited_by });
});

invitesRouter.post("/:token/accept", requireUser, async (req, res) => {
  const user = req.user!;
  // Invitation acceptance is a system operation (the user isn't a member yet), validated here.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM workspace_invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(String(req.params.token))],
    );
    const inv = rows[0];
    if (!inv) throw notFound("Invitation (it may have expired or been used)");
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
      throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
    }
    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [inv.workspace_id, user.id, inv.workspace_role],
    );
    for (const g of inv.business_grants as { businessId: string; role: string }[]) {
      await client.query(
        `INSERT INTO business_memberships (business_id, workspace_id, user_id, role)
         SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM businesses WHERE id = $1 AND workspace_id = $2)
         ON CONFLICT (business_id, user_id) DO UPDATE SET role = excluded.role`,
        [g.businessId, inv.workspace_id, user.id, g.role],
      );
    }
    await client.query("UPDATE workspace_invitations SET accepted_at = now() WHERE id = $1", [inv.id]);
    await client.query(
      `INSERT INTO user_preferences (user_id, last_workspace_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_workspace_id = $2`,
      [user.id, inv.workspace_id],
    );
    await audit(client, { workspaceId: inv.workspace_id, actorUserId: user.id, action: "member.joined", targetType: "user", targetId: user.id, ip: req.ip });
    await client.query("COMMIT");
    res.json({ workspaceId: inv.workspace_id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------------ support access (owner view)

/** Workspace owners see every platform support grant for their workspace and can end it. */
workspacesRouter.get("/:workspaceId/support-access", async (req, res) => {
  const { workspaceId } = await inWorkspace(req, req.params.workspaceId, "workspace.manage", async (c) => c);
  const rows = await withSystem(async (db) => (await db.query(
    `SELECT g.id, g.reason, g.created_at, g.expires_at, g.revoked_at, u.email AS admin_email,
            (SELECT count(*) FROM audit_logs a WHERE a.workspace_id = g.workspace_id AND a.actor_user_id = g.admin_user_id AND a.action = 'support.data_viewed'
               AND a.created_at BETWEEN g.created_at AND coalesce(g.revoked_at, g.expires_at))::int AS views
       FROM support_access_grants g JOIN users u ON u.id = g.admin_user_id WHERE g.workspace_id = $1 ORDER BY g.created_at DESC LIMIT 20`,
    [workspaceId],
  )).rows);
  res.json(rows.map((r) => ({ id: r.id, reason: r.reason, adminEmail: r.admin_email, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, views: r.views, active: !r.revoked_at && new Date(r.expires_at) > new Date() })));
});

workspacesRouter.post("/:workspaceId/support-access/:grantId/revoke", async (req, res) => {
  const { workspaceId, userId } = await inWorkspace(req, req.params.workspaceId, "workspace.manage", async (c) => c);
  if (!isUuid(req.params.grantId)) throw notFound("Active support access");
  await withSystem(async (db) => {
    const g = await db.query(`UPDATE support_access_grants SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id`, [req.params.grantId, workspaceId]);
    if (!g.rowCount) throw notFound("Active support access");
    await audit(db, { workspaceId, actorUserId: userId, action: "support.access_revoked", targetType: "support_grant", targetId: String(req.params.grantId), ip: req.ip });
  });
  res.json({ ok: true });
});

