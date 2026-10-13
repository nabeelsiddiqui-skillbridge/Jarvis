import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { post, errorMessage, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { AuthLayout } from "./AuthLayout";
import { safeNext } from "./Login";

export function Signup() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", email: params.get("email") ?? "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await post("/auth/signup", form);
      qc.clear();
      const next = params.get("next");
      nav(next ? safeNext(next) : "/app/onboarding", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation" && Array.isArray(err.details)) {
        setErrors(Object.fromEntries((err.details as { path: string[]; message: string }[]).map((d) => [d.path[0], d.message])));
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <AuthLayout title="Create your account" subtitle={<>Already have one? <Link className="font-medium text-accent hover:underline" to={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`}>Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Your name" error={errors.name}>{(p) => <Input {...p} autoComplete="name" required value={form.name} onChange={set("name")} />}</Field>
        <Field label="Work email" error={errors.email}>{(p) => <Input {...p} type="email" autoComplete="email" required value={form.email} onChange={set("email")} />}</Field>
        <Field label="Password" hint="At least 10 characters." error={errors.password}>{(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set("password")} />}</Field>
        {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-[#fecaca]">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Create account</Button>
        <p className="text-center text-xs text-subtle">Your provider credentials are encrypted and never sent to your browser.</p>
      </form>
    </AuthLayout>
  );
}
