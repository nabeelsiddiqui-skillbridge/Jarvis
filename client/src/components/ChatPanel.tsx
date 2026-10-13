import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Send, Volume2, VolumeX } from "lucide-react";
import { Orb, type OrbState } from "./Orb";
import { voiceInputSupported, voiceOutputSupported } from "../lib/voice";
import type { ChatMessage } from "../lib/types";

const SUGGESTIONS = [
  "What did I miss?",
  "Any new emails or meetings today?",
  "Build me a dev dashboard for GitHub",
  "Chart bitcoin over the last week",
  "Turn every chart into a bar chart",
];

interface Props {
  messages: ChatMessage[];
  orb: OrbState;
  busy: boolean;
  listening: boolean;
  interim: string;
  voiceError: string | null;
  speakReplies: boolean;
  aiMode?: string;
  onSend: (text: string) => void;
  onMic: () => void;
  onToggleSpeak: () => void;
}

export function ChatPanel({ messages, orb, busy, listening, interim, voiceError, speakReplies, aiMode, onSend, onMic, onToggleSpeak }: Props) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy, interim]);

  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <aside className="console">
      <div className="console__orb">
        <Orb state={orb} onClick={onMic} />
        <div className="console__hint">
          {listening ? interim || "Listening…" : voiceInputSupported ? "Tap the core or the mic to speak" : "Type below to talk to JARVIS"}
        </div>
        {aiMode === "offline" && <div className="chip chip--demo">Offline brain · add ANTHROPIC_API_KEY</div>}
      </div>

      <div className="console__log">
        {messages.length === 0 && (
          <div className="msg msg--assistant">
            <div className="msg__body">
              Good day. I'm JARVIS. Connect your accounts and ask me for updates — or have me build you a live dashboard.
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role} ${m.error ? "msg--error" : ""}`}>
            {m.steps?.length ? (
              <div className="msg__steps">
                {m.steps.map((s, i) => <div key={i}>› {s}</div>)}
              </div>
            ) : null}
            <div className="msg__body">{m.content}</div>
          </div>
        ))}
        {busy && (
          <div className="msg msg--assistant">
            <div className="msg__body typing"><span /><span /><span /></div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip chip--btn" disabled={busy} onClick={() => onSend(s)}>{s}</button>
        ))}
      </div>

      {voiceError && <div className="error small">{voiceError}</div>}

      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <button type="button" className={`icon-btn icon-btn--lg ${listening ? "icon-btn--live" : ""}`} onClick={onMic} title={listening ? "Stop listening" : "Speak"} disabled={!voiceInputSupported}>
          {listening ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <input
          value={listening ? interim : text}
          onChange={(e) => setText(e.target.value)}
          placeholder={listening ? "Listening…" : "Ask JARVIS anything…"}
          aria-label="Message JARVIS"
        />
        {voiceOutputSupported && (
          <button type="button" className="icon-btn icon-btn--lg" onClick={onToggleSpeak} title={speakReplies ? "Mute voice replies" : "Speak replies aloud"}>
            {speakReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        )}
        <button type="submit" className="icon-btn icon-btn--lg icon-btn--primary" disabled={busy || !text.trim()} title="Send">
          <Send size={18} />
        </button>
      </form>
    </aside>
  );
}
