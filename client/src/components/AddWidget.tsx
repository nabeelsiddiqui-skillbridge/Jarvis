import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import type { Account, Connector, Viz, Widget } from "../lib/types";

export function AddWidget({ connectors, accounts, onAdd, onClose, onOpenAccounts }: {
  connectors: Connector[];
  accounts: Account[];
  onAdd: (w: Omit<Widget, "id">) => void;
  onClose: () => void;
  onOpenAccounts: () => void;
}) {
  const available = useMemo(() => connectors.filter((c) => accounts.some((a) => a.provider === c.id)), [connectors, accounts]);
  const [provider, setProvider] = useState(available[0]?.id ?? "");
  const connector = available.find((c) => c.id === provider);
  const [metricId, setMetricId] = useState(connector?.metrics[0]?.id ?? "");
  const metric = connector?.metrics.find((m) => m.id === metricId) ?? connector?.metrics[0];
  const [viz, setViz] = useState<Viz | "">("");
  const [title, setTitle] = useState("");

  if (!available.length) {
    return (
      <Modal title="Add widget" onClose={onClose}>
        <p className="muted">Connect an account first — widgets pull live data from your connected accounts.</p>
        <button className="btn btn--primary" onClick={onOpenAccounts}>Open accounts</button>
      </Modal>
    );
  }

  const chosenViz = viz && metric?.viz.includes(viz) ? viz : metric?.viz[0];

  return (
    <Modal title="Add widget" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!connector || !metric || !chosenViz) return;
          onAdd({ title: title.trim() || metric.label, provider: connector.id, metric: metric.id, viz: chosenViz, refreshSec: 60 });
          onClose();
        }}
      >
        <label>
          Source
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setMetricId(""); setViz(""); }}>
            {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          Metric
          <select value={metric?.id} onChange={(e) => { setMetricId(e.target.value); setViz(""); }}>
            {connector?.metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label>
          Visualisation
          <div className="seg">
            {metric?.viz.map((v) => (
              <button type="button" key={v} className={v === chosenViz ? "seg__on" : ""} onClick={() => setViz(v)}>{v}</button>
            ))}
          </div>
        </label>
        <label>
          Title
          <input value={title} placeholder={metric?.label} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <button className="btn btn--primary" type="submit">Deploy widget</button>
      </form>
    </Modal>
  );
}
