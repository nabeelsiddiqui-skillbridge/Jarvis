import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post, errorMessage } from "@/lib/api";
import { useCatalog } from "@/lib/metrics";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { MetricSelect } from "./pickers";

/** Create a calculated metric. Formulas are parsed server-side into a safe arithmetic tree — never executed as code. */
export function CalculatedMetricDialog({ open, onClose, businessId, onCreated }: { open: boolean; onClose: () => void; businessId: string; onCreated: (key: string) => void }) {
  const qc = useQueryClient();
  const catalog = useCatalog(businessId);
  const [name, setName] = useState("");
  const [expression, setExpression] = useState("");
  const [unit, setUnit] = useState("number");
  const [insert, setInsert] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!expression.trim()) return setCheck(null);
    const t = setTimeout(() => {
      post<{ ok: boolean; error?: string }>(`/businesses/${businessId}/calculated-metrics/validate`, { expression }).then(setCheck).catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [expression, businessId]);

  const addRef = (key: string) => {
    if (!key || key.startsWith("calc:")) return;
    const el = ta.current;
    const pos = el?.selectionStart ?? expression.length;
    const next = `${expression.slice(0, pos)}{${key}}${expression.slice(pos)}`;
    setExpression(next);
    setInsert("");
    requestAnimationFrame(() => el?.focus());
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ key: string }>(`/businesses/${businessId}/calculated-metrics`, { name, expression, unit });
      await qc.invalidateQueries({ queryKey: ["b", businessId, "catalog"] });
      onCreated(r.key);
      setName(""); setExpression(""); setCheck(null);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New calculated metric" description="Combine metrics with + − × ÷. Calculated from period totals, so ratios stay correct." size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !check?.ok} onClick={save}>Create metric</Button></>}>
      <div className="space-y-4">
        <Field label="Name">{(p) => <Input {...p} data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Profit per order" />}</Field>
        <Field label="Insert metric">{(p) => <MetricSelect {...p} catalog={catalog.data} value={insert} allowEmpty onChange={addRef} />}</Field>
        <Field label="Formula" error={check && !check.ok ? check.error : null} hint={check?.ok ? "Formula is valid." : "Example: ({store_net_sales} - {store_cogs}) / {store_orders}"}>
          {(p) => <Textarea {...p} ref={ta} className="font-mono text-[13px]" value={expression} onChange={(e) => setExpression(e.target.value)} spellCheck={false} />}
        </Field>
        <Field label="Display as">{(p) => (
          <Select {...p} value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="number">Number</option><option value="currency">Currency</option><option value="count">Count</option><option value="percent">Percent</option><option value="multiplier">Multiplier (×)</option>
          </Select>
        )}</Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
