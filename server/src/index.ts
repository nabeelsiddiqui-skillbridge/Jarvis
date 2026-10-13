import express, { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { aiMode, runAgent } from "./agent.js";
import { accountMetric, CONNECTORS, describeConnector, getConnector } from "./connectors/index.js";
import { exchangeGoogleCode, googleAuthUrl, googleConfigured } from "./connectors/google.js";
import { getSession, publicAccount } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
const COOKIE = "jarvis_sid";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// ------------------------------------------------------------- session cookie

declare module "express-serve-static-core" {
  interface Request {
    session: ReturnType<typeof getSession>;
  }
}

app.use((req, res, next) => {
  const sid = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === COOKIE)?.[1];
  req.session = getSession(sid);
  if (req.session.id !== sid) {
    res.cookie(COOKIE, req.session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: APP_URL.startsWith("https://"),
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });
  }
  next();
});

// ------------------------------------------------------------- status + connectors

app.get("/api/status", (_req, res) => {
  res.json({ ai: aiMode(), googleOAuth: googleConfigured() });
});

app.get("/api/connectors", (_req, res) => {
  res.json(CONNECTORS.map(describeConnector));
});

app.get("/api/accounts", (req, res) => {
  res.json([...req.session.accounts.values()].map(publicAccount));
});

const connectBody = z.object({
  demo: z.boolean().default(false),
  creds: z.record(z.string(), z.string().max(4000)).default({}),
});

app.post("/api/accounts/:provider", async (req, res) => {
  const connector = getConnector(req.params.provider);
  if (!connector) return res.status(404).json({ error: "Unknown connector" });
  const { demo, creds } = connectBody.parse(req.body);
  const clean: Record<string, string> = {};
  for (const f of connector.fields) if (creds[f.key]) clean[f.key] = creds[f.key].trim();

  if (!demo) {
    if (connector.auth === "oauth") return res.status(400).json({ error: "Use the sign-in button to connect this account." });
    const missing = connector.fields.filter((f) => f.secret && !clean[f.key]);
    if (missing.length) return res.status(400).json({ error: `Missing ${missing.map((f) => f.label).join(", ")}` });
    try {
      await connector.verify?.(clean);
    } catch (err) {
      return res.status(400).json({ error: `Couldn't connect: ${(err as Error).message}` });
    }
  }
  const account = { provider: connector.id, creds: demo ? {} : clean, demo, connectedAt: Date.now() };
  req.session.accounts.set(connector.id, account);
  res.json(publicAccount(account));
});

app.delete("/api/accounts/:provider", (req, res) => {
  req.session.accounts.delete(req.params.provider);
  res.json({ ok: true });
});

// ------------------------------------------------------------- Google OAuth

app.get("/api/oauth/google/start", (req, res) => {
  if (!googleConfigured()) return res.status(400).send("Google OAuth is not configured on this server (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  req.session.oauthState = randomBytes(16).toString("hex");
  res.redirect(googleAuthUrl(req.session.oauthState));
});

app.get("/api/oauth/google/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const back = (status: string) => res.redirect(`${APP_URL}/?connected=google&status=${encodeURIComponent(status)}`);
  if (error) return back(error);
  if (!code || !state || state !== req.session.oauthState) return back("invalid_state");
  req.session.oauthState = undefined;
  try {
    const creds = await exchangeGoogleCode(code);
    req.session.accounts.set("google", { provider: "google", creds, demo: false, connectedAt: Date.now() });
    back("ok");
  } catch (err) {
    console.error(err);
    back("token_error");
  }
});

// ------------------------------------------------------------- live widget data

app.get("/api/data/:provider/:metric", async (req, res) => {
  const account = req.session.accounts.get(req.params.provider);
  if (!account) return res.status(404).json({ error: `${req.params.provider} is not connected` });
  try {
    res.json({ data: await accountMetric(account, req.params.metric), at: Date.now() });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ------------------------------------------------------------- chat

const widgetSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  metric: z.string(),
  viz: z.enum(["stat", "line", "area", "bar", "list"]),
  refreshSec: z.number(),
});

const chatBody = z.object({
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) })).min(1).max(100),
  dashboard: z.object({ id: z.string(), name: z.string(), widgets: z.array(widgetSchema).max(100) }),
});

app.post("/api/chat", async (req, res) => {
  const { history, dashboard } = chatBody.parse(req.body);
  try {
    res.json(await runAgent(history, req.session.accounts, dashboard));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `My systems hiccuped: ${(err as Error).message}` });
  }
});

// ------------------------------------------------------------- static client (production)

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", issues: err.issues });
  console.error(err);
  res.status(500).json({ error: "Internal error" });
});

app.listen(PORT, () => {
  console.log(`JARVIS server online at http://localhost:${PORT} — AI mode: ${aiMode()}`);
});
