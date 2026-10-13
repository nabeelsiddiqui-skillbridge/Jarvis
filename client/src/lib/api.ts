import type { Account, Connector, Dashboard, DashboardOp, DashboardsState, Status, User, WidgetData } from "./types";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Fired when any request comes back 401, so the app can drop back to the sign-in screen. */
export const onUnauthorized = new EventTarget();

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      "X-Jarvis": "1",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized.dispatchEvent(new Event("401"));
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

const post = <T>(path: string, body?: unknown, method = "POST") =>
  call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  status: () => call<Status>("/api/status"),

  me: () => call<User>("/api/auth/me"),
  signup: (body: { name: string; email: string; password: string }) => post<User>("/api/auth/signup", body),
  login: (body: { email: string; password: string }) => post<User>("/api/auth/login", body),
  logout: () => post("/api/auth/logout"),
  changePassword: (current: string, next: string) => post("/api/auth/password", { current, next }),
  deleteMe: (password: string) => post("/api/auth/me", { password }, "DELETE"),

  connectors: () => call<Connector[]>("/api/connectors"),
  accounts: () => call<Account[]>("/api/accounts"),
  connect: (provider: string, body: { demo?: boolean; creds?: Record<string, string> }) =>
    post<Account>(`/api/accounts/${provider}`, body),
  disconnect: (provider: string) => post(`/api/accounts/${provider}`, undefined, "DELETE"),
  data: (provider: string, metric: string) =>
    call<{ data: WidgetData; at: number }>(`/api/data/${provider}/${metric}`),

  dashboards: () => call<{ state: DashboardsState | null }>("/api/dashboards"),
  saveDashboards: (state: DashboardsState) => post("/api/dashboards", state, "PUT"),

  chat: (history: { role: string; content: string }[], dashboard: Dashboard) =>
    post<{ reply: string; ops: DashboardOp[]; steps: string[]; mode: string }>("/api/chat", {
      history,
      dashboard: { id: dashboard.id, name: dashboard.name, widgets: dashboard.widgets },
    }),
};
