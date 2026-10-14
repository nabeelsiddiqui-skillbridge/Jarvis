import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, configStatus } from "./config.js";
import { sessionMiddleware } from "./auth/sessions.js";
import { errorHandler } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { businessesRouter } from "./routes/businesses.js";
import { invitesRouter, workspacesRouter } from "./routes/workspaces.js";
import { metricsRouter } from "./routes/metrics.js";
import { dashboardsRouter } from "./routes/dashboards.js";
import { eventsRouter } from "./routes/events.js";
import { overviewRouter } from "./routes/overview.js";
import { connectionsRouter, oauthRouter } from "./routes/connections.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { assistantRouter } from "./routes/assistant.js";
import { voiceRouter } from "./routes/voice.js";
import { insightsRouter } from "./routes/insights.js";
import { automationsRouter } from "./routes/automations.js";
import { reportsRouter } from "./routes/reports.js";
import { notificationsRouter } from "./routes/notifications.js";
import { commentaryRouter } from "./routes/commentary.js";
import { actionsRouter } from "./routes/actions.js";
import { billingRouter, billingWebhookRouter } from "./routes/billing.js";
import { adminRouter } from "./routes/admin.js";
import { importsBodyParser, importsRouter } from "./routes/imports.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy === "true" ? true : /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
    if (config.isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  // Webhooks need the raw body for signature verification, so they're mounted before JSON parsing.
  app.use("/api", billingWebhookRouter); // before the generic /webhooks/:provider route
  app.use("/api", webhooksRouter);
  app.use("/api/businesses/:businessId/imports", importsBodyParser); // CSV uploads up to 5 MB
  app.use("/api", express.json({ limit: "1mb" }));
  app.use("/api", sessionMiddleware);

  // CSRF: state-changing requests must carry a header only our own frontend sends.
  // (SameSite=Lax session cookies are the first line of defence.) Webhooks are exempt (signature-verified).
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path.startsWith("/webhooks/")) return next();
    if (req.get("X-BCA-Client") !== "web") {
      return res.status(403).json({ error: { code: "csrf", message: "Request blocked: missing client header." } });
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/meta", (_req, res) => {
    const status = Object.fromEntries(configStatus().map((s) => [s.key, s.configured]));
    res.json({ signup: config.allowSignup, ai: status.ANTHROPIC_API_KEY });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/workspaces", workspacesRouter);
  app.use("/api/invites", invitesRouter);
  app.use("/api", businessesRouter);
  app.use("/api", metricsRouter);
  app.use("/api", dashboardsRouter);
  app.use("/api", eventsRouter);
  app.use("/api", overviewRouter);
  app.use("/api", connectionsRouter);
  app.use("/api", oauthRouter);
  app.use("/api", assistantRouter);
  app.use("/api", voiceRouter);
  app.use("/api", insightsRouter);
  app.use("/api", automationsRouter);
  app.use("/api", reportsRouter);
  app.use("/api", notificationsRouter);
  app.use("/api", commentaryRouter);
  app.use("/api", actionsRouter);
  app.use("/api", billingRouter);
  app.use("/api", adminRouter);
  app.use("/api", importsRouter);

  app.use("/api", (_req, res) => res.status(404).json({ error: { code: "not_found", message: "Unknown API route." } }));

  // Serve the built web app in production.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [path.resolve(here, "../../web/dist"), path.resolve(here, "../web/dist")].find((p) => existsSync(p));
  if (webDist) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
