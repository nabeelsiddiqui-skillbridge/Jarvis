export type Viz = "stat" | "line" | "area" | "bar" | "list";

export type WidgetData =
  | { kind: "stat"; value: number | string; unit?: string; label?: string; delta?: number }
  | { kind: "series"; points: { label: string; value: number }[]; unit?: string }
  | { kind: "list"; items: { title: string; subtitle?: string; url?: string; time?: string }[] };

export interface Metric {
  id: string;
  label: string;
  viz: Viz[];
}

export interface Connector {
  id: string;
  name: string;
  category: string;
  description: string;
  auth: "token" | "oauth" | "none";
  fields: { key: string; label: string; placeholder?: string; secret?: boolean; help?: string }[];
  docsUrl?: string;
  metrics: Metric[];
}

export interface Account {
  provider: string;
  demo: boolean;
  label?: string;
  connectedAt: number;
}

export interface Widget {
  id: string;
  title: string;
  provider: string;
  metric: string;
  viz: Viz;
  refreshSec: number;
}

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dashboard {
  id: string;
  name: string;
  widgets: Widget[];
  layout: GridItem[];
}

export type DashboardOp =
  | { op: "add_widget"; widget: Widget }
  | { op: "update_widget"; id: string; changes: Partial<Omit<Widget, "id">> }
  | { op: "remove_widget"; id: string }
  | { op: "create_dashboard"; id: string; name: string }
  | { op: "rename_dashboard"; name: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps?: string[];
  error?: boolean;
}

export interface Status {
  ai: "claude" | "offline";
  googleOAuth: boolean;
}
