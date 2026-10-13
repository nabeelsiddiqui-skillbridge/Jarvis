import { Router, type Response } from "express";
import pg from "pg";
import { config } from "../config.js";
import { requireUser } from "../auth/sessions.js";
import { inBusiness } from "../auth/access.js";

/**
 * Server-sent events per business. One shared LISTEN connection receives
 * `bca_events` notifications from the database (sync completed, data updated,
 * insight created…) and fans them out to subscribed browsers. Clients only
 * receive events for a business they were authorized for when subscribing; the
 * stream closes after 20 minutes so access is re-checked on reconnect.
 */

const subscribers = new Map<string, Set<Response>>();
let listener: pg.Client | null = null;
let connecting: Promise<void> | null = null;

async function ensureListener() {
  if (listener) return;
  connecting ??= (async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on("notification", (msg) => {
      try {
        const evt = JSON.parse(msg.payload ?? "{}");
        const subs = subscribers.get(evt.businessId);
        if (!subs) return;
        const line = `event: ${evt.kind}\ndata: ${JSON.stringify(evt.payload ?? {})}\n\n`;
        for (const res of subs) res.write(line);
      } catch {
        /* ignore malformed */
      }
    });
    client.on("error", () => {
      listener = null;
      connecting = null;
    });
    await client.connect();
    await client.query("LISTEN bca_events");
    listener = client;
  })().finally(() => (connecting = null));
  await connecting;
}

export const eventsRouter = Router();

eventsRouter.get("/businesses/:businessId/events", requireUser, async (req, res) => {
  const business = await inBusiness(req, req.params.businessId, "business.read", async ({ business }) => business);
  await ensureListener();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: ready\ndata: {}\n\n`);
  const set = subscribers.get(business.id) ?? new Set();
  set.add(res);
  subscribers.set(business.id, set);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  const expire = setTimeout(() => res.end(), 20 * 60_000);
  req.on("close", () => {
    clearInterval(ping);
    clearTimeout(expire);
    set.delete(res);
    if (!set.size) subscribers.delete(business.id);
  });
});
