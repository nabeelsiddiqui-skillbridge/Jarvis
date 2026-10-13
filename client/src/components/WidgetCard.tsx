import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import type { Connector, Viz, Widget, WidgetData } from "../lib/types";

const CYAN = "#22d3ee";
const MAGENTA = "#e879f9";

interface Props {
  widget: Widget;
  connector?: Connector;
  connected: boolean;
  editing: boolean;
  onChange: (changes: Partial<Widget>) => void;
  onRemove: () => void;
}

/** Polls the server for this widget's metric on its own interval. */
function useLiveData(provider: string, metric: string, refreshSec: number, enabled: boolean) {
  const [data, setData] = useState<WidgetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const res = await api.data(provider, metric);
        if (!alive) return;
        setData(res.data);
        setAt(res.at);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, Math.max(10, refreshSec) * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [provider, metric, refreshSec, enabled, tick]);

  return { data, error, at, loading, refresh: () => setTick((n) => n + 1) };
}

export function WidgetCard({ widget, connector, connected, editing, onChange, onRemove }: Props) {
  const { data, error, at, loading, refresh } = useLiveData(widget.provider, widget.metric, widget.refreshSec, connected);
  const [settings, setSettings] = useState(false);
  const metric = connector?.metrics.find((m) => m.id === widget.metric);

  return (
    <div className={`hud-card widget ${editing ? "widget--editing" : ""}`}>
      <span className="hud-corner tl" />
      <span className="hud-corner tr" />
      <span className="hud-corner bl" />
      <span className="hud-corner br" />
      <header className="widget__head drag-handle">
        <div className="widget__title">
          <span className={`live-dot ${error ? "live-dot--err" : ""}`} />
          <span>{widget.title}</span>
        </div>
        <div className="widget__actions no-drag">
          <button className="icon-btn" title="Refresh" onClick={refresh}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
          <button className="icon-btn" title="Configure" onClick={() => setSettings((s) => !s)}>
            {settings ? <X size={14} /> : <Settings2 size={14} />}
          </button>
          <button className="icon-btn icon-btn--danger" title="Remove" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        </div>
      </header>

      <div className="widget__body no-drag">
        {settings ? (
          <div className="widget__settings">
            <label>
              Title
              <input value={widget.title} onChange={(e) => onChange({ title: e.target.value })} />
            </label>
            <label>
              Visualisation
              <select value={widget.viz} onChange={(e) => onChange({ viz: e.target.value as Viz })}>
                {(metric?.viz ?? [widget.viz]).map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Refresh every
              <select value={widget.refreshSec} onChange={(e) => onChange({ refreshSec: Number(e.target.value) })}>
                {[15, 30, 60, 300, 900].map((s) => (
                  <option key={s} value={s}>{s < 60 ? `${s}s` : `${s / 60} min`}</option>
                ))}
              </select>
            </label>
          </div>
        ) : !connected ? (
          <div className="widget__empty">{connector?.name ?? widget.provider} is disconnected. Reconnect it in Accounts.</div>
        ) : error && !data ? (
          <div className="widget__empty widget__empty--err">{error}</div>
        ) : !data ? (
          <div className="widget__empty"><span className="scanner" /> Acquiring signal…</div>
        ) : (
          <WidgetViz viz={widget.viz} data={data} />
        )}
      </div>

      <footer className="widget__foot">
        <span>{connector?.name ?? widget.provider} · {metric?.label ?? widget.metric}</span>
        <span>{at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}</span>
      </footer>
    </div>
  );
}

function WidgetViz({ viz, data }: { viz: Viz; data: WidgetData }) {
  if (viz === "stat") {
    let value: string | number, label: string | undefined, unit: string | undefined, delta: number | undefined;
    if (data.kind === "stat") ({ value, label, unit, delta } = data);
    else if (data.kind === "list") [value, label] = [data.items.length, "items"];
    else [value, unit, label] = [data.points.at(-1)?.value ?? "—", data.unit, data.points.at(-1)?.label];
    return (
      <div className="stat">
        <div className="stat__value">
          {unit === "$" ? "$" : ""}
          {typeof value === "number" ? value.toLocaleString() : value}
          {unit && unit !== "$" ? <span className="stat__unit">{unit}</span> : null}
        </div>
        {label && <div className="stat__label">{label}</div>}
        {delta !== undefined && (
          <div className={`stat__delta ${delta >= 0 ? "up" : "down"}`}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%
          </div>
        )}
      </div>
    );
  }

  if (viz === "list") {
    const items =
      data.kind === "list"
        ? data.items
        : data.kind === "series"
          ? data.points.map((p) => ({ title: p.label, subtitle: `${p.value}${data.unit ?? ""}`, url: undefined, time: undefined }))
          : [{ title: String(data.value), subtitle: data.label, url: undefined, time: undefined }];
    if (!items.length) return <div className="widget__empty">All clear. Nothing to report.</div>;
    return (
      <ul className="feed">
        {items.map((it, i) => (
          <li key={i}>
            <div className="feed__title">
              {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : it.title}
            </div>
            <div className="feed__meta">
              {it.subtitle && <span>{it.subtitle}</span>}
              {it.time && <span className="feed__time">{it.time}</span>}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (data.kind !== "series") {
    return <div className="widget__empty">This metric isn't a time series — switch the visualisation to {data.kind}.</div>;
  }

  const axis = { stroke: "#5b7a90", fontSize: 11, tickLine: false, axisLine: false } as const;
  const tooltip = (
    <Tooltip
      contentStyle={{ background: "rgba(4,10,20,.92)", border: "1px solid rgba(34,211,238,.4)", borderRadius: 8, fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}
      labelStyle={{ color: "#a5f3fc" }}
      itemStyle={{ color: "#e0faff" }}
      cursor={{ fill: "rgba(34,211,238,.08)", stroke: "rgba(34,211,238,.4)" }}
    />
  );
  const grid = <CartesianGrid stroke="rgba(34,211,238,.08)" vertical={false} />;

  return (
    <ResponsiveContainer width="100%" height="100%">
      {viz === "bar" ? (
        <BarChart data={data.points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          {grid}
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
          <YAxis {...axis} width={48} />
          {tooltip}
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {data.points.map((p, i) => (
              <Cell key={i} fill={p.value < 0 ? MAGENTA : CYAN} fillOpacity={0.85} />
            ))}
          </Bar>
        </BarChart>
      ) : viz === "line" ? (
        <LineChart data={data.points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          {grid}
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
          <YAxis {...axis} width={48} domain={["auto", "auto"]} />
          {tooltip}
          <Line type="monotone" dataKey="value" stroke={CYAN} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: CYAN }} />
        </LineChart>
      ) : (
        <AreaChart data={data.points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CYAN} stopOpacity={0.45} />
              <stop offset="100%" stopColor={CYAN} stopOpacity={0} />
            </linearGradient>
          </defs>
          {grid}
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
          <YAxis {...axis} width={48} domain={["auto", "auto"]} />
          {tooltip}
          <Area type="monotone" dataKey="value" stroke={CYAN} strokeWidth={2} fill="url(#areaFill)" />
        </AreaChart>
      )}
    </ResponsiveContainer>
  );
}
