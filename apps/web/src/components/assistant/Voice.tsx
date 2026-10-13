import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Repeat } from "lucide-react";
import type { Business } from "@bca/shared";
import { cn } from "@/lib/cn";
import { BrowserListener, DeepgramListener, SentenceChunker, Speaker, browserSpeechSupported, micErrorMessage, startVoiceSession, type Listener } from "@/lib/voice";

/** idle = voice on but not listening (click-to-talk); retrieving = tools running; analyzing = writing the answer. */
export type VoiceState = "off" | "starting" | "idle" | "listening" | "retrieving" | "analyzing" | "speaking" | "error";

export interface VoiceMode {
  state: VoiceState;
  transcript: string;
  error: string | null;
  note: string | null;
  muted: boolean;
  continuous: boolean;
  start(): Promise<void>;
  stop(): void;
  /** Click-to-talk: start listening for one question. */
  talk(): void;
  toggleMute(): void;
  setContinuous(on: boolean): void;
  /** The utterance was sent; we're waiting for the answer. */
  sent(): void;
  /** A tool step started or finished. */
  step(running: boolean): void;
  /** Streamed reply text (spoken sentence by sentence). */
  feed(delta: string): void;
  /** The reply finished streaming. */
  finish(): void;
}

const IDLE_TIMEOUT_MS = 3 * 60_000;
const ACK_AFTER_MS = 2500;
const readPref = () => { try { return localStorage.getItem("bca.voice.continuous") !== "false"; } catch { return true; } };

/**
 * Voice conversation loop: listen → send → speak the reply as it streams → listen
 * again (continuous) or wait for the next click (click-to-talk). Talking over the
 * reply stops it (barge-in) with the streaming recognizer. Long lookups are
 * acknowledged aloud; silence ends the session after a few minutes; a dropped
 * connection is re-established once automatically.
 */
export function useVoiceMode(business: Business, onUtterance: (text: string) => void): VoiceMode {
  const [state, setStateRaw] = useState<VoiceState>("off");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [continuous, setContinuousState] = useState(readPref);
  const listener = useRef<Listener | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const chunker = useRef(new SentenceChunker());
  const streaming = useRef(false);
  const spokeThisTurn = useRef(false);
  const ackTimer = useRef<number | undefined>(undefined);
  const idleTimer = useRef<number | undefined>(undefined);
  const reconnects = useRef(0);
  const stateRef = useRef<VoiceState>("off");
  const mutedRef = useRef(false);
  const continuousRef = useRef(continuous);
  const bargeIn = useRef(false);
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;

  const set = (s: VoiceState) => { stateRef.current = s; setStateRaw(s); armIdle(); };
  const armIdle = () => {
    window.clearTimeout(idleTimer.current);
    if (stateRef.current === "listening" || stateRef.current === "idle") {
      idleTimer.current = window.setTimeout(() => { teardown(); setError("Voice ended after 3 minutes without speech. Turn it on again whenever you like."); set("error"); }, IDLE_TIMEOUT_MS);
    }
  };
  const applyMic = () => listener.current?.setMuted(mutedRef.current || !["listening", "speaking"].includes(stateRef.current) || (stateRef.current === "speaking" && !bargeIn.current));

  const teardown = () => {
    window.clearTimeout(ackTimer.current);
    window.clearTimeout(idleTimer.current);
    listener.current?.stop();
    speaker.current?.stop();
    listener.current = null;
    speaker.current = null;
    streaming.current = false;
  };

  const stop = useCallback(() => { teardown(); setTranscript(""); setError(null); set("off"); }, []);
  useEffect(() => () => teardown(), []);

  const afterReply = () => {
    if (["off", "error"].includes(stateRef.current)) return;
    setTranscript("");
    set(continuousRef.current ? "listening" : "idle");
    applyMic();
  };

  const connect = useCallback(async (resume: VoiceState) => {
    const session = await startVoiceSession(business.id);
    setNote(session.note);
    const events = {
      onInterim: (t: string) => {
        armIdle();
        setTranscript(t);
        if (bargeIn.current && stateRef.current === "speaking" && t.split(/\s+/).filter(Boolean).length >= 2) {
          speaker.current?.stop();
          set("listening");
        }
      },
      onUtterance: (t: string) => {
        if (!["listening", "speaking"].includes(stateRef.current) || mutedRef.current) return;
        speaker.current?.stop();
        setTranscript(t);
        utteranceRef.current(t);
      },
      onError: async (m: string) => {
        // One automatic reconnect with a fresh short-lived token.
        if (reconnects.current < 1 && !["off", "error"].includes(stateRef.current)) {
          reconnects.current++;
          const prev = stateRef.current;
          listener.current?.stop();
          try { await connect(prev === "speaking" ? "listening" : prev); return; } catch { /* fall through */ }
        }
        teardown();
        setError(m);
        set("error");
      },
    };
    if (session.stt.provider === "deepgram") {
      listener.current = new DeepgramListener(session.stt, events);
      bargeIn.current = true;
    } else {
      if (!browserSpeechSupported()) throw new Error("Voice isn't available in this browser without a streaming voice service. Use Chrome, Edge or Safari, or type your question.");
      listener.current = new BrowserListener(session.language, events);
      bargeIn.current = false;
    }
    if (!speaker.current) {
      const sp = new Speaker(session.tts.provider === "server" ? "server" : "browser", business.id, session.language);
      sp.onStateChange = (speaking) => {
        if (speaking) { spokeThisTurn.current = true; if (stateRef.current !== "off") set("speaking"); applyMic(); }
        else if (!streaming.current) afterReply();
        else if (stateRef.current === "speaking") set("analyzing"); // the "one moment" note ended; the answer is still coming
      };
      speaker.current = sp;
    }
    await listener.current.start();
    set(resume);
    applyMic();
  }, [business.id]);

  const start = useCallback(async () => {
    setError(null);
    reconnects.current = 0;
    set("starting");
    try {
      await connect("listening");
    } catch (e) {
      teardown();
      setError(micErrorMessage(e));
      set("error");
    }
  }, [connect]);

  return {
    state, transcript, error, note, muted, continuous, start, stop,
    talk() { if (stateRef.current === "idle") { setTranscript(""); set("listening"); applyMic(); } },
    toggleMute() { mutedRef.current = !mutedRef.current; setMutedState(mutedRef.current); applyMic(); },
    setContinuous(on) { continuousRef.current = on; setContinuousState(on); try { localStorage.setItem("bca.voice.continuous", String(on)); } catch { /* ignore */ } },
    sent() {
      streaming.current = true;
      spokeThisTurn.current = false;
      chunker.current = new SentenceChunker();
      set("analyzing");
      applyMic();
    },
    step(running) {
      if (!streaming.current) return;
      if (running) {
        if (stateRef.current !== "speaking") set("retrieving");
        window.clearTimeout(ackTimer.current);
        // Acknowledge a slow lookup without implying the answer is ready.
        ackTimer.current = window.setTimeout(() => { if (!spokeThisTurn.current && streaming.current) speaker.current?.say("One moment, I'm checking your data."); }, ACK_AFTER_MS);
      } else if (stateRef.current === "retrieving") set("analyzing");
    },
    feed(delta) {
      window.clearTimeout(ackTimer.current);
      if (!speaker.current) return;
      if (stateRef.current === "retrieving") set("analyzing");
      for (const s of chunker.current.push(delta)) speaker.current.say(s);
    },
    finish() {
      window.clearTimeout(ackTimer.current);
      streaming.current = false;
      if (!speaker.current) return;
      for (const s of chunker.current.flush()) speaker.current.say(s);
      if (!speaker.current.speaking) afterReply();
      else applyMic();
    },
  };
}

