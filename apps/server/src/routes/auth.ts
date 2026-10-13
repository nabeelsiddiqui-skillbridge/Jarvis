import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { pool, withUser } from "../db/pool.js";
import { dummyHash, hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  clearSessionCookie,
  createSession,
  destroyOtherSessions,
  destroySession,
  requireUser,
  setSessionCookie,
} from "../auth/sessions.js";
import { audit } from "../lib/audit.js";
import { AppError, conflict, forbidden, unauthorized } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { flagsFor } from "../lib/flags.js";
import { effectivePlan, loadSubscription } from "../billing/entitlements.js";

export const authRouter = Router();

const authLimiter = rateLimit({ name: "auth", max: 20, windowMs: 15 * 60 * 1000 });
const email = z.string().trim().toLowerCase().pipe(z.email({ message: "Enter a valid email address" })).pipe(z.string().max(254));
const password = z.string().min(10, "Use at least 10 characters").max(200);

authRouter.post("/signup", authLimiter, async (req, res) => {
  if (!config.allowSignup) throw forbidden("Sign-ups are closed.");
  const body = z.object({ name: z.string().trim().min(1, "Enter your name").max(80), email, password }).parse(req.body);
  const exists = await pool.query("SELECT 1 FROM users WHERE email = $1", [body.email]);
  if (exists.rowCount) throw conflict("An account with this email already exists. Try signing in.");
  const isAdmin = config.platformAdmins.includes(body.email);
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash, is_platform_admin, last_login_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [body.email, body.name, await hashPassword(body.password), isAdmin],
  );
  const userId = rows[0].id as string;
  await pool.query("INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  await audit(pool, { actorUserId: userId, action: "user.signup", targetType: "user", targetId: userId, ip: req.ip });
  setSessionCookie(res, await createSession(userId, req));
  res.status(201).json({ id: userId });
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const body = z.object({ email, password: z.string().max(200) }).parse(req.body);
  const { rows } = await pool.query("SELECT id, password_hash, disabled_at FROM users WHERE email = $1", [body.email]);
  const row = rows[0];
  const ok = await verifyPassword(body.password, row?.password_hash ?? (await dummyHash()));
  if (!row || !ok) throw unauthorized("Wrong email or password.");
  if (row.disabled_at) throw forbidden("This account is disabled. Contact support.");
  await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);
  await audit(pool, { actorUserId: row.id, action: "user.login", targetType: "user", targetId: row.id, ip: req.ip });
  setSessionCookie(res, await createSession(row.id, req));
  res.json({ id: row.id });
});

