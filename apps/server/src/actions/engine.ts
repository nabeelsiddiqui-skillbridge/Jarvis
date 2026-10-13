import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActionProposal, ActionTypeInfo } from "@bca/shared";
import { audit } from "../lib/audit.js";
import { businessAdmins, notifyUsers } from "../lib/notify.js";
import { conflict, forbidden, notFound, prerequisite } from "../lib/errors.js";
import { getCredentials } from "../connectors/credentials.js";
import { ProviderError } from "../connectors/http.js";
import { getConnector } from "../connectors/registry.js";
import type { ActionContext, ActionDefinition, ActionPayload, AssetRow, ConnectionRow } from "../connectors/types.js";
import { PROVIDER_META } from "../metrics/providers.js";
import { enqueue } from "../jobs/queue.js";
import { assertEnabled, isEnabled } from "../lib/flags.js";

/**
 * External actions.
 *  1. Propose: read live provider state, validate with the provider where it can
 *     (no change made), store the exact payload + its SHA-256 hash.
 *  2. Approve: an administrator approves *that hash*. Any change to the payload
 *     means a new proposal and a new approval.
 *  3. Execute (worker): re-verify approval + hash + permissions + connection,
 *     re-read live state (drift → stop; already applied → done), then call the
 *     provider once. Ambiguous failures (timeouts, 5xx) are resolved by reading
 *     the provider's state before any retry, so the change is never applied twice.
 */

const EXPIRY_HOURS = 24;

/** Stable JSON (sorted keys) so the same payload always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const hashPayload = (p: ActionPayload) => createHash("sha256").update(canonical(p)).digest("hex");

export function findAction(provider: string, type: string): ActionDefinition | null {
  return getConnector(provider)?.actionDefs?.find((a) => a.type === type) ?? null;
}

const FLAG_OFF = "External actions are turned off for this workspace by the platform administrator.";

function unavailable(connection: ConnectionRow, def: ActionDefinition): string | null {
  if (connection.is_demo) return "Actions aren't available on demo data — nothing would be changed anywhere.";
  if (connection.status === "reauth_required") return "Reconnect this account first.";
  if (connection.status === "disconnected") return "This account is disconnected.";
  const missing = def.requiredScopes.filter((s) => !(connection.scopes ?? []).includes(s));
  if (missing.length) {
    return connection.provider === "hubspot"
      ? "This connection was authorized read-only. The platform operator must enable HubSpot actions (HUBSPOT_ENABLE_ACTIONS), then reconnect HubSpot to grant write access."
      : `This connection is missing the permission ${missing.join(", ")}. Reconnect the account to grant it.`;
  }
  return null;
}

async function loadConnection(db: pg.PoolClient, businessId: string, connectionId: string) {
  const c = (await db.query(`SELECT id, workspace_id, business_id, provider, display_name, external_account_id, status, scopes, settings, is_demo FROM connections WHERE id = $1 AND business_id = $2 AND disconnected_at IS NULL`, [connectionId, businessId])).rows[0] as ConnectionRow | undefined;
  if (!c) throw notFound("Connection");
  return c;
}

async function contextFor(db: pg.PoolClient, connection: ConnectionRow, assetId: string | null): Promise<ActionContext> {
  const def = getConnector(connection.provider)!;
  const assets = (await db.query(`SELECT * FROM connection_assets WHERE connection_id = $1 AND selected ORDER BY created_at`, [connection.id])).rows as AssetRow[];
  return { db, connection, assets, asset: assets.find((a) => a.id === assetId) ?? assets[0] ?? null, credentials: () => getCredentials(def, connection.id) };
}

/** Actions each connection of the business supports, and why one can't be used. */
export async function listActionTypes(db: pg.PoolClient, businessId: string): Promise<ActionTypeInfo[]> {
  const conns = (await db.query(`SELECT id, workspace_id, business_id, provider, display_name, external_account_id, status, scopes, settings, is_demo FROM connections WHERE business_id = $1 AND disconnected_at IS NULL ORDER BY created_at`, [businessId])).rows as ConnectionRow[];
  const out: ActionTypeInfo[] = [];
  const enabled = conns.length ? await isEnabled("external_actions", conns[0]!.workspace_id) : true;
  for (const c of conns) {
    for (const a of getConnector(c.provider)?.actionDefs ?? []) {
      const reason = enabled ? unavailable(c, a) : FLAG_OFF;
      out.push({ type: a.type, label: a.label, description: a.description, targetKind: a.targetKind, connectionId: c.id, connectionName: c.display_name, provider: c.provider, providerName: PROVIDER_META[c.provider]?.name ?? c.provider, available: !reason, unavailableReason: reason });
    }
  }
  return out;
}

