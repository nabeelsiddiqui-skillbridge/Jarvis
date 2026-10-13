import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/session";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/EmptyState";
import { PageLoader } from "@/components/ui/Spinner";
import { AuthLayout } from "./AuthLayout";

export function AcceptInvite() {
  const { token } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => get<{ email: string; role: string; workspaceName: string; invitedBy: string | null }>(`/invites/${token}`), retry: false });
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (invite.isPending) return <PageLoader />;
  if (invite.error) return <AuthLayout title="Invitation unavailable"><ErrorState error={invite.error} /><Link className="mt-6 block text-sm text-accent" to="/app">Go to the app</Link></AuthLayout>;
  const inv = invite.data;
  const next = `/invite/${token}`;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/invites/${token}/accept`);
      await qc.invalidateQueries();
      nav("/app", { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={`Join ${inv.workspaceName}`} subtitle={`${inv.invitedBy ?? "A teammate"} invited ${inv.email} as ${inv.role === "owner" ? "a workspace owner" : "a member"}.`}>
      {me.data ? (
        me.data.user.email.toLowerCase() === inv.email.toLowerCase() ? (
          <div className="space-y-3">
            <Button variant="primary" className="w-full" loading={busy} onClick={accept}>Accept invitation</Button>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted">You're signed in as <b className="text-fg">{me.data.user.email}</b>. Sign out and sign in as <b className="text-fg">{inv.email}</b> to accept.</p>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <ButtonLink variant="primary" to={`/signup?email=${encodeURIComponent(inv.email)}&next=${encodeURIComponent(next)}`}>Create account to join</ButtonLink>
          <ButtonLink variant="secondary" to={`/login?next=${encodeURIComponent(next)}`}>I already have an account</ButtonLink>
        </div>
      )}
    </AuthLayout>
  );
}