const LABEL: Record<VoiceState, string> = {
  off: "", starting: "Starting voice…", idle: "Voice ready — press Talk to ask", listening: "Listening — ask about your business",
  retrieving: "Retrieving your data…", analyzing: "Analyzing…", speaking: "Speaking — talk to interrupt", error: "Voice stopped",
};

/** Restrained animated orb; motion is disabled for reduced-motion users. */
function Orb({ state }: { state: VoiceState }) {
  const active = state === "listening" || state === "speaking";
  const busy = state === "retrieving" || state === "analyzing" || state === "starting";
  return (
    <span aria-hidden className={cn("relative grid size-9 shrink-0 place-items-center rounded-full", state === "error" ? "bg-danger/15" : "bg-accent/15")}>
      {state === "error" ? <MicOff className="size-4 text-danger" /> : (
        <span className="flex h-4 items-end gap-[3px]">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cn("w-[3px] rounded-full bg-accent motion-reduce:animate-none", active ? "animate-[voicebar_0.9s_ease-in-out_infinite]" : busy ? "animate-[voicebar_1.6s_ease-in-out_infinite] opacity-70" : "opacity-50")}
              style={{ height: active ? `${[60, 100, 75, 45][i]}%` : "35%", animationDelay: `${i * 0.12}s` }} />
          ))}
        </span>
      )}
    </span>
  );
}

export function VoiceBar({ voice, compact }: { voice: VoiceMode; compact?: boolean }) {
  if (voice.state === "off") return null;
  const label = voice.muted && ["listening", "idle"].includes(voice.state) ? "Microphone muted" : LABEL[voice.state];
  return (
    <div className={cn("border-t border-accent/30 bg-accent/[0.06]", compact ? "px-3 py-2" : "px-3 py-2.5 md:px-6")} role="status" aria-live="polite">
      <div className={cn("mx-auto flex items-center gap-3", !compact && "max-w-3xl")}>
        <Orb state={voice.state} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg">{voice.state === "error" ? voice.error : label}</p>
          {voice.transcript && voice.state !== "error" && <p className="truncate text-xs text-muted">“{voice.transcript}”</p>}
          {!voice.transcript && voice.note && voice.state === "listening" && <p className="truncate text-[11px] text-subtle" title={voice.note}>{voice.note}</p>}
        </div>
        {voice.state === "error" ? (
          <button type="button" onClick={() => voice.start()} className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-fg hover:bg-white/5">Try again</button>
        ) : (
          <>
            {voice.state === "idle" && <button type="button" onClick={voice.talk} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-[#04121a]">Talk</button>}
            <button type="button" onClick={() => voice.setContinuous(!voice.continuous)} aria-pressed={voice.continuous} title={voice.continuous ? "Continuous conversation: on" : "Continuous conversation: off (click Talk for each question)"}
              className={cn("grid size-9 shrink-0 place-items-center rounded-full hover:bg-white/5", voice.continuous ? "text-accent" : "text-subtle")}>
              <Repeat className="size-4" /><span className="sr-only">Continuous conversation</span>
            </button>
            <button type="button" onClick={voice.toggleMute} aria-pressed={voice.muted} aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"} className={cn("grid size-9 shrink-0 place-items-center rounded-full hover:bg-white/5", voice.muted ? "text-warning" : "text-muted")}>
              {voice.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          </>
        )}
        <button type="button" onClick={voice.stop} aria-label="End voice" className="grid size-9 shrink-0 place-items-center rounded-full bg-danger/15 text-danger hover:bg-danger/25"><PhoneOff className="size-4" /></button>
      </div>
    </div>
  );
}