export async function listTargets(db: pg.PoolClient, businessId: string, connectionId: string, type: string) {
  const c = await loadConnection(db, businessId, connectionId);
  const def = findAction(c.provider, type);
  if (!def) throw notFound("Action");
  const reason = unavailable(c, def);
  if (reason) throw prerequisite(reason);
  return def.listTargets(await contextFor(db, c, null));
}

/**
 * Create a proposal. `db` is the user's RLS transaction (system-only provider reads
 * happen with server-held credentials and never reach the browser).
 */
export async function propose(db: pg.PoolClient, p: { business: { id: string; workspace_id: string; name: string }; userId: string; connectionId: string; type: string; targetId: string; params: Record<string, unknown>; source: "user" | "assistant"; conversationId?: string | null }) {
  await assertEnabled("external_actions", p.business.workspace_id);
  const c = await loadConnection(db, p.business.id, p.connectionId);
  const def = findAction(c.provider, p.type);
  if (!def) throw notFound("Action");
  const reason = unavailable(c, def);
  if (reason) throw prerequisite(reason);
  let prepared;
  try {
    prepared = await def.prepare(await contextFor(db, c, null), p.targetId, p.params);
  } catch (e) {
    if (e instanceof ProviderError) throw prerequisite(e.message);
    throw e;
  }
  const payload: ActionPayload = { type: def.type, connectionId: c.id, assetId: prepared.assetId, target: prepared.target, params: prepared.params };
  const hash = hashPayload(payload);
  const id = randomUUID();
  // A newer version of the same change replaces older pending ones (they'd need re-approval anyway).
  const older = await db.query(
    `UPDATE action_proposals SET status = 'superseded', updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND action_type = $3 AND target->>'id' = $4 AND status = 'pending_approval' RETURNING id`,
    [p.business.id, c.id, def.type, prepared.target.id],
  );
  await db.query(
    `INSERT INTO action_proposals (id, workspace_id, business_id, connection_id, asset_id, provider, action_type, payload, payload_hash, target, current_state, proposed_state, expected_effect, risk, source, conversation_id, proposed_by, supersedes, idempotency_key, expires_at, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now() + interval '${EXPIRY_HOURS} hours', $20)`,
    [id, p.business.workspace_id, p.business.id, c.id, prepared.assetId, c.provider, def.type, JSON.stringify(payload), hash, JSON.stringify(prepared.target), JSON.stringify(prepared.current), JSON.stringify(prepared.proposed),
      prepared.expectedEffect, prepared.risk, p.source, p.conversationId ?? null, p.userId, older.rows[0]?.id ?? null, `action:${id}`, JSON.stringify({ changes: prepared.changes })],
  );
  await audit(db, { workspaceId: p.business.workspace_id, businessId: p.business.id, actorUserId: p.userId, action: "action.proposed", targetType: "action", targetId: id, metadata: { type: def.type, target: prepared.target, params: prepared.params, hash, source: p.source } });
  return { id, hash };
}

export async function notifyApprovers(db: pg.PoolClient, business: { id: string; workspace_id: string }, proposalId: string, title: string, proposerId: string) {
  const admins = (await businessAdmins(db, business.id)).filter((u) => u !== proposerId);
  const to = admins.length ? admins : await businessAdmins(db, business.id);
  await notifyUsers(db, { workspaceId: business.workspace_id, businessId: business.id, userIds: to, kind: "action_approval", title: `Approval needed: ${title}`, body: "Review the change before it's made in the connected account.", link: `/app/b/${business.id}/automations?tab=actions&action=${proposalId}`, dedupeKey: `action:${proposalId}` });
}

