import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { pool, withSystem } from "../db/pool.js";
import { requireUser } from "../auth/sessions.js";
import { inBusiness, isUuid } from "../auth/access.js";
import { audit } from "../lib/audit.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { AppError, badRequest, notFound, prerequisite } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { decryptJson } from "../lib/crypto.js";
import { saveCredentials } from "../connectors/credentials.js";
import { ProviderError } from "../connectors/http.js";
import { catalog, connectorStatus, getConnector } from "../connectors/registry.js";
import { enqueue } from "../jobs/queue.js";

export const connectionsRouter = Router();

const redirectUri = (provider: string) => `${config.apiUrl}/api/oauth/${provider}/callback`;

connectionsRouter.get("/businesses/:businessId/connectors", requireUser, async (req, res) => {
  await inBusiness(req, req.params.businessId, "connection.read", async () => undefined);
  res.json(catalog());
});

connectionsRouter.get("/businesses/:businessId/connections", requireUser, async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "connection.read", async ({ db, business }) => {
    const conns = await db.query(
      // Explicit columns: the app role cannot read credentials_enc (column-level grant).
      `SELECT c.id, c.provider, c.display_name, c.external_account_id, c.status, c.is_demo, c.scopes, c.settings,
              c.last_success_at, c.last_sync_started_at, c.last_error, c.last_error_at, c.consecutive_failures, c.created_at, c.disconnected_at,
              coalesce(json_agg(json_build_object(
                'id', a.id, 'name', a.name, 'kind', a.kind, 'selected', a.selected, 'currency', a.currency, 'timezone', a.timezone,
                'latestDataDate', a.latest_data_date, 'lastSyncedAt', a.last_synced_at, 'coveredFrom', a.sync_cursor->>'coveredFrom')
              ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL), '[]') AS assets
         FROM connections c LEFT JOIN connection_assets a ON a.connection_id = c.id
        WHERE c.business_id = $1 GROUP BY c.id ORDER BY c.disconnected_at NULLS FIRST, c.created_at`,
      [business.id],
    );
    const jobs = await db.query(
      `SELECT DISTINCT ON (connection_id) connection_id, id, type, status, attempts, last_error, created_at, finished_at, run_at, result
         FROM jobs WHERE business_id = $1 AND type = 'connection.sync' ORDER BY connection_id, created_at DESC`,
      [business.id],
    );
    const latestJob = new Map(jobs.rows.map((j) => [j.connection_id, j]));
    return conns.rows.map((c) => {
      const def = getConnector(c.provider);
      const j = latestJob.get(c.id);
      return {
        id: c.id,
        provider: c.provider,
        providerName: def?.name ?? c.provider,
        accountName: c.display_name,
        externalAccountId: c.external_account_id,
        status: c.disconnected_at ? "disconnected" : c.status,
        isDemo: c.is_demo,
        scopes: c.scopes,
        requestedScopes: def?.scopes ?? [],
        assets: c.assets,
        lastSuccessAt: c.last_success_at,
        lastSyncStartedAt: c.last_sync_started_at,
        lastError: c.last_error,
        lastErrorAt: c.last_error_at,
        consecutiveFailures: c.consecutive_failures,
        webhookTopics: c.settings?.webhookTopics ?? [],
        reportingDelay: def?.reportingDelay ?? null,
        latestJob: j ? { id: j.id, status: j.status, attempts: j.attempts, lastError: j.last_error, createdAt: j.created_at, finishedAt: j.finished_at, nextAttemptAt: j.status === "queued" ? j.run_at : null, result: j.result } : null,
        connectedAt: c.created_at,
        disconnectedAt: c.disconnected_at,
      };
    });
  });
  res.json(out);
});

connectionsRouter.get("/businesses/:businessId/connections/:connectionId/jobs", requireUser, async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "connection.read", async ({ db, business }) => {
    if (!isUuid(req.params.connectionId)) throw notFound("Connection");
    const { rows } = await db.query(
      `SELECT id, type, status, attempts, max_attempts, last_error, created_at, started_at, finished_at, run_at, result
         FROM jobs WHERE business_id = $1 AND connection_id = $2 ORDER BY created_at DESC LIMIT 30`,
      [business.id, req.params.connectionId],
    );
    return rows;
  });
  res.json(out);
});

