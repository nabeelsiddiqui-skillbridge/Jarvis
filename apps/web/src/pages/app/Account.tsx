import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { del, patch, post, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { VoicePicker } from "@/components/assistant/VoicePicker";

export function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [name, setName] = useState(me.data?.user.name ?? "");
  const [pw, setPw] = useState({ current: "", next: "" });
  const [delPw, setDelPw] = useState("");
  const [msg, setMsg] = useState<{ pw?: string; del?: string }>({});

  return (
    <>
      <PageHeader title="Account" description={me.data?.user.email} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Profile">
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault();
            try { await patch("/auth/me", { name }); await qc.invalidateQueries({ queryKey: ["me"] }); toast("Saved"); } catch (err) { toast(errorMessage(err), "error"); }
          }}>
            <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <div className="flex justify-end"><Button type="submit" variant="primary">Save</Button></div>
          </form>
        </Card>
        <Card title="JARVIS voice" description="The voice used when JARVIS answers out loud (also under Voice settings in each business). Voices come from ElevenLabs; your choice is personal to you." className="xl:col-span-2">
          <VoicePicker />
        </Card>
        <Card title="Password" description="Changing it signs you out on every other device.">
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault();
            try { await post("/auth/password", pw); setPw({ current: "", next: "" }); setMsg({}); toast("Password changed"); } catch (err) { setMsg({ pw: errorMessage(err) }); }
          }}>
            <Field label="Current password">{(p) => <Input {...p} type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}</Field>
            <Field label="New password" hint="At least 10 characters." error={msg.pw}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />}</Field>
            <div className="flex justify-end"><Button type="submit" variant="primary" disabled={!pw.current || !pw.next}>Change password</Button></div>
          </form>
        </Card>
        <Card title="Delete account" className="border-danger/25" description="Workspaces where you're the only member are deleted with your account. If you're the sole owner of a shared workspace, transfer ownership first.">
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault();
            if (!confirm("Delete your account permanently?")) return;
            try { await del("/auth/me", { password: delPw }); qc.clear(); nav("/", { replace: true }); } catch (err) { setMsg({ del: errorMessage(err) }); }
          }}>
            <Field label="Confirm with your password" error={msg.del}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />}</Field>
            <Button type="submit" variant="danger" disabled={!delPw}>Delete my account</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
