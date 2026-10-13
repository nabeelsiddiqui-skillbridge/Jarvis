import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, LayoutGrid, Lock, Pencil, Plus, Plug, X } from "lucide-react";
import { AccountsPanel } from "./components/AccountsPanel";
import { AddWidget } from "./components/AddWidget";
import { ChatPanel } from "./components/ChatPanel";
import { Dashboard } from "./components/Dashboard";
import type { OrbState } from "./components/Orb";
import { api } from "./lib/api";
import { useDashboards } from "./lib/dashboards";
import type { Account, ChatMessage, Connector, Status } from "./lib/types";
import { useSpeechInput, useSpeechOutput } from "./lib/voice";

const uid = () => Math.random().toString(36).slice(2, 10);

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function readPref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [speakReplies, setSpeakReplies] = useState(() => readPref("jarvis.speak", true));
  const dash = useDashboards();
  const now = useClock();
  const tts = useSpeechOutput();

  const refreshAccounts = useCallback(() => api.accounts().then(setAccounts).catch(() => undefined), []);

  useEffect(() => {
    api.status().then(setStatus).catch(() => setToast("Can't reach the JARVIS server. Is it running on port 8787?"));
    api.connectors().then(setConnectors).catch(() => undefined);
    refreshAccounts();
    // Back from Google OAuth?
    const params = new URLSearchParams(location.search);
    if (params.get("connected")) {
      setToast(params.get("status") === "ok" ? "Google account linked. Inbox and calendar are online." : `Google sign-in failed: ${params.get("status")}`);
      history.replaceState(null, "", location.pathname);
    }
  }, [refreshAccounts]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    try {
      localStorage.setItem("jarvis.speak", speakReplies ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [speakReplies]);

  // Keep the latest messages/dashboard in refs so the voice callback never goes stale.
  const msgRef = useRef(messages);
  msgRef.current = messages;
  const dashRef = useRef(dash.active);
  dashRef.current = dash.active;

  const send = useCallback(
    async (text: string) => {
      const user: ChatMessage = { id: uid(), role: "user", content: text };
      const history = [...msgRef.current.filter((m) => !m.error), user].map(({ role, content }) => ({ role, content }));
      setMessages((m) => [...m, user]);
      setBusy(true);
      try {
        const res = await api.chat(history, dashRef.current);
        if (res.ops.length) dash.applyOps(res.ops);
        setMessages((m) => [...m, { id: uid(), role: "assistant", content: res.reply, steps: res.steps }]);
        if (speakReplies) tts.speak(res.reply);
      } catch (e) {
        setMessages((m) => [...m, { id: uid(), role: "assistant", content: (e as Error).message, error: true }]);
      } finally {
        setBusy(false);
      }
    },
    [dash.applyOps, speakReplies, tts.speak],
  );

  const mic = useSpeechInput(send);
  const orb: OrbState = mic.listening ? "listening" : busy ? "thinking" : tts.speaking ? "speaking" : "idle";
  const live = accounts.filter((a) => !a.demo).length;

  return (
    <div className="app">
      <div className="bg-grid" aria-hidden />
      <div className="bg-glow" aria-hidden />

      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" />
          <span className="brand__name">J.A.R.V.I.S.</span>
          <span className="brand__sub">Just A Rather Very Intelligent System</span>
        </div>
        <div className="telemetry">
          <span className={`chip ${status?.ai === "claude" ? "chip--on" : "chip--demo"}`}>
            <Cpu size={12} /> {status ? (status.ai === "claude" ? "Neural core online" : "Offline brain") : "Linking…"}
          </span>
          <span className="chip">
            <Plug size={12} /> {accounts.length} linked{live ? ` · ${live} live` : ""}
          </span>
          <span className="clock">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            <small>{now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</small>
          </span>
        </div>
      </header>

      <main className="layout">
        <ChatPanel
          messages={messages}
          orb={orb}
          busy={busy}
          listening={mic.listening}
          interim={mic.interim}
          voiceError={mic.error}
          speakReplies={speakReplies}
          aiMode={status?.ai}
          onSend={send}
          onMic={() => (tts.speaking ? tts.cancel() : mic.toggle())}
          onToggleSpeak={() => {
            if (speakReplies) tts.cancel();
            setSpeakReplies(!speakReplies);
          }}
        />

        <section className="stage">
          <nav className="toolbar">
            <div className="tabs" role="tablist">
              {dash.dashboards.map((d) =>
                renaming === d.id ? (
                  <input
                    key={d.id}
                    className="tab tab--edit"
                    autoFocus
                    defaultValue={d.name}
                    onBlur={(e) => { dash.rename(e.target.value.trim() || d.name); setRenaming(null); }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <button
                    key={d.id}
                    role="tab"
                    aria-selected={d.id === dash.active.id}
                    className={`tab ${d.id === dash.active.id ? "tab--on" : ""}`}
                    onClick={() => dash.select(d.id)}
                    onDoubleClick={() => { dash.select(d.id); setRenaming(d.id); }}
                    title="Double-click to rename"
                  >
                    <LayoutGrid size={13} /> {d.name}
                    {dash.dashboards.length > 1 && d.id === dash.active.id && (
                      <span
                        className="tab__x"
                        role="button"
                        aria-label={`Delete ${d.name}`}
                        onClick={(e) => { e.stopPropagation(); if (confirm(`Delete dashboard “${d.name}”?`)) dash.remove(d.id); }}
                      >
                        <X size={12} />
                      </span>
                    )}
                  </button>
                ),
              )}
              <button className="tab tab--new" onClick={() => dash.create(`Dashboard ${dash.dashboards.length + 1}`)} title="New dashboard">
                <Plus size={14} />
              </button>
            </div>
            <div className="toolbar__actions">
              <button className={`btn btn--ghost ${editing ? "btn--active" : ""}`} onClick={() => setEditing(!editing)}>
                {editing ? <Lock size={15} /> : <Pencil size={15} />} {editing ? "Lock layout" : "Edit layout"}
              </button>
              <button className="btn btn--ghost" onClick={() => setShowAdd(true)}><Plus size={15} /> Widget</button>
              <button className="btn btn--primary" onClick={() => setShowAccounts(true)}><Plug size={15} /> Accounts</button>
            </div>
          </nav>

          <Dashboard
            dashboard={dash.active}
            connectors={connectors}
            accounts={accounts}
            editing={editing}
            onLayout={dash.setLayout}
            onUpdateWidget={dash.updateWidget}
            onRemoveWidget={dash.removeWidget}
            onAdd={() => setShowAdd(true)}
          />
        </section>
      </main>

      {showAccounts && (
        <AccountsPanel connectors={connectors} accounts={accounts} status={status} onChange={refreshAccounts} onClose={() => setShowAccounts(false)} />
      )}
      {showAdd && (
        <AddWidget
          connectors={connectors}
          accounts={accounts}
          onAdd={dash.addWidget}
          onClose={() => setShowAdd(false)}
          onOpenAccounts={() => { setShowAdd(false); setShowAccounts(true); }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