// ------------------------------------------------------------------ authorize

const authorizeBody = z.object({ input: z.record(z.string(), z.string().max(300)).default({}), connectionId: z.uuid().optional() });

connectionsRouter.post("/businesses/:businessId/connections/:provider/authorize", requireUser, async (req, res) => {
  const body = authorizeBody.parse(req.body);
  const provider = String(req.params.provider);
  const def = getConnector(provider);
  if (!def?.authorizeUrl) throw prerequisite("This connector isn't available yet.");
  const { status, missingConfig } = connectorStatus(def);
  if (status === "config_required") throw prerequisite(`${def.name} isn't configured on this platform yet. An administrator must set: ${missingConfig.join(", ")}.`, { missingConfig });
  if (status === "access_pending") throw prerequisite(`${def.name} access is pending approval from the provider.`);

  const url = await inBusiness(req, req.params.businessId, "connection.manage", async ({ business, userId }) => {
    if (business.is_demo) throw badRequest("Demo businesses can't connect real accounts. Create a real business first.");
    const state = randomToken(24);
    let authUrl: string;
    try {
      authUrl = def.authorizeUrl!({ state, redirectUri: redirectUri(provider), input: body.input });
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Invalid input");
    }
    await withSystem(async (db) => {
      if (body.connectionId) {
        const c = await db.query("SELECT 1 FROM connections WHERE id = $1 AND business_id = $2 AND provider = $3", [body.connectionId, business.id, provider]);
        if (!c.rowCount) throw notFound("Connection");
      }
      await db.query(
        `INSERT INTO oauth_states (state_hash, user_id, workspace_id, business_id, provider, connection_id, input, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 minutes')`,
        [sha256(state), userId, business.workspace_id, business.id, provider, body.connectionId ?? null, JSON.stringify(body.input)],
      );
    });
    return authUrl;
  });
  res.json({ url });
});

// ------------------------------------------------------------------ OAuth callback

export const oauthRouter = Router();

