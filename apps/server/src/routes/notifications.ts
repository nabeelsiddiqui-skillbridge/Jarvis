import { Router } from "express";
import type { AppNotification } from "@bca/shared";
import { requireUser } from "../auth/sessions.js";
import { withUser } from "../db/pool.js";
import { isUuid } from "../auth/access.js";
import { notFound } from "../lib/errors.js";

/** The signed-in user's in-app notifications (RLS: own rows, businesses they can still access). */
export const notificationsRouter = Router();
notificationsRouter.use(requireUser);

notificationsRouter.get("/notifications", async (req, res) => {
  const out = await withUser(req.user!.id, async (db) => {
    const { rows } = await db.query(
      `SELECT n.*, coalesce(b.name, w.name) AS business_name FROM notifications n LEFT JOIN businesses b ON b.id = n.business_id JOIN workspaces w ON w.id = n.workspace_id ORDER BY n.created_at DESC LIMIT 50`,
    );
    const unread = (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL`)).rows[0].n;
    return { unread, items: rows.map((r): AppNotification => ({ id: r.id, businessId: r.business_id, businessName: r.business_name, kind: r.kind, title: r.title, body: r.body, link: r.link, readAt: r.read_at, createdAt: r.created_at })) };
  });
  res.json(out);
});

notificationsRouter.post("/notifications/:id/read", async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound("Notification");
  await withUser(req.user!.id, async (db) => {
    const r = await db.query(`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1`, [req.params.id]);
    if (!r.rowCount) throw notFound("Notification");
  });
  res.json({ ok: true });
});

notificationsRouter.post("/notifications/read-all", async (req, res) => {
  await withUser(req.user!.id, (db) => db.query(`UPDATE notifications SET read_at = now() WHERE read_at IS NULL`));
  res.json({ ok: true });
});
