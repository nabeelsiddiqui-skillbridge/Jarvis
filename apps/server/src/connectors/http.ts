/**
 * HTTP client for provider APIs: timeouts, bounded retries with exponential
 * backoff + jitter, Retry-After support and error classification. Errors carry a
 * `kind` the job system uses to decide between retrying, asking the user to
 * reconnect, or failing permanently. Provider response bodies are kept off
 * user-facing messages (they can contain account details).
 */

export type ProviderErrorKind = "auth" | "scope" | "rate_limit" | "transient" | "permanent" | "not_found";

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public status?: number,
    public retryAfterMs?: number,
    /** Truncated provider body for logs/admin only. */
    public detail?: string,
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === "rate_limit" || this.kind === "transient";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  json?: unknown;
  form?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Quick in-request retries for transient failures (job-level retries happen on top). */
  retries?: number;
  /** Only retry when the request is safe to repeat. Mutations default to no retry. */
  idempotent?: boolean;
  provider: string;
}

export async function providerFetch<T = any>(url: string, opts: RequestOptions): Promise<{ data: T; headers: Headers; status: number }> {
  const { json, form, timeoutMs = 30_000, retries = 3, provider, headers, ...init } = opts;
  const method = (init.method ?? (json || form ? "POST" : "GET")).toUpperCase();
  const idempotent = opts.idempotent ?? (method === "GET" || method === "HEAD");
  let lastErr: ProviderError | null = null;

  for (let attempt = 0; attempt <= (idempotent ? retries : 0); attempt++) {
    if (attempt > 0) await sleep(lastErr?.retryAfterMs ?? backoffMs(attempt - 1, 500, 15_000));
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": "BusinessCommandAI/1.0",
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(headers as Record<string, string>),
        },
        body: json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : init.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      lastErr = new ProviderError("transient", `${provider} ${timedOut ? "timed out" : "could not be reached"}`);
      continue;
    }
    const text = await res.text();
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (res.ok) return { data, headers: res.headers, status: res.status };

    const detail = text.slice(0, 500);
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (res.status === 401) throw new ProviderError("auth", `${provider} rejected the credentials. Reconnect the account.`, 401, undefined, detail);
    if (res.status === 403) throw new ProviderError("scope", `${provider} denied access to this resource. The connection may be missing a permission.`, 403, undefined, detail);
    if (res.status === 404) throw new ProviderError("not_found", `${provider} resource not found.`, 404, undefined, detail);
    if (res.status === 429) {
      lastErr = new ProviderError("rate_limit", `${provider} rate limit reached`, 429, retryAfterMs ?? backoffMs(attempt, 2000), detail);
      continue;
    }
    if (res.status >= 500 || res.status === 408) {
      lastErr = new ProviderError("transient", `${provider} is having problems (HTTP ${res.status})`, res.status, retryAfterMs, detail);
      continue;
    }
    throw new ProviderError("permanent", `${provider} request failed (HTTP ${res.status})`, res.status, undefined, detail);
  }
  throw lastErr ?? new ProviderError("transient", `${provider} request failed`);
}

/**
 * Test hook: route a provider URL to a local stand-in when `<KEY>` is set
 * (e.g. GOOGLE_BASE_URL_OVERRIDE=http://127.0.0.1:9000 →
 * https://oauth2.googleapis.com/token becomes http://127.0.0.1:9000/oauth2.googleapis.com/token).
 * Always ignored in production.
 */
export function providerUrl(url: string, overrideEnv: string): string {
  const override = process.env[overrideEnv];
  if (!override || process.env.NODE_ENV === "production") return url;
  const u = new URL(url);
  return `${override.replace(/\/$/, "")}/${u.host}${u.pathname}${u.search}`;
}
