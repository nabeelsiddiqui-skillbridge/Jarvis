import { useState } from "react";
import { Orb } from "./Orb";
import { api } from "../lib/api";
import type { Status, User } from "../lib/types";

export function AuthScreen({ status, onAuthed }: { status: Status | null; onAuthed: (u: User) => void }) {
  const signupOpen = status?.signup ?? true;
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAuthed(mode === "signup" ? await api.signup({ name, email, password }) : await api.login({ email, password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signup = mode === "signup";

  return (
    <div className="auth">
      <div className="bg-grid" aria-hidden />
      <div className="bg-glow" aria-hidden />
      <div className="auth__panel hud-card">
        <span className="hud-corner tl" />
        <span className="hud-corner tr" />
        <span className="hud-corner bl" />
        <span className="hud-corner br" />
        <Orb state={busy ? "thinking" : "idle"} size={132} />
        <h1 className="auth__title">J.A.R.V.I.S.</h1>
        <p className="auth__sub">{signup ? "Create your command center" : "Identify yourself"}</p>

        <form className="form" onSubmit={submit}>
          {signup && (
            <label>
              What should I call you?
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} placeholder="Tony" />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required placeholder="you@example.com" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={signup ? "new-password" : "current-password"}
              required
              minLength={signup ? 8 : undefined}
              placeholder={signup ? "At least 8 characters" : ""}
            />
          </label>
          {error && <div className="error small" role="alert">{error}</div>}
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? "Authenticating…" : signup ? "Create account" : "Sign in"}
          </button>
        </form>

        {signupOpen ? (
          <p className="auth__switch">
            {signup ? "Already have an account?" : "New here?"}{" "}
            <button className="link-btn" onClick={() => { setMode(signup ? "login" : "signup"); setError(null); }}>
              {signup ? "Sign in" : "Create an account"}
            </button>
          </p>
        ) : (
          <p className="auth__switch muted">Sign-ups are closed on this server.</p>
        )}
        <p className="auth__fine muted small">
          Your connected-account keys are encrypted on the server and are never sent back to your browser.
        </p>
      </div>
    </div>
  );
}
