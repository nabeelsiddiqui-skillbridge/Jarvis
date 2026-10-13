import type { Account, Connector, Dashboard, DashboardOp, Status, WidgetData } from "./types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  status: () => call<Status>("/api/status"),
  connectors: () => call<Connector[]>("/api/connectors"),
  accounts: () => call<Account[]>("/api/accounts"),
  connect: (provider: string, body: { demo?: boolean; creds?: Record<string, string> }) =>
    call<Account>(`/api/accounts/${provider}`, { method: "POST", body: JSON.stringify(body) }),
  disconnect: (provider: string) => call(`/api/accounts/${provider}`, { method: "DELETE" }),
  data: (provider: string, metric: string) =>
    call<{ data: WidgetData; at: number }>(`/api/data/${provider}/${metric}`),
  chat: (history: { role: string; content: string }[], dashboard: Dashboard) =>
    call<{ reply: string; ops: DashboardOp[]; steps: string[]; mode: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        history,
        dashboard: { id: dashboard.id, name: dashboard.name, widgets: dashboard.widgets },
      }),
    }),
};