oauthRouter.get("/oauth/:provider/callback", async (req: Request, res: Response) => {
  const provider = String(req.params.provider);
  const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
  const fail = (bid: string | null, message: string) =>
    res.redirect(`${config.appUrl}${bid ? `/app/b/${bid}/connections` : "/app"}?oauth_error=${encodeURIComponent(message)}`);

  const def = getConnector(provider);
  if (!def?.handleCallback || !query.state) return fail(null, "Invalid authorization response.");
  // One-time state, bound to the user who started the flow, valid for 10 minutes.
  const { rows } = await pool.query(
    `UPDATE oauth_states SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now() AND provider = $2 RETURNING *`,
    [sha256(query.state), provider],
  );
  const st = rows[0];
  if (!st) return fail(null, "This authorization link expired or was already used. Please try connecting again.");
  if (!req.user || req.user.id !== st.user_id) return fail(st.business_id, "Please finish connecting in the same browser session you started from.");
  if (query.error) return fail(st.business_id, query.error_description || "Authorization was declined.");

  try {
    const result = await def.handleCallback({ query, redirectUri: redirectUri(provider), input: st.input });
    const connectionId = await withSystem(async (db) => {
      // Re-authorization keeps the existing connection; connecting the same account again reuses it.
      let id: string | null = st.connection_id;
      if (!id) {
        const existing = await db.query(
          `SELECT id FROM connections WHERE business_id = $1 AND provider = $2 AND external_account_id = $3 AND disconnected_at IS NULL`,
          [st.business_id, provider, result.externalAccountId],
        );
        id = existing.rows[0]?.id ?? null;
      }
      if (id) {
        await db.query(
          `UPDATE connections SET display_name = $2, scopes = $3, external_account_id = $4, settings = settings || $5::jsonb,
                  status = CASE WHEN status IN ('reauth_required', 'error') THEN 'active' ELSE status END, last_error = NULL, consecutive_failures = 0, updated_at = now()
            WHERE id = $1`,
          [id, result.displayName, result.scopes, result.externalAccountId, JSON.stringify(result.settings ?? {})],
        );
      } else {
        const ins = await db.query(
          `INSERT INTO connections (workspace_id, business_id, provider, display_name, external_account_id, status, scopes, settings, created_by)
           VALUES ($1, $2, $3, $4, $5, 'selecting_assets', $6, $7, $8) RETURNING id`,
          [st.workspace_id, st.business_id, provider, result.displayName, result.externalAccountId, result.scopes, JSON.stringify(result.settings ?? {}), st.user_id],
        );
        id = ins.rows[0].id as string;
      }
      await saveCredentials(db, id, result.credentials, result.tokenExpiresAt ?? null);
      const connection = (await db.query("SELECT * FROM connections WHERE id = $1", [id])).rows[0];
      const assets = def.discoverAssets ? await def.discoverAssets(result.credentials, connection) : [];
      for (const a of assets) {
        await db.query(
          `INSERT INTO connection_assets (workspace_id, business_id, connection_id, provider_asset_id, name, kind, currency, timezone, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (connection_id, provider_asset_id) DO UPDATE SET name = excluded.name, currency = excluded.currency, timezone = excluded.timezone, metadata = excluded.metadata`,
          [st.workspace_id, st.business_id, id, a.providerAssetId, a.name, a.kind, a.currency ?? null, a.timezone ?? null, JSON.stringify(a.metadata ?? {})],
        );
      }
      await audit(db, { workspaceId: st.workspace_id, businessId: st.business_id, actorUserId: st.user_id, action: st.connection_id ? "connection.reauthorized" : "connection.authorized", targetType: "connection", targetId: id, metadata: { provider, account: result.externalAccountId, scopes: result.scopes } });
      await db.query("SELECT app.notify_business($1, 'connection_updated', $2)", [st.business_id, JSON.stringify({ connectionId: id })]);
      return id;
    });
    res.redirect(`${config.appUrl}/app/b/${st.business_id}/connections?connection=${connectionId}${st.connection_id ? "&reconnected=1" : "&step=assets"}`);
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : "We couldn't complete the connection. Please try again.";
    if (!(e instanceof ProviderError)) console.error("[oauth] callback failed", e);
    else if (e.detail) console.warn("[oauth] provider error", e.kind, e.detail.slice(0, 300));
    fail(st.business_id, msg);
  }
});

// ------------------------------------------------------------------ assets, sync, disconnect

connectionsRouter.put("/businesses/:businessId/connections/:connectionId/assets", requireUser, async (req, res) => {
  const body = z.object({ assetIds: z.array(z.uuid()).min(1, "Select at least one account to sync").max(100) }).parse(req.body);
  await inBusiness(req, req.params.businessId, "connection.manage", async ({ business, userId }) => {
    if (!isUuid(req.params.connectionId)) throw notFound("Connection");
    await withSystem(async (db) => {
      const c = await db.query("SELECT id, provider FROM connections WHERE id = $1 AND business_id = $2 AND disconnected_at IS NULL", [req.params.connectionId, business.id]);
      if (!c.rows[0]) throw notFound("Connection");
      const valid = await db.query("SELECT id FROM connection_assets WHERE connection_id = $1 AND id = ANY($2::uuid[])", [req.params.connectionId, body.assetIds]);
      if (valid.rowCount !== new Set(body.assetIds).size) throw badRequest("Unknown account selected.");
      await db.query("UPDATE connection_assets SET selected = (id = ANY($2::uuid[])) WHERE connection_id = $1", [req.params.connectionId, body.assetIds]);
      await db.query("UPDATE connections SET status = 'syncing', updated_at = now() WHERE id = $1", [req.params.connectionId]);
      await enqueue(db, { type: "connection.sync", workspaceId: business.workspace_id, businessId: business.id, connectionId: String(req.params.connectionId), payload: { mode: "initial" }, dedupeKey: `sync:${req.params.connectionId}`, priority: 5, createdBy: userId });
      await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: "connection.assets_selected", targetType: "connection", targetId: String(req.params.connectionId), metadata: { assetIds: body.assetIds } });
      await db.query("SELECT app.notify_business($1, 'connection_updated', $2)", [business.id, JSON.stringify({ connectionId: req.params.connectionId })]);
    });
  });
  res.json({ ok: true });
});

