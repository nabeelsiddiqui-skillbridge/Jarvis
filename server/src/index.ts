import express, { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { aiMode, runAgent } from "./agent.js";
import { accountMetric, CONNECTORS, describeConnector, getConnector } from "./connectors/index.js";
import { exchangeGoogleCode, googleAuthUrl, googleConfigured } from "./connectors/google.js";
import {
  authenticate,
  changePassword,
  createSession,
  createUser,
  deleteAccount,
  deleteOtherSessions,
  deleteSession,
  deleteUser,
  getAccount,
  getDashboards,
  listAccounts,
  publicAccount,
  saveAccount,
  saveDashboards,
  SESSION_TTL,
  sessionUser,
  type User,
} from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
const ALLOW_SIGNUP = process.env.JARVIS_ALLOW_SIGNUP !== "false";
const COOKIE = "jarvis_session";
const SECURE_COOKIE = APP_URL.startsWith("https://");

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? true : process.env.TRUST_PROXY);
app.use(express.json({ limit: "512kb" }));

declare module "express-serve-static-core" {
  interface Request {
    user: User | null;
    token?: string;
  }
}

const readCookie = (req: Request, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

const setSessionCookie = (res: Response, token: string) =>
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: SECURE_COOKIE, maxAge: SESSION_TTL, path: "/" });

app.use((req, _res, next) => {
  req.token = readCookie(req, COOKIE);
  req.user = sessionUser(req.token);
  next();
});

// State-changing API calls must come from our own frontend: it sends this header,
// and a cross-site form or <img> can't. (SameSite=Lax cookies are the first line of defence.)
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (req.get("X-Jarvis") !== "1") return res.status(403).json({ error: "Missing X-Jarvis header" });
  next();
});

function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}

/** Small fixed-window limiter for the password endpoints. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++entry.n > max) {
      res.setHeader("Retry-After", Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }
    next();
  };
}
const authLimiter = rateLimit(20, 15 * 60 * 1000);

// ------------------------------------------------------------- auth

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, "Password must be at least 8 characters.").max(200);

app.get("/api/status", (_req, res) => {
  res.json({ ai: aiMode(), googleOAuth: googleConfigured(), signup: ALLOW_SIGNUP });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not signed in" });
  res.json(req.user);
});

app.post("/api/auth/signup", authLimiter, async (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: "Sign-ups are closed on this JARVIS." });
  const body = z.object({ email, name: z.string().trim().min(1).max(80), password }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0].message });
  try {
    const user = await createUser(body.data.email, body.data.name, body.data.password);
    setSessionCookie(res, createSession(user.id));
    res.status(201).json(user);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const body = z.object({ email, password: z.string().max(200) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Enter your email and password." });
  const user = await authenticate(body.data.email, body.data.password);
  if (!user) return res.status(401).json({ error: "Wrong email or password." });
  setSessionCookie(res, createSession(user.id));
  res.json(user);
});

app.post("/api/auth/logout", (req, res) => {
  if (req.token) deleteSession(req.token);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.post("/api/auth/password", requireUser, authLimiter, async (req, res) => {
  const body = z.object({ current: z.string().max(200), next: password }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0].message });
  if (!(await changePassword(req.user!.id, body.data.current, body.data.next))) {
    return res.status(401).json({ error: "Current password is wrong." });
  }
  deleteOtherSessions(req.user!.id, req.token!); // sign out everywhere else
  res.json({ ok: true });
});

app.delete("/api/auth/me", requireUser, authLimiter, async (req, res) => {
  const body = z.object({ password: z.string().max(200) }).safeParse(req.body);
  if (!body.success || !(await authenticate(req.user!.email, body.data.password))) {
    return res.status(401).json({ error: "Password is wrong." });
  }
  deleteUser(req.user!.id);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ------------------------------------------------------------- connectors + accounts

app.get("/api/connectors", (_req, res) => {
  res.json(CONNECTORS.map(describeConnector));
});

app.get("/api/accounts", requireUser, (req, res) => {
  res.json([...listAccounts(req.user!.id).values()].map(publicAccount));
});

const connectBody = z.object({
  demo: z.boolean().default(false),
  creds: z.record(z.string(), z.string().max(4000)).default({}),
});

app.post("/api/accounts/:provider", requireUser, async (req, res) => {
  const connector = getConnector(String(req.params.provider));
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
  const account = { userId: req.user!.id, provider: connector.id, creds: demo ? {} : clean, demo, connectedAt: Date.now() };
  saveAccount(account);
  res.json(publicAccount(account));
});

app.delete("/api/accounts/:provider", requireUser, (req, res) => {
  deleteAccount(req.user!.id, String(req.params.provider));
  res.json({ ok: true });
});

// ------------------------------------------------------------- Google OAuth

const oauthStates = new Map<string, { userId: string; expires: number }>();

app.get("/api/oauth/google/start", requireUser, (req, res) => {
  if (!googleConfigured()) return res.status(400).send("Google OAuth is not configured on this server (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, { userId: req.user!.id, expires: Date.now() + 10 * 60 * 1000 });
  res.redirect(googleAuthUrl(state));
});

app.get("/api/oauth/google/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const back = (status: string) => res.redirect(`${APP_URL}/?connected=google&status=${encodeURIComponent(status)}`);
  const pending = state ? oauthStates.get(state) : undefined;
  if (state) oauthStates.delete(state);
  if (error) return back(error);
  // The state must be one we issued, still fresh, and for the user whose browser came back.
  if (!code || !pending || pending.expires < Date.now() || pending.userId !== req.user?.id) return back("invalid_state");
  try {
    const creds = await exchangeGoogleCode(code);
    saveAccount({ userId: pending.userId, provider: "google", creds, demo: false, connectedAt: Date.now() });
    back("ok");
  } catch (err) {
    console.error(err);
    back("token_error");
  }
});

// ------------------------------------------------------------- live widget data

app.get("/api/data/:provider/:metric", requireUser, async (req, res) => {
  const account = getAccount(req.user!.id, String(req.params.provider));
  if (!account) return res.status(404).json({ error: `${String(req.params.provider)} is not connected` });
  try {
    res.json({ data: await accountMetric(account, String(req.params.metric)), at: Date.now() });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ------------------------------------------------------------- dashboards (saved per user)

const VIZ = z.enum(["stat", "line", "area", "bar", "list"]);
const widgetSchema = z.object({
  id: z.string().max(64),
  title: z.string().max(200),
  provider: z.string().max(64),
  metric: z.string().max(64),
  viz: VIZ,
  refreshSec: z.number().int().min(10).max(3600),
});
const gridItem = z.object({ i: z.string().max(64), x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const dashboardSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(120),
  widgets: z.array(widgetSchema).max(100),
  layout: z.array(gridItem).max(100),
});
const dashboardsState = z.object({ dashboards: z.array(dashboardSchema).min(1).max(50), activeId: z.string().max(64) });

app.get("/api/dashboards", requireUser, (req, res) => {
  res.json({ state: getDashboards(req.user!.id) });
});

app.put("/api/dashboards", requireUser, (req, res) => {
  saveDashboards(req.user!.id, dashboardsState.parse(req.body));
  res.json({ ok: true });
});

// ------------------------------------------------------------- chat

const chatBody = z.object({
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) })).min(1).max(100),
  dashboard: z.object({ id: z.string(), name: z.string(), widgets: z.array(widgetSchema).max(100) }),
});

app.post("/api/chat", requireUser, async (req, res) => {
  const { history, dashboard } = chatBody.parse(req.body);
  try {
    res.json(await runAgent(history, listAccounts(req.user!.id), dashboard, req.user!.name));
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