/** Approve or reject. Runs in the approver's RLS transaction; permission already checked by the route. */
export async function decide(db: pg.PoolClient, p: { business: { id: string; workspace_id: string }; userId: string; proposalId: string; payloadHash: string; decision: "approved" | "rejected"; comment?: string }) {
  const row = (await db.query(`SELECT * FROM action_proposals WHERE id = $1 AND business_id = $2 FOR UPDATE`, [p.proposalId, p.business.id])).rows[0];
  if (!row) throw notFound("Action");
  if (p.decision === "approved") await assertEnabled("external_actions", p.business.workspace_id);
  if (row.status !== "pending_approval") throw conflict(`This action is ${row.status.replace(/_/g, " ")}; it can't be ${p.decision} now.`);
  if (new Date(row.expires_at) < new Date()) {
    await db.query(`UPDATE action_proposals SET status = 'expired', updated_at = now() WHERE id = $1`, [row.id]);
    throw conflict("This proposal expired. Create it again to review current values.");
  }
  // Approval is bound to the exact payload the approver reviewed.
  if (p.payloadHash !== row.payload_hash) throw conflict("The action changed since you reviewed it. Review the current version and approve again.");
  if (p.decision === "approved" && row.risk === "high" && row.proposed_by === p.userId) {
    const others = (await businessAdmins(db, p.business.id)).filter((u) => u !== p.userId);
    if (others.length) throw forbidden("High-risk actions need approval from a different administrator than the person who proposed them.");
  }
  await db.query(`INSERT INTO action_approvals (proposal_id, business_id, payload_hash, decision, decided_by, comment) VALUES ($1, $2, $3, $4, $5, $6)`, [row.id, p.business.id, row.payload_hash, p.decision, p.userId, p.comment ?? null]);
  await db.query(`UPDATE action_proposals SET status = $2, updated_at = now() WHERE id = $1`, [row.id, p.decision === "approved" ? "approved" : "rejected"]);
  await audit(db, { workspaceId: p.business.workspace_id, businessId: p.business.id, actorUserId: p.userId, action: `action.${p.decision}`, targetType: "action", targetId: row.id, metadata: { hash: row.payload_hash, comment: p.comment } });
  return row;
}

// ------------------------------------------------------------------ execution (worker, system role)

const same = (a: Record<string, unknown>, b: Record<string, unknown>) => canonical(a) === canonical(b);

async function attempt(db: pg.PoolClient, row: any, n: number, kind: "status_check" | "execute", outcome: string, detail: unknown) {
  await db.query(`INSERT INTO action_attempts (proposal_id, business_id, attempt, kind, outcome, detail) VALUES ($1, $2, $3, $4, $5, $6)`, [row.id, row.business_id, n, kind, outcome, JSON.stringify(detail ?? null)]);
}

async function finish(db: pg.PoolClient, row: any, status: "succeeded" | "failed", fields: { response?: unknown; error?: string; result?: Record<string, unknown> }) {
  await db.query(
    `UPDATE action_proposals SET status = $2, provider_response = COALESCE($3, provider_response), error = $4, result = result || $5::jsonb, executed_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE executed_at END, updated_at = now() WHERE id = $1`,
    [row.id, status, fields.response === undefined ? null : JSON.stringify(fields.response), fields.error ?? null, JSON.stringify(fields.result ?? {})],
  );
  await audit(db, { workspaceId: row.workspace_id, businessId: row.business_id, actorType: "system", action: status === "succeeded" ? "action.executed" : "action.failed", targetType: "action", targetId: row.id, metadata: { type: row.action_type, target: row.target, error: fields.error, response: fields.response } });
  const approver = (await db.query(`SELECT decided_by FROM action_approvals WHERE proposal_id = $1`, [row.id])).rows[0]?.decided_by;
  const users = [...new Set([row.proposed_by, approver].filter(Boolean))];
  await notifyUsers(db, { workspaceId: row.workspace_id, businessId: row.business_id, userIds: users, kind: "action_result", title: status === "succeeded" ? `Done: ${row.target.name}` : `Action failed: ${row.target.name}`, body: status === "succeeded" ? "The change was made in the connected account." : fields.error ?? "", link: `/app/b/${row.business_id}/automations?tab=actions&action=${row.id}`, dedupeKey: `action-result:${row.id}` });
  await db.query("SELECT app.notify_business($1, 'actions_updated', '{}')", [row.business_id]);
}

