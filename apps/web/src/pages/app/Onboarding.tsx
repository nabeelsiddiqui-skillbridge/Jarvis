import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Plus, Trash2 } from "lucide-react";
import { post, patch, errorMessage } from "@/lib/api";
import { rememberBusiness } from "@/lib/business";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/cn";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { BusinessForm } from "@/components/business/BusinessForm";
import { DemoButton } from "@/components/business/DemoButton";

const STEPS = ["Workspace", "Business", "Goals", "Connect", "Dashboard", "Ask"] as const;

export function Onboarding() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const existingWs = me.data?.workspaces.find((w) => w.role === "owner");
  const [step, setStep] = useState(existingWs ? 1 : 0);
  const [workspaceId, setWorkspaceId] = useState<string | null>(existingWs?.id ?? null);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [goals, setGoals] = useState([{ title: "", targetValue: "", period: "month" }]);

  const createWorkspace = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await post<{ id: string }>("/workspaces", { name: wsName });
      setWorkspaceId(id);
      await qc.invalidateQueries({ queryKey: ["me"] });
      setStep(1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveGoals = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const g of goals.filter((g) => g.title.trim())) {
        await post(`/businesses/${businessId}/goals`, { title: g.title.trim(), targetValue: g.targetValue ? Number(g.targetValue) : null, period: g.period });
      }
      setStep(3);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await patch("/auth/me/preferences", { onboarding: { completed: true } }).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ["me"] });
    nav(businessId ? `/app/b/${businessId}` : "/app", { replace: true });
  };

  return (
    <div className="min-h-dvh px-5 py-8 sm:py-12">
      <div className="mx-auto max-w-2xl">
        <Logo to="/app" />
        <ol className="mt-10 flex flex-wrap gap-x-5 gap-y-2" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-2 text-sm", i === step ? "text-fg" : i < step ? "text-accent" : "text-subtle")}>
              <span className={cn("grid size-6 place-items-center rounded-full border text-xs", i < step ? "border-accent bg-accent/15" : i === step ? "border-accent" : "border-line-strong")}>
                {i < step ? <Check className="size-3.5" /> : i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>

        <div className="panel mt-8 p-6 animate-rise sm:p-8">
          {step === 0 && (
            <form onSubmit={(e) => { e.preventDefault(); createWorkspace(); }} className="space-y-5">
              <div>
                <h1 className="text-2xl font-semibold">Create your workspace</h1>
                <p className="mt-1 text-sm text-muted">A workspace holds your team, billing and one or more businesses. Agencies typically create one workspace and a business per client.</p>
              </div>
              <Field label="Workspace name" error={error}>{(p) => <Input {...p} autoFocus required maxLength={120} value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="e.g. Northwind Group or Brightline Agency" />}</Field>
              <div className="flex justify-end"><Button type="submit" variant="primary" loading={busy} disabled={!wsName.trim()}>Continue <ArrowRight className="size-4" /></Button></div>
            </form>
          )}

          {step === 1 && workspaceId && (
            <div className="space-y-5">
              <div>
                <h1 className="text-2xl font-semibold">Add your first business</h1>
                <p className="mt-1 text-sm text-muted">Connections, dashboards, conversations and goals all belong to a business. You can add more later.</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-demo/25 bg-demo/5 px-3 py-2 text-xs text-muted">
                  Want to look around first? <DemoButton workspaceId={workspaceId} variant="ghost" label="Open a labelled demo business" />
                </div>
              </div>
              <BusinessForm
                submitLabel="Create business"
                onSubmit={async (v) => {
                  const { id } = await post<{ id: string }>(`/workspaces/${workspaceId}/businesses`, v);
                  setBusinessId(id);
                  rememberBusiness(id, workspaceId);
                  await qc.invalidateQueries();
                  setStep(2);
                }}
              />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-2xl font-semibold">What are you aiming for?</h1>
                <p className="mt-1 text-sm text-muted">Goals you enter here are stored as confirmed goals — the assistant uses them for context and never changes them on its own. You can link them to metrics once data is connected.</p>
              </div>
              {goals.map((g, i) => (
                <div key={i} className="grid gap-3 sm:grid-cols-[1fr_140px_120px_auto] sm:items-end">
                  <Field label={i === 0 ? "Goal" : `Goal ${i + 1}`}>{(p) => <Input {...p} value={g.title} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="Grow online revenue" />}</Field>
                  <Field label="Target" optional>{(p) => <Input {...p} inputMode="decimal" value={g.targetValue} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, targetValue: e.target.value.replace(/[^0-9.]/g, "") } : x)))} placeholder="50000" />}</Field>
                  <Field label="Per">{(p) => <Select {...p} value={g.period} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, period: e.target.value } : x)))}><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></Select>}</Field>
                  <Button variant="ghost" aria-label="Remove goal" onClick={() => setGoals(goals.filter((_, j) => j !== i))} disabled={goals.length === 1}><Trash2 className="size-4" /></Button>
                </div>
              ))}
              {goals.length < 5 && <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => setGoals([...goals, { title: "", targetValue: "", period: "month" }])}>Add another goal</Button>}
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <div className="flex justify-between gap-2">
                <Button variant="ghost" onClick={() => setStep(3)}>Skip for now</Button>
                <Button variant="primary" loading={busy} onClick={saveGoals} disabled={!goals.some((g) => g.title.trim())}>Save goals <ArrowRight className="size-4" /></Button>
              </div>
            </div>
          )}

          {step >= 3 && (
            <div className="space-y-5">
              <h1 className="text-2xl font-semibold">You're set up</h1>
              <p className="text-sm text-muted">
                Your workspace and business are ready. Connecting data sources, building your first dashboard and asking your first question
                become available as those parts of the product are delivered; the Command Center shows your remaining setup steps.
              </p>
              <div className="flex justify-end"><Button variant="primary" onClick={finish}>Go to Command Center <ArrowRight className="size-4" /></Button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
