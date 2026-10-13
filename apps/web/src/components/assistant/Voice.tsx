import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import type { Business } from "@bca/shared";
import { cn } from "@/lib/cn";
import { BrowserListener, DeepgramListener, SentenceChunker, Speaker, browserSpeechSupported, micErrorMessage, startVoiceSession, type Listener } from "@/lib/voice";

export type VoiceState = "off" | "starting" | "listening" | "thinking" | "speaking" | "error";

export interface VoiceMode {
  state: VoiceState;
  transcript: string;
  error: string | null;
  note: string | null;
  start(): Promise<void>;
  stop(): void;
  /** Streamed reply text (spoken sentence by sentence). */
  feed(delta: string): void;
  /** The reply finished streaming. */
  finish(): void;
  /** The utterance was sent; we're waiting for the answer. */
  sent(): void;
}

/**
 * Voice conversation loop: listen → send the utterance → speak the reply as it
 * streams → listen again. Speaking over the reply stops it (barge-in) when the
 * streaming recognizer is used; with the browser's recognizer the mic is paused
 * while the reply is read, so it doesn't transcribe itself.
 */
export function useVoiceMode(business: Business, onUtterance: (text: string) => void): VoiceMode {
  const [state, setState] = useState<VoiceState>("off");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const listener = useRef<Listener | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const chunker = useRef(new SentenceChunker());
  const streaming = useRef(false);
  const stateRef = useRef<VoiceState>("off");
  const bargeIn = useRef(false);
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;

  const set = (s: VoiceState) => { stateRef.current = s; setState(s); };

  const stop = useCallback(() => {
    listener.current?.stop();
    speaker.current?.stop();
    listener.current = null;
    speaker.current = null;
    streaming.current = false;
    setTranscript("");
    set("off");
  }, []);

  useEffect(() => stop, [stop]);

  const backToListening = () => {
    if (stateRef.current === "off" || stateRef.current === "error") return;
    listener.current?.setMuted(false);
    setTranscript("");
    set("listening");
  };

  const start = useCallback(async () => {
    setError(null);
    set("starting");
    try {
      const session = await startVoiceSession(business.id);
      setNote(session.note);
      const events = {
        onInterim: (t: string) => {
          setTranscript(t);
          // Barge-in: the user started talking over the reply.
          if (bargeIn.current && stateRef.current === "speaking" && t.split(/\s+/).filter(Boolean).length >= 2) {
            speaker.current?.stop();
            set("listening");
          }
        },
        onUtterance: (t: string) => {
          if (stateRef.current === "thinking") return; // one question at a time
          speaker.current?.stop();
          setTranscript(t);
          utteranceRef.current(t);
        },
        onError: (m: string) => { setError(m); listener.current?.stop(); speaker.current?.stop(); set("error"); },
      };
      if (session.stt.provider === "deepgram") {
        listener.current = new DeepgramListener(session.stt, events);
        bargeIn.current = true;
      } else {
        if (!browserSpeechSupported()) throw new Error("Voice isn't available in this browser without a streaming voice service. Use Chrome, Edge or Safari, or type your question.");
        listener.current = new BrowserListener(session.language, events);
        bargeIn.current = false;
      }
      const sp = new Speaker(session.tts.provider === "server" ? "server" : "browser", business.id, session.language);
      sp.onStateChange = (speaking) => {
        if (speaking) {
          set("speaking");
          if (!bargeIn.current) listener.current?.setMuted(true);
        } else if (!streaming.current) backToListening();
      };
      speaker.current = sp;
      await listener.current.start();
      set("listening");
    } catch (e) {
      listener.current?.stop();
      listener.current = null;
      setError(micErrorMessage(e));
      set("error");
    }
  }, [business.id]);

  return {
    state, transcript, error, note, start, stop,
    sent() {
      streaming.current = true;
      chunker.current = new SentenceChunker();
      listener.current?.setMuted(true);
      set("thinking");
    },
    feed(delta) {
      if (!speaker.current) return;
      for (const s of chunker.current.push(delta)) speaker.current.say(s);
    },
    finish() {
      streaming.current = false;
      if (!speaker.current) return;
      for (const s of chunker.current.flush()) speaker.current.say(s);
      if (!speaker.current.speaking) backToListening();
      else if (bargeIn.current) listener.current?.setMuted(false);
    },
  };
}

const LABEL: Record<VoiceState, string> = {
  off: "", starting: "Starting voice…", listening: "Listening — ask about your business", thinking: "Looking that up…", speaking: "Speaking — talk to interrupt", error: "Voice stopped",
};

export function VoiceBar({ voice, compact }: { voice: VoiceMode; compact?: boolean }) {
  if (voice.state === "off") return null;
  const label = voice.state === "speaking" && voice.note?.startsWith("Using your browser") ? "Speaking…" : LABEL[voice.state];
  return (
    <div className={cn("border-t border-accent/30 bg-accent/[0.06]", compact ? "px-3 py-2" : "px-3 py-2.5 md:px-6")} role="status" aria-live="polite">
      <div className={cn("mx-auto flex items-center gap-3", !compact && "max-w-3xl")}>
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", voice.state === "error" ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent")}>
          {voice.state === "starting" || voice.state === "thinking" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            : voice.state === "speaking" ? <AudioLines className="size-4" />
            : voice.state === "error" ? <MicOff className="size-4" />
            : <Mic className="size-4 animate-pulse motion-reduce:animate-none" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg">{voice.state === "error" ? voice.error : label}</p>
          {voice.transcript && voice.state !== "error" && <p className="truncate text-xs text-muted">“{voice.transcript}”</p>}
          {!voice.transcript && voice.note && voice.state === "listening" && <p className="truncate text-[11px] text-subtle" title={voice.note}>{voice.note}</p>}
        </div>
        {voice.state === "error" ? (
          <button type="button" onClick={() => voice.start()} className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-fg hover:bg-white/5">Try again</button>
        ) : null}
        <button type="button" onClick={voice.stop} aria-label="End voice" className="grid size-9 shrink-0 place-items-center rounded-full bg-danger/15 text-danger hover:bg-danger/25"><PhoneOff className="size-4" /></button>
      </div>
    </div>
  );
}
