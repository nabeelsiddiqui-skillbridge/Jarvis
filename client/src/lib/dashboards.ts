import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Dashboard, DashboardOp, DashboardsState, GridItem, Viz, Widget } from "./types";

const uid = () => Math.random().toString(36).slice(2, 10);

export const newDashboard = (name: string, id = uid()): Dashboard => ({ id, name, widgets: [], layout: [] });

/** Default footprint on the 12-column grid for each visualisation. */
export function sizeFor(viz: Viz): Pick<GridItem, "w" | "h"> {
  if (viz === "stat") return { w: 4, h: 3 };
  if (viz === "list") return { w: 4, h: 5 };
  return { w: 5, h: 5 };
}

/** Find the first free spot scanning left→right, top→bottom. */
function place(layout: GridItem[], w: number, h: number): GridItem {
  const cols = 12;
  for (let y = 0; y < 500; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const hit = layout.some((l) => x < l.x + l.w && x + w > l.x && y < l.y + l.h && y + h > l.y);
      if (!hit) return { i: "", x, y, w, h };
    }
  }
  return { i: "", x: 0, y: Infinity, w, h };
}

function addWidget(d: Dashboard, widget: Widget): Dashboard {
  const { w, h } = sizeFor(widget.viz);
  const spot = { ...place(d.layout, w, h), i: widget.id };
  return { ...d, widgets: [...d.widgets, widget], layout: [...d.layout, spot] };
}

type State = DashboardsState;

const LEGACY_KEY = "jarvis.dashboards.v1";

export function emptyState(): State {
  const d = newDashboard("Command Center");
  return { dashboards: [d], activeId: d.id };
}

/**
 * Dashboards from before accounts existed lived only in this browser. Offer them
 * to the first account that signs in here, once.
 */
export function takeLegacyDashboards(): State | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    localStorage.removeItem(LEGACY_KEY);
    const s = JSON.parse(raw) as State;
    return s.dashboards?.length ? s : null;
  } catch {
    return null;
  }
}

export type SaveStatus = "saved" | "saving" | "error";

/** Dashboard state, saved to the user's account on the server (debounced). */
export function useDashboards(initial: State) {
  const [state, setState] = useState<State>(initial);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaveStatus("saving");
    const t = setTimeout(() => {
      api.saveDashboards(state).then(
        () => setSaveStatus("saved"),
        () => setSaveStatus("error"),
      );
    }, 700);
    return () => clearTimeout(t);
  }, [state]);

  const active = state.dashboards.find((d) => d.id === state.activeId) ?? state.dashboards[0];

  const updateActive = useCallback((fn: (d: Dashboard) => Dashboard) => {
    setState((s) => ({ ...s, dashboards: s.dashboards.map((d) => (d.id === s.activeId ? fn(d) : d)) }));
  }, []);

  /** Apply edits JARVIS made during a chat turn. */
  const applyOps = useCallback((ops: DashboardOp[]) => {
    setState((s) => {
      let { dashboards, activeId } = s;
      const mutate = (fn: (d: Dashboard) => Dashboard) => {
        dashboards = dashboards.map((d) => (d.id === activeId ? fn(d) : d));
      };
      for (const op of ops) {
        switch (op.op) {
          case "create_dashboard":
            dashboards = [...dashboards, newDashboard(op.name, op.id)];
            activeId = op.id;
            break;
          case "rename_dashboard":
            mutate((d) => ({ ...d, name: op.name }));
            break;
          case "add_widget":
            mutate((d) => addWidget(d, op.widget));
            break;
          case "update_widget":
            mutate((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === op.id ? { ...w, ...op.changes } : w)) }));
            break;
          case "remove_widget":
            mutate((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== op.id), layout: d.layout.filter((l) => l.i !== op.id) }));
            break;
        }
      }
      return { dashboards, activeId };
    });
  }, []);

  return {
    dashboards: state.dashboards,
    active,
    saveStatus,
    select: (id: string) => setState((s) => ({ ...s, activeId: id })),
    create: (name: string) => {
      const d = newDashboard(name);
      setState((s) => ({ dashboards: [...s.dashboards, d], activeId: d.id }));
    },
    remove: (id: string) =>
      setState((s) => {
        const rest = s.dashboards.filter((d) => d.id !== id);
        if (!rest.length) rest.push(newDashboard("Command Center"));
        return { dashboards: rest, activeId: s.activeId === id ? rest[0].id : s.activeId };
      }),
    rename: (name: string) => updateActive((d) => ({ ...d, name })),
    setLayout: (layout: GridItem[]) =>
      updateActive((d) => ({ ...d, layout: layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })) })),
    addWidget: (widget: Omit<Widget, "id">) => updateActive((d) => addWidget(d, { ...widget, id: uid() })),
    updateWidget: (id: string, changes: Partial<Widget>) =>
      updateActive((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === id ? { ...w, ...changes } : w)) })),
    removeWidget: (id: string) =>
      updateActive((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== id), layout: d.layout.filter((l) => l.i !== id) })),
    applyOps,
  };
}
