import { useState } from "react";
import { CheckCircle2, ExternalLink, FlaskConical, KeyRound, LogIn, Unplug } from "lucide-react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import type { Account, Connector, Status } from "../lib/types";

export function AccountsPanel({ connectors, accounts, status, onChange, onClose }: {
  connectors: Connector[];
  accounts: Account[];
  status: Status | null;
  onChange: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const categories = [...new Set(connectors.map((c) => c.category))];

  return (
    <Modal title="Connected accounts" onClose={onClose} wide>
      <p className="muted">
        You decide what JARVIS can see. Keys and tokens are sent once to your JARVIS server and are never shown in the browser again.
        Every integration is read-only. Try any of them with <b>demo data</b> first.
      </p>
      {categories.map((cat) => (
        <section key={cat} className="acct-section">
          <h3>{cat}</h3>
          <div className="acct-grid">
            {connectors.filter((c) => c.category === cat).map((c) => (
              <AccountCard
                key={c.id}
                connector={c}
                account={accounts.find((a) => a.provider === c.id)}
                expanded={open === c.id}
                onToggle={() => setOpen(open === c.id ? null : c.id)}
                googleOAuth={status?.googleOAuth ?? false}
                onChange={() => { setOpen(null); onChange(); }}
              />
            ))}
          </div>
        </section>
      ))}
    </Modal>
  );
}

function AccountCard({ connector: c, account, expanded, onToggle, googleOAuth, onChange }: {
  connector: Connector;
  account?: Account;
  expanded: boolean;
  onToggle: () => void;
  googleOAuth: boolean;
  onChange: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (demo: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.connect(c.id, { demo, creds: demo ? {} : values });
      setValues({});
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    await api.disconnect(c.id).catch(() => undefined);
    setBusy(false);
    onChange();
  };

  return (
    <div className={`acct ${account ? "acct--on" : ""}`}>
      <div className="acct__top">
        <div>
          <div className="acct__name">{c.name}</div>
          <div className="acct__desc">{c.description}</div>
        </div>
        {account ? (
          <span className={`chip ${account.demo ? "chip--demo" : "chip--on"}`}>
            {account.demo ? <FlaskConical size={12} /> : <CheckCircle2 size={12} />} {account.demo ? "Demo" : "Live"}
          </span>
        ) : (
          <span className="chip">Offline</span>
        )}
      </div>

      {account ? (
        <div className="acct__row">
          <span className="muted small">Linked {new Date(account.connectedAt).toLocaleString()}</span>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={disconnect}><Unplug size={14} /> Disconnect</button>
        </div>
      ) : !expanded ? (
        <div className="acct__row">
          <button className="btn btn--primary btn--sm" onClick={onToggle}><KeyRound size={14} /> Connect</button>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => connect(true)}><FlaskConical size={14} /> Demo data</button>
        </div>
      ) : (
        <form className="form form--tight" onSubmit={(e) => { e.preventDefault(); connect(false); }}>
          {c.auth === "oauth" ? (
            googleOAuth ? (
              <a className="btn btn--primary btn--sm" href={`/api/oauth/google/start`}><LogIn size={14} /> Sign in with Google</a>
            ) : (
              <p className="muted small">
                Google sign-in needs <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on the server (see README). Use demo data meanwhile.
              </p>
            )
          ) : (
            <>
              {c.fields.map((f) => (
                <label key={f.key}>
                  {f.label}
                  <input
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    placeholder={f.placeholder}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                  {f.help && <span className="muted small">{f.help}</span>}
                </label>
              ))}
              {c.docsUrl && (
                <a className="small link" href={c.docsUrl} target="_blank" rel="noreferrer">
                  Get a key <ExternalLink size={12} />
                </a>
              )}
              <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>
                {busy ? "Verifying…" : c.auth === "none" ? "Activate" : "Verify & connect"}
              </button>
            </>
          )}
          <div className="acct__row">
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => connect(true)}><FlaskConical size={14} /> Use demo data</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onToggle}>Cancel</button>
          </div>
        </form>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