authRouter.post("/logout", async (req, res) => {
  if (req.sessionToken) await destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Everything the app needs at boot: user, workspaces, preferences. */
authRouter.get("/me", requireUser, async (req, res) => {
  const user = req.user!;
  const data = await withUser(user.id, async (db) => {
    const workspaces = await db.query(
      `SELECT w.id, w.name, wm.role, w.data_retention_days,
              (SELECT count(*) FROM businesses b WHERE b.workspace_id = w.id AND b.archived_at IS NULL AND app.can_access_business(b.id)) AS business_count
         FROM workspace_memberships wm JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = $1 ORDER BY w.created_at`,
      [user.id],
    );
    const prefs = await db.query("SELECT last_workspace_id, recent_business_ids, onboarding, assistant_panel_open FROM user_preferences WHERE user_id = $1", [user.id]);
    return { workspaces: workspaces.rows, prefs: prefs.rows[0] };
  });
  const extras = await Promise.all(data.workspaces.map(async (w) => ({ features: await flagsFor(w.id), plan: effectivePlan(await loadSubscription(pool, w.id)) })));
  res.json({
    user,
    workspaces: data.workspaces.map((w, i) => ({ id: w.id, name: w.name, role: w.role, retentionDays: w.data_retention_days, businessCount: w.business_count, ...extras[i] })),
    preferences: {
      lastWorkspaceId: data.prefs?.last_workspace_id ?? null,
      recentBusinessIds: data.prefs?.recent_business_ids ?? [],
      onboarding: data.prefs?.onboarding ?? {},
      assistantPanelOpen: data.prefs?.assistant_panel_open ?? true,
    },
  });
});

const prefsInput = z.object({
  lastWorkspaceId: z.uuid().nullable().optional(),
  recentBusinessId: z.uuid().optional(),
  onboarding: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
  assistantPanelOpen: z.boolean().optional(),
});

authRouter.patch("/me/preferences", requireUser, async (req, res) => {
  const body = prefsInput.parse(req.body);
  await withUser(req.user!.id, async (db) => {
    await db.query("INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [req.user!.id]);
    if (body.lastWorkspaceId !== undefined) {
      if (body.lastWorkspaceId) {
        const ok = await db.query("SELECT app.is_workspace_member($1) AS ok", [body.lastWorkspaceId]);
        if (!ok.rows[0].ok) throw forbidden();
      }
      await db.query("UPDATE user_preferences SET last_workspace_id = $2, updated_at = now() WHERE user_id = $1", [req.user!.id, body.lastWorkspaceId]);
    }
    if (body.recentBusinessId) {
      const ok = await db.query("SELECT app.can_access_business($1) AS ok", [body.recentBusinessId]);
      if (!ok.rows[0].ok) throw forbidden();
      // Most-recent first, unique, max 8.
      await db.query(
        `UPDATE user_preferences SET recent_business_ids =
           (array_prepend($2::uuid, array_remove(recent_business_ids, $2::uuid)))[1:8], updated_at = now()
         WHERE user_id = $1`,
        [req.user!.id, body.recentBusinessId],
      );
    }
    if (body.onboarding) {
      await db.query("UPDATE user_preferences SET onboarding = onboarding || $2::jsonb, updated_at = now() WHERE user_id = $1", [req.user!.id, JSON.stringify(body.onboarding)]);
    }
    if (body.assistantPanelOpen !== undefined) {
      await db.query("UPDATE user_preferences SET assistant_panel_open = $2 WHERE user_id = $1", [req.user!.id, body.assistantPanelOpen]);
    }
  });
  res.json({ ok: true });
});

authRouter.patch("/me", requireUser, async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
  await pool.query("UPDATE users SET name = $2 WHERE id = $1", [req.user!.id, body.name]);
  res.json({ ok: true });
});

authRouter.post("/password", requireUser, authLimiter, async (req, res) => {
  const body = z.object({ current: z.string().max(200), next: password }).parse(req.body);
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
  if (!rows[0] || !(await verifyPassword(body.current, rows[0].password_hash))) throw unauthorized("Your current password is incorrect.");
  await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [req.user!.id, await hashPassword(body.next)]);
  await destroyOtherSessions(req.user!.id, req.sessionToken!);
  await audit(pool, { actorUserId: req.user!.id, action: "user.password_changed", targetType: "user", targetId: req.user!.id, ip: req.ip });
  res.json({ ok: true });
});

/** Delete the user. Workspaces where they're the only owner must be handed over or deleted first. */
authRouter.delete("/me", requireUser, authLimiter, async (req, res) => {
  const body = z.object({ password: z.string().max(200) }).parse(req.body);
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
  if (!rows[0] || !(await verifyPassword(body.password, rows[0].password_hash))) throw unauthorized("Password is incorrect.");
  const soleOwned = await pool.query(
    `SELECT w.name FROM workspace_memberships wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = $1 AND wm.role = 'owner'
        AND (SELECT count(*) FROM workspace_memberships x WHERE x.workspace_id = wm.workspace_id) > 1
        AND (SELECT count(*) FROM workspace_memberships x WHERE x.workspace_id = wm.workspace_id AND x.role = 'owner') = 1`,
    [req.user!.id],
  );
  if (soleOwned.rowCount) {
    throw new AppError(409, "sole_owner", `Transfer ownership first: you're the only owner of ${soleOwned.rows.map((r) => `"${r.name}"`).join(", ")}, which has other members.`);
  }
  // Workspaces where the user is the only member are deleted with them (cascades to all business data).
  await pool.query(
    `DELETE FROM workspaces w WHERE EXISTS (SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id = w.id AND wm.user_id = $1)
       AND (SELECT count(*) FROM workspace_memberships x WHERE x.workspace_id = w.id) = 1`,
    [req.user!.id],
  );
  await pool.query("DELETE FROM users WHERE id = $1", [req.user!.id]);
  await audit(pool, { actorUserId: null, actorType: "system", action: "user.deleted", targetType: "user", targetId: req.user!.id, ip: req.ip });
  clearSessionCookie(res);
  res.json({ ok: true });
});
