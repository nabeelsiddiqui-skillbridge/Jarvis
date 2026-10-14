import { DATE_PRESETS, type DateRangeSpec } from "@bca/shared";
import type { Catalog, CatalogMetric } from "@/lib/metrics";
import { Input, Select } from "@/components/ui/Field";

const CATEGORY_LABELS: Record<string, string> = {
  sales: "Sales", profit: "Profit", acquisition: "Website & acquisition", advertising: "Advertising", seo: "Organic search", crm: "CRM & pipeline", payments: "Payments & subscriptions", email: "Email marketing", social: "Social media", support: "Customer support", accounting: "Accounting", inventory: "Inventory", calculated: "Calculated metrics",
};

export function allMetrics(c: Catalog | undefined): CatalogMetric[] {
  return [...(c?.metrics ?? []), ...(c?.calculated ?? [])];
}

/** Metric select grouped by category; metrics without data are disabled and say what's needed. */
export function MetricSelect({ catalog, value, onChange, id, allowEmpty, ...aria }: {
  catalog: Catalog | undefined;
  value: string;
  onChange: (key: string) => void;
  id?: string;
  allowEmpty?: boolean;
  "aria-describedby"?: string;
  "aria-label"?: string;
}) {
  const groups = new Map<string, CatalogMetric[]>();
  for (const m of allMetrics(catalog)) {
    const list = groups.get(m.category) ?? [];
    list.push(m);
    groups.set(m.category, list);
  }
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} {...aria}>
      {allowEmpty && <option value="">— Choose a metric —</option>}
      {[...groups.entries()].map(([cat, ms]) => (
        <optgroup key={cat} label={CATEGORY_LABELS[cat] ?? cat}>
          {ms.map((m) => (
            <option key={m.key} value={m.key} disabled={!m.available && m.key !== value}>
              {m.label}{!m.available ? ` — needs ${[...new Set(m.missing.flatMap((x) => x.needs ?? []))].join(" or ") || "data"}` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** Preset or custom date range; `inherit` lets a widget follow the dashboard's range. */
export function DateRangeSelect({ value, onChange, inherit, id }: {
  value: DateRangeSpec | null;
  onChange: (v: DateRangeSpec | null) => void;
  inherit?: boolean;
  id?: string;
}) {
  const mode = value == null ? "inherit" : "preset" in value ? value.preset : "custom";
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-wrap gap-2">
      <Select id={id} className="w-auto min-w-44" value={mode} aria-label="Date range"
        onChange={(e) => {
          const v = e.target.value;
          if (v === "inherit") onChange(null);
          else if (v === "custom") onChange({ from: new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10), to: today });
          else onChange({ preset: v as keyof typeof DATE_PRESETS });
        }}>
        {inherit && <option value="inherit">Dashboard range</option>}
        {Object.entries(DATE_PRESETS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        <option value="custom">Custom…</option>
      </Select>
      {value && "from" in value && (
        <>
          <Input type="date" aria-label="Start date" className="w-auto" value={value.from} max={value.to} onChange={(e) => onChange({ from: e.target.value, to: value.to })} />
          <Input type="date" aria-label="End date" className="w-auto" value={value.to} min={value.from} onChange={(e) => onChange({ from: value.from, to: e.target.value })} />
        </>
      )}
    </div>
  );
}
