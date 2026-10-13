import type pg from "pg";
import { pool, type Db } from "../db/pool.js";
import { backoffMs } from "../connectors/http.js";

/**
 * Durable Postgres job queue. Any number of workers claim jobs with
 * FOR UPDATE SKIP LOCKED. A partial unique index on dedupe_key prevents the same
 * logical work being queued twice while one is pending or running.
 */

export interface Job {
  id: string;
  type: string;
  workspace_id: string | null;
  business_id: string | null;
  connection_id: string | null;
  payload: Record<string, any>;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  type: string;
  workspaceId?: string | null;
  businessId?: string | null;
  connectionId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  createdBy?: string | null;
}

/** Returns the new job id, or the id of the already-pending duplicate. */
export async function enqueue(db: Db, o: EnqueueOptions): Promise<{ id: string; duplicate: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO jobs (type, workspace_id, business_id, connection_id, payload, dedupe_key, run_at, priority, max_attempts, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [o.type, o.workspaceId ?? null, o.businessId ?? null, o.connectionId ?? null, JSON.stringify(o.payload ?? {}), o.dedupeKey ?? null,
      o.runAt ?? new Date(), o.priority ?? 0, o.maxAttempts ?? 6, o.createdBy ?? null],
  );
  if (rows[0]) return { id: rows[0].id, duplicate: false };
  const existing = await db.query(`SELECT id FROM jobs WHERE dedupe_key = $1 AND status IN ('queued', 'running') LIMIT 1`, [o.dedupeKey]);
  return { id: existing.rows[0]?.id, duplicate: true };
}

export async function claim(workerId: string, types?: string[]): Promise<Job | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() AND ($2::text[] IS NULL OR type = ANY($2))
        ORDER BY priority DESC, run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, type, workspace_id, business_id, connection_id, payload, attempts, max_attempts`,
    [workerId, types ?? null],
  );
  return (rows[0] as Job) ?? null;
}

export async function complete(db: Db, jobId: string, result: unknown) {
  await db.query(`UPDATE jobs SET status = 'succeeded', finished_at = now(), result = $2, locked_by = NULL WHERE id = $1`, [jobId, JSON.stringify(result ?? {})]);
}

/** Retry with exponential backoff (or the provider's Retry-After), else fail permanently. */
export async function fail(db: Db, job: Job, error: string, opts: { retryable: boolean; retryAfterMs?: number }) {
  if (opts.retryable && job.attempts < job.max_attempts) {
    const delay = opts.retryAfterMs ?? backoffMs(job.attempts, 30_000, 60 * 60_000);
    await db.query(`UPDATE jobs SET status = 'queued', run_at = now() + $2 * interval '1 millisecond', last_error = $3, locked_by = NULL WHERE id = $1`, [job.id, delay, error]);
    return "retrying" as const;
  }
  await db.query(`UPDATE jobs SET status = 'failed', finished_at = now(), last_error = $2, locked_by = NULL WHERE id = $1`, [job.id, error]);
  return "failed" as const;
}

/** Jobs whose worker died mid-run are put back after a lease timeout. */
export async function recoverStuck(leaseMinutes = 30) {
  await pool.query(
    `UPDATE jobs SET status = 'queued', locked_by = NULL, last_error = 'Worker lease expired; retrying'
      WHERE status = 'running' AND locked_at < now() - $1 * interval '1 minute'`,
    [leaseMinutes],
  );
}

export type { pg };
