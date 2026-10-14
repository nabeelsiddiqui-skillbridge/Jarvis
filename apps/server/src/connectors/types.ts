import type pg from "pg";
import type { Request } from "express";
import type { ProviderId } from "@bca/shared";

export type CatalogStatus = "available" | "config_required" | "access_pending" | "planned";

export interface AssetInfo {
  providerAssetId: string;
  name: string;
  kind: string;
  currency?: string | null;
  timezone?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  business_id: string;
  provider: string;
  display_name: string;
  external_account_id: string | null;
  status: string;
  scopes: string[];
  settings: Record<string, unknown>;
  is_demo: boolean;
}

export interface AssetRow {
  id: string;
  workspace_id: string;
  business_id: string;
  connection_id: string;
  provider_asset_id: string;
  name: string;
  kind: string;
  currency: string | null;
  timezone: string | null;
  metadata: Record<string, unknown>;
  sync_cursor: Record<string, any>;
}

export type Credentials = Record<string, any>;

/** Everything a connector needs while syncing; all writes are scoped to this connection/asset. */
export interface SyncContext {
  db: pg.PoolClient;
  connection: ConnectionRow;
  asset: AssetRow;
  jobId: string;
  mode: "initial" | "incremental" | "reconcile";
  /** Returns valid credentials, refreshing (with a per-connection lock) when needed. */
  credentials(): Promise<Credentials>;
  log(msg: string): void;
}

export interface SyncResult {
  records: number;
  datesRecomputed: number;
  coveredFrom: string | null;
  coveredTo: string | null;
  notes?: string[];
}

export interface CallbackResult {
  credentials: Credentials;
  scopes: string[];
  externalAccountId: string;
  displayName: string;
  tokenExpiresAt?: Date | null;
  settings?: Record<string, unknown>;
}

/** Context for provider actions: credentials are fetched (and refreshed) on demand. */
export interface ActionContext {
  db: import("pg").PoolClient;
  connection: ConnectionRow;
  asset: AssetRow | null;
  assets: AssetRow[];
  credentials(): Promise<Credentials>;
}

export interface PreparedAction {
  target: { kind: string; id: string; name: string };
  /** The asset (account) the target belongs to. */
  assetId: string | null;
  params: Record<string, unknown>;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  changes: { label: string; current: string; proposed: string }[];
  expectedEffect: string;
  risk: "low" | "medium" | "high";
}

export interface ActionPayload {
  type: string;
  connectionId: string;
  assetId: string | null;
  target: { kind: string; id: string; name: string };
  params: Record<string, unknown>;
}

/**
 * A provider operation the platform can perform after approval. `prepare` reads
 * live state (and validates with the provider where possible) without changing
 * anything; `readState` re-reads the same fields so the executor can detect drift
 * and confirm whether an ambiguous attempt was applied before retrying.
 */
export interface ActionDefinition {
  type: string;
  label: string;
  description: string;
  targetKind: string;
  requiredScopes: string[];
  listTargets(ctx: ActionContext): Promise<import("@bca/shared").ActionTarget[]>;
  prepare(ctx: ActionContext, targetId: string, params: Record<string, unknown>): Promise<PreparedAction>;
  readState(ctx: ActionContext, payload: ActionPayload): Promise<Record<string, unknown>>;
  execute(ctx: ActionContext, payload: ActionPayload): Promise<{ response: unknown }>;
}

export interface VerifiedWebhook {
  deliveryId: string;
  topic: string;
  accountRef: string;
  payload: unknown;
}

/**
 * The connector contract. Each provider implements auth, discovery, sync and
 * (optionally) webhooks, refresh, health checks and revocation. The framework
 * supplies HTTP retries/backoff, token-refresh locking, job retries, de-duplication
 * and fact recomputation.
 */
export interface ConnectorDefinition {
  id: ProviderId | string;
  name: string;
  category: "Commerce" | "Analytics" | "Search" | "Advertising" | "CRM" | "Email" | "Social" | "Payments" | "Accounting" | "Support" | "Inventory" | "Data import";
  description: string;
  /** Implemented in code (vs. planned catalog entry). */
  implemented: boolean;
  /** Env vars the operator must set. */
  configKeys: string[];
  /** Provider-side approval that may be pending (shown to users and admins). */
  accessRequirements?: string[];
  scopes: { scope: string; reason: string; optional?: boolean }[];
  metrics: string[];
  actions: string[];
  supportsWebhooks: boolean;
  reportingDelay: string;
  staleAfterHours: number;
  syncIntervalMinutes: number;
  /** Re-import this many recent days on each reconciliation, to catch late changes. */
  reconcileDays: number;
  docsUrl?: string;
  /** Fields the user enters before authorizing (e.g. the store domain). */
  connectFields?: { key: string; label: string; placeholder?: string; help?: string; pattern?: string }[];

  /**
   * Alternative to OAuth: the user pastes an access token they created in the provider
   * (e.g. a Shopify custom-app token, a HubSpot private-app token). Needs no platform app
   * credentials. Such tokens don't expire and aren't refreshed; webhooks aren't registered.
   */
  tokenConnect?: {
    fields: { key: string; label: string; placeholder?: string; help?: string; secret?: boolean; optional?: boolean }[];
    instructions: string[];
    connect(input: Record<string, string>): Promise<CallbackResult>;
  };
  authorizeUrl?(p: { state: string; redirectUri: string; input: Record<string, string> }): string;
  handleCallback?(p: { query: Record<string, string>; redirectUri: string; input: Record<string, string> }): Promise<CallbackResult>;
  refreshCredentials?(creds: Credentials): Promise<{ credentials: Credentials; expiresAt: Date | null }>;
  needsRefresh?(creds: Credentials, expiresAt: Date | null): boolean;
  discoverAssets?(creds: Credentials, connection: ConnectionRow): Promise<AssetInfo[]>;
  sync?(ctx: SyncContext): Promise<SyncResult>;
  verifyWebhook?(req: Request & { rawBody?: Buffer }): VerifiedWebhook | null;
  handleWebhook?(ctx: SyncContext, hook: VerifiedWebhook): Promise<{ datesRecomputed: number }>;
  registerWebhooks?(ctx: SyncContext, callbackUrl: string): Promise<string[]>;
  healthCheck?(ctx: SyncContext): Promise<void>;
  /** Supported provider actions (only these are ever offered). */
  actionDefs?: ActionDefinition[];
  revoke?(creds: Credentials, connection: ConnectionRow): Promise<void>;
}
