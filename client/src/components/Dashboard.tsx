import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { LayoutGrid } from "lucide-react";
import { WidgetCard } from "./WidgetCard";
import type { Account, Connector, Dashboard as DashboardT, GridItem, Widget } from "../lib/types";

const Grid = WidthProvider(Responsive);

interface Props {
  dashboard: DashboardT;
  connectors: Connector[];
  accounts: Account[];
  editing: boolean;
  onLayout: (layout: GridItem[]) => void;
  onUpdateWidget: (id: string, changes: Partial<Widget>) => void;
  onRemoveWidget: (id: string) => void;
  onAdd: () => void;
}

export function Dashboard({ dashboard, connectors, accounts, editing, onLayout, onUpdateWidget, onRemoveWidget, onAdd }: Props) {
  if (!dashboard.widgets.length) {
    return (
      <div className="dash-empty">
        <LayoutGrid size={40} />
        <h2>No widgets on “{dashboard.name}” yet</h2>
        <p>
          Ask JARVIS — <em>“Build me a dashboard with my unread email, open PRs and Stripe revenue”</em> — or add one yourself.
        </p>
        <button className="btn btn--primary" onClick={onAdd}>+ Add widget</button>
      </div>
    );
  }

  const connected = new Set(accounts.map((a) => a.provider));
  // Stack everything into one column on narrow screens.
  const small = dashboard.layout.map((l, idx) => ({ ...l, x: 0, w: 1, y: idx * l.h }));

  return (
    <Grid
      className="grid"
      layouts={{ lg: dashboard.layout, sm: small }}
      breakpoints={{ lg: 760, sm: 0 }}
      cols={{ lg: 12, sm: 1 }}
      rowHeight={56}
      margin={[14, 14]}
      draggableHandle=".drag-handle"
      draggableCancel=".no-drag"
      isDraggable={editing}
      isResizable={editing}
      // Only persist the desktop layout; the mobile stack is derived from it.
      onLayoutChange={(_current: Layout[], all: Record<string, Layout[]>) => all.lg && onLayout(all.lg)}
    >
      {dashboard.widgets.map((w) => (
        <div key={w.id}>
          <WidgetCard
            widget={w}
            connector={connectors.find((c) => c.id === w.provider)}
            connected={connected.has(w.provider)}
            editing={editing}
            onChange={(changes) => onUpdateWidget(w.id, changes)}
            onRemove={() => onRemoveWidget(w.id)}
          />
        </div>
      ))}
    </Grid>
  );
}
