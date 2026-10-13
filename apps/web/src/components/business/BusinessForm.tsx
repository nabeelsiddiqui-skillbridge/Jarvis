import { useMemo, useState, type FormEvent } from "react";
import { CURRENCIES, INDUSTRIES, type Business, type BusinessInput } from "@bca/shared";
import { ApiError, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";

const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const allTimezones = (): string[] => {
  try {
    return (Intl as any).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Karachi", "Asia/Dubai", "Asia/Singapore", "Australia/Sydney"];
  }
};

export function BusinessForm({ initial, submitLabel, onSubmit, onCancel, compact }: {
  initial?: Partial<Business>;
  submitLabel: string;
  onSubmit: (v: BusinessInput) => Promise<void>;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const [v, setV] = useState({
    name: initial?.name ?? "",
    industry: initial?.industry ?? "ecommerce",
    website: initial?.website ?? "",
    logoUrl: initial?.logoUrl ?? "",
    timezone: initial?.timezone ?? browserTz(),
    currency: initial?.currency ?? "USD",
    description: initial?.description ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => {
    const z = allTimezones();
    // Intl's list omits "UTC" and may omit the saved value; always offer both.
    return [...new Set(["UTC", v.timezone, ...z])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      await onSubmit(v as BusinessInput);
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation" && Array.isArray(err.details)) {
        setErrors(Object.fromEntries((err.details as { path: string[]; message: string }[]).map((d) => [d.path[0], d.message])));
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Business name" error={errors.name}>{(p) => <Input {...p} data-autofocus required maxLength={120} value={v.name} onChange={set("name")} placeholder="Northwind Coffee" />}</Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Industry" error={errors.industry}>
          {(p) => (
            <Select {...p} value={v.industry} onChange={set("industry")}>
              {INDUSTRIES.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Website" optional error={errors.website}>{(p) => <Input {...p} inputMode="url" value={v.website} onChange={set("website")} placeholder="northwind.com" />}</Field>
        <Field label="Reporting timezone" hint="Days and periods are calculated in this timezone." error={errors.timezone}>
          {(p) => (
            <Select {...p} value={v.timezone} onChange={set("timezone")}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Reporting currency" hint="Figures in other currencies are labelled, never silently converted." error={errors.currency}>
          {(p) => (
            <Select {...p} value={v.currency} onChange={set("currency")}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          )}
        </Field>
      </div>
      {!compact && (
        <>
          <Field label="Logo URL" optional error={errors.logoUrl}>{(p) => <Input {...p} inputMode="url" value={v.logoUrl} onChange={set("logoUrl")} placeholder="https://…/logo.png" />}</Field>
          <Field label="Description" optional hint="Helps the assistant understand context, e.g. products, markets, sales model." error={errors.description}>
            {(p) => <Textarea {...p} maxLength={2000} value={v.description} onChange={set("description")} />}
          </Field>
        </>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}