/** Returns "retry" when the outcome is unknown and the job should try again later. */
export async function executeProposal(db: pg.PoolClient, proposalId: string): Promise<"done" | "retry" | "skipped"> {
  // Claim under a row lock: only approved / ambiguous proposals proceed, one worker at a time.
  await db.query("BEGIN");
  let row: any;
  try {
    row = (await db.query(`SELECT * FROM action_proposals WHERE id = $1 FOR UPDATE`, [proposalId])).rows[0];
    if (!row || !["approved", "executing", "needs_check"].includes(row.status)) { await db.query("COMMIT"); return "skipped"; }
    await db.query(`UPDATE action_proposals SET status = 'executing', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [row.id]);
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  const n = row.attempts + 1;
  const fail = (error: string, extra: Record<string, unknown> = {}) => finish(db, row, "failed", { error, ...extra }).then(() => "done" as const);

  // 1. Re-verify everything the approval depended on.
  const approval = (await db.query(`SELECT * FROM action_approvals WHERE proposal_id = $1`, [row.id])).rows[0];
  if (!approval || approval.decision !== "approved") return fail("No valid approval for this action.");
  if (approval.payload_hash !== row.payload_hash || hashPayload(row.payload) !== row.payload_hash) return fail("The action no longer matches what was approved; nothing was changed.");
  const approverStillAllowed = (await businessAdmins(db, row.business_id)).includes(approval.decided_by);
  if (!approverStillAllowed) return fail("The approver no longer has permission to approve actions for this business; nothing was changed.");
  const connection = (await db.query(`SELECT id, workspace_id, business_id, provider, display_name, external_account_id, status, scopes, settings, is_demo FROM connections WHERE id = $1 AND disconnected_at IS NULL`, [row.connection_id])).rows[0] as ConnectionRow | undefined;
  if (!connection) return fail("The connection was removed; nothing was changed.");
  const def = findAction(connection.provider, row.action_type);
  if (!def) return fail("This action is no longer supported by the connector.");
  const reason = unavailable(connection, def);
  if (reason) return fail(`${reason} Nothing was changed.`);
  const ctx = await contextFor(db, connection, row.asset_id);
  const payload = row.payload as ActionPayload;

  // 2. Read live state first: already applied (e.g. after a timeout) → done; changed by someone else → stop.
  let live: Record<string, unknown>;
  try {
    live = await def.readState(ctx, payload);
  } catch (e) {
    await attempt(db, row, n, "status_check", "unknown", { error: (e as Error).message });
    if (e instanceof ProviderError && e.retryable) { await setStatus(db, row.id, "needs_check"); return "retry"; }
    return fail(`Couldn't read the current state from ${PROVIDER_META[connection.provider]?.name ?? connection.provider}: ${(e as Error).message}`);
  }
  if (same(live, row.proposed_state)) {
    await attempt(db, row, n, "status_check", "applied", live);
    await finish(db, row, "succeeded", { result: { confirmedBy: "status_check", live } });
    return "done";
  }
  // Checked after the status read so an ambiguous earlier attempt is still resolved truthfully.
  if (!(await isEnabled("external_actions", row.workspace_id))) return fail(`${FLAG_OFF} Nothing was changed.`);
  if (!same(live, row.current_state)) {
    await attempt(db, row, n, "status_check", "drift", { expected: row.current_state, live });
    return fail("The value in the connected account changed after this was approved, so nothing was changed. Create a new proposal to review the current value.", { result: { live } });
  }
  await attempt(db, row, n, "status_check", "not_applied", live);

  // 3. Execute once.
  try {
    const { response } = await def.execute(ctx, payload);
    await attempt(db, row, n, "execute", "succeeded", response);
    await finish(db, row, "succeeded", { response, result: { confirmedBy: "provider_response" } });
    return "done";
  } catch (e) {
    const pe = e instanceof ProviderError ? e : null;
    if (pe?.retryable) {
      // Timeout / 5xx: the change may or may not have been applied. Check status before any retry.
      await attempt(db, row, n, "execute", "ambiguous", { error: pe.message, status: pe.status });
      await setStatus(db, row.id, "needs_check");
      return "retry";
    }
    await attempt(db, row, n, "execute", "failed", { error: (e as Error).message, status: pe?.status, detail: pe?.detail?.slice(0, 500) });
    return fail(pe ? pe.message : "The action failed unexpectedly.", { response: pe?.detail ? { error: pe.detail.slice(0, 500) } : undefined });
  }
}

async function setStatus(db: pg.PoolClient, id: string, status: string) {
  await db.query(`UPDATE action_proposals SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

export async function queueExecution(db: pg.PoolClient, row: { id: string; workspace_id: string; business_id: string; connection_id: string }) {
  await enqueue(db, { type: "action.execute", workspaceId: row.workspace_id, businessId: row.business_id, connectionId: row.connection_id, payload: { proposalId: row.id }, dedupeKey: `action:${row.id}`, maxAttempts: 6 });
}

/** Called when the job has run out of attempts while the outcome is still unknown. */
export async function giveUp(db: pg.PoolClient, proposalId: string) {
  const row = (await db.query(`SELECT * FROM action_proposals WHERE id = $1`, [proposalId])).rows[0];
  if (row && ["executing", "needs_check", "approved"].includes(row.status)) {
    await finish(db, row, "failed", { error: "The provider didn't confirm the change after several checks. Check the account directly before trying again." });
  }
}

export async function expireOld(db: pg.Pool | pg.PoolClient) {
  await db.query(`UPDATE action_proposals SET status = 'expired', updated_at = now() WHERE status = 'pending_approval' AND expires_at < now()`);
}

// ------------------------------------------------------------------ presentation

const approvalText = (risk: string) => (risk === "high" ? "A business administrator other than the proposer must approve (high risk)." : "A business owner or administrator must approve.");

export async function loadProposals(db: pg.PoolClient, businessId: string, where = "TRUE", args: unknown[] = []): Promise<ActionProposal[]> {
  const { rows } = await db.query(
    `SELECT p.*, b.name AS business_name, c.display_name AS connection_name, a.name AS asset_name, pu.name AS proposed_by_name,
            ap.decision, ap.comment, ap.created_at AS decided_at, du.name AS decided_by_name
       FROM action_proposals p JOIN businesses b ON b.id = p.business_id JOIN connections c ON c.id = p.connection_id
       LEFT JOIN connection_assets a ON a.id = p.asset_id LEFT JOIN users pu ON pu.id = p.proposed_by
       LEFT JOIN action_approvals ap ON ap.proposal_id = p.id LEFT JOIN users du ON du.id = ap.decided_by
      WHERE p.business_id = $1 AND ${where} ORDER BY p.created_at DESC LIMIT 100`,
    [businessId, ...args],
  );
  const attempts = rows.length ? (await db.query(`SELECT * FROM action_attempts WHERE proposal_id = ANY($1::uuid[]) ORDER BY created_at`, [rows.map((r) => r.id)])).rows : [];
  return rows.map((r) => ({
    id: r.id, businessName: r.business_name, provider: r.provider, providerName: PROVIDER_META[r.provider]?.name ?? r.provider, connectionId: r.connection_id, connectionName: r.connection_name, assetName: r.asset_name,
    actionType: r.action_type, actionLabel: findAction(r.provider, r.action_type)?.label ?? r.action_type,
    target: r.target, currentState: r.current_state, proposedState: r.proposed_state, changes: r.result?.changes ?? [], expectedEffect: r.expected_effect, risk: r.risk,
    approvalRequirement: approvalText(r.risk), status: r.status, payloadHash: r.payload_hash, source: r.source,
    proposedBy: r.proposed_by_name, proposedById: r.proposed_by, decidedBy: r.decided_by_name, decidedAt: r.decided_at, decision: r.decision, comment: r.comment,
    error: r.error, providerResponse: r.provider_response, attempts: attempts.filter((a) => a.proposal_id === r.id).map((a) => ({ attempt: a.attempt, kind: a.kind, outcome: a.outcome, detail: a.detail, createdAt: a.created_at })),
    expiresAt: r.expires_at, executedAt: r.executed_at, createdAt: r.created_at,
  }));
}