const syncLimiter = rateLimit({ name: "sync-now", max: 10, windowMs: 10 * 60_000, key: (req) => `${req.user?.id}:${req.params.connectionId}` });

connectionsRouter.post("/businesses/:businessId/connections/:connectionId/sync", requireUser, syncLimiter, async (req, res) => {
  const out = await inBusiness(req, req.params.businessId, "connection.manage", async ({ business, userId }) => {
    if (!isUuid(req.params.connectionId)) throw notFound("Connection");
    return withSystem(async (db) => {
      const c = await db.query("SELECT status, is_demo FROM connections WHERE id = $1 AND business_id = $2 AND disconnected_at IS NULL", [req.params.connectionId, business.id]);
      if (!c.rows[0]) throw notFound("Connection");
      if (c.rows[0].is_demo) throw badRequest("Demo connections don't sync.");
      if (c.rows[0].status === "reauth_required") throw prerequisite("Reconnect this account before syncing.");
      if (c.rows[0].status === "selecting_assets") throw prerequisite("Choose which accounts to sync first.");
      return enqueue(db, { type: "connection.sync", workspaceId: business.workspace_id, businessId: business.id, connectionId: String(req.params.connectionId), payload: { mode: "incremental" }, dedupeKey: `sync:${req.params.connectionId}`, priority: 3, createdBy: userId });
    });
  });
  res.status(202).json({ jobId: out.id, alreadyQueued: out.duplicate });
});

connectionsRouter.delete("/businesses/:businessId/connections/:connectionId", requireUser, async (req, res) => {
  const body = z.object({ deleteData: z.boolean().default(false) }).parse(req.body ?? {});
  const out = await inBusiness(req, req.params.businessId, "connection.manage", async ({ business, userId }) => {
    if (!isUuid(req.params.connectionId)) throw notFound("Connection");
    return withSystem(async (db) => {
      const { rows } = await db.query("SELECT * FROM connections WHERE id = $1 AND business_id = $2", [req.params.connectionId, business.id]);
      const c = rows[0];
      if (!c) throw notFound("Connection");
      if (c.is_demo) throw badRequest("Demo connections are removed by deleting the demo business.");
      // Best effort: revoke at the provider so the token stops working immediately.
      let revoked = false;
      const def = getConnector(c.provider);
      if (def?.revoke && c.credentials_enc && !c.disconnected_at) {
        try {
          await def.revoke(decryptJson(c.credentials_enc), c);
          revoked = true;
        } catch (e) {
          console.warn("[connections] revoke failed", (e as Error).message);
        }
      }
      await db.query(
        `UPDATE connections SET credentials_enc = NULL, token_expires_at = NULL, status = 'disconnected', disconnected_at = coalesce(disconnected_at, now()), updated_at = now() WHERE id = $1`,
        [c.id],
      );
      await db.query("UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE connection_id = $1 AND status = 'queued'", [c.id]);
      if (body.deleteData) {
        await db.query("DELETE FROM metric_facts WHERE connection_id = $1", [c.id]);
        await db.query("DELETE FROM source_records WHERE connection_id = $1", [c.id]);
        await db.query("DELETE FROM connections WHERE id = $1", [c.id]);
      }
      await audit(db, { workspaceId: business.workspace_id, businessId: business.id, actorUserId: userId, action: body.deleteData ? "connection.deleted_with_data" : "connection.disconnected", targetType: "connection", targetId: c.id, metadata: { provider: c.provider, revoked } });
      await db.query("SELECT app.notify_business($1, 'data_updated', $2)", [business.id, JSON.stringify({ connectionId: c.id })]);
      return { revoked };
    });
  });
  res.json(out);
});

export { AppError };
