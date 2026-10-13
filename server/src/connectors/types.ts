/** Shape of the data a widget renders. Every metric returns one of these. */
export type WidgetData =
  | { kind: "stat"; value: number | string; unit?: string; label?: string; delta?: number }
  | { kind: "series"; points: { label: string; value: number }[]; unit?: string }
  | { kind: "list"; items: { title: string; subtitle?: string; url?: string; time?: string }[] };

export type Viz = "stat" | "line" | "area" | "bar" | "list";

export interface Metric {
  id: string;
  label: string;
  /** Visualisations that make sense for this metric; the first is the default. */
  viz: Viz[];
}

export interface CredentialField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  help?: string;
}

/** What the user stored when connecting. Never sent back to the browser. */
export type Credentials = Record<string, string>;

export interface Connector {
  id: string;
  name: string;
  category: string;
  description: string;
  /** token = user pastes a key; oauth = redirect flow; none = public data, only settings. */
  auth: "token" | "oauth" | "none";
  fields: CredentialField[];
  /** Link to where the user creates a token / key. */
  docsUrl?: string;
  metrics: Metric[];
  /** Check credentials when the user connects. Throw with a readable message on failure. */
  verify?(creds: Credentials): Promise<void>;
  /** A plain-text briefing of what's new — this is what JARVIS reads to answer "any updates?". */
  updates(creds: Credentials): Promise<string>;
  fetchMetric(metric: string, creds: Credentials): Promise<WidgetData>;
}

export async function getJson<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": "jarvis-dashboard", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 200);
    try {
      const j = JSON.parse(body);
      detail = j.message ?? j.error?.message ?? j.error_description ?? j.error ?? detail;
    } catch {
      /* not JSON — keep the raw snippet */
    }
    throw new Error(`${new URL(url).host} responded ${res.status}${detail ? ` (${String(detail).trim()})` : ""}`);
  }
  return (await res.json()) as T;
}

export function relTime(input: string | number | Date): string {
  const t = new Date(input).getTime();
  const diff = Math.round((Date.now() - t) / 1000);
  const abs = Math.abs(diff);
  const fmt = (n: number, u: string) => `${n}${u}${diff >= 0 ? " ago" : " from now"}`;
  if (abs < 60) return diff >= 0 ? "just now" : "in a moment";
  if (abs < 3600) return fmt(Math.round(abs / 60), "m");
  if (abs < 86400) return fmt(Math.round(abs / 3600), "h");
  return fmt(Math.round(abs / 86400), "d");
}
