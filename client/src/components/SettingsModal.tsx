import { useState } from "react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import type { User } from "../lib/types";

export function SettingsModal({ user, onClose, onDeleted }: { user: User; onClose: () => void; onDeleted: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [delPw, setDelPw] = useState("");
  const [delErr, setDelErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setPwMsg({ ok: true, text: "Password updated. Other devices have been signed out." });
      setCurrent("");
      setNext("");
    } catch (err) {
      setPwMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirm("Delete your account, connected accounts and dashboards permanently?")) return;
    setBusy(true);
    try {
      await api.deleteMe(delPw);
      onDeleted();
    } catch (err) {
      setDelErr((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Account settings" onClose={onClose}>
      <p className="muted">
        Signed in as <b>{user.name}</b> ({user.email}) since {new Date(user.createdAt).toLocaleDateString()}.
      </p>

      <form className="form settings-block" onSubmit={change}>
        <h3>Change password</h3>
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          New password
          <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        {pwMsg && <div className={`small ${pwMsg.ok ? "ok" : "error"}`}>{pwMsg.text}</div>}
        <button className="btn btn--primary" disabled={busy}>Update password</button>
      </form>

      <form className="form settings-block settings-block--danger" onSubmit={remove}>
        <h3>Delete account</h3>
        <p className="muted small">This erases your connected accounts, their stored keys and your dashboards. It can't be undone.</p>
        <label>
          Confirm with your password
          <input type="password" autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} required />
        </label>
        {delErr && <div className="error small">{delErr}</div>}
        <button className="btn btn--danger" disabled={busy}>Delete my account</button>
      </form>
    </Modal>
  );
}
