import { useCallback, useEffect, useRef, useState } from "react";

// The Web Speech API isn't in TypeScript's DOM lib yet; describe the bits we use.
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
}

const Recognition: (new () => SpeechRecognitionLike) | undefined =
  (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

export const voiceInputSupported = Boolean(Recognition);
export const voiceOutputSupported = "speechSynthesis" in window;

/** Push-to-talk speech recognition. Calls onFinal with the transcript when the user stops talking. */
export function useSpeechInput(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const finalCb = useRef(onFinal);
  finalCb.current = onFinal;

  const start = useCallback(() => {
    if (!Recognition) return setError("Voice input isn't supported in this browser — try Chrome or Edge.");
    window.speechSynthesis?.cancel();
    const r = new Recognition();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    let finalText = "";
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else live += t;
      }
      setInterim(finalText + live);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") setError(`Microphone error: ${e.error}`);
    };
    r.onend = () => {
      setListening(false);
      setInterim("");
      if (finalText.trim()) finalCb.current(finalText.trim());
    };
    rec.current = r;
    setError(null);
    setListening(true);
    r.start();
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);
  useEffect(() => () => rec.current?.abort(), []);

  return { listening, interim, error, start, stop, toggle: () => (listening ? stop() : start()) };
}

/** Speak text aloud, preferring a British English voice for the full JARVIS effect. */
export function useSpeechOutput() {
  const [speaking, setSpeaking] = useState(false);

  const speak = useCallback((text: string) => {
    if (!voiceOutputSupported) return;
    const clean = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*_#`>]/g, "")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .slice(0, 1200);
    const u = new SpeechSynthesisUtterance(clean);
    const voices = speechSynthesis.getVoices();
    u.voice =
      voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur|george|ryan/i.test(v.name)) ??
      voices.find((v) => /en-GB/i.test(v.lang)) ??
      voices.find((v) => v.lang.startsWith("en")) ??
      null;
    u.rate = 1.04;
    u.pitch = 0.95;
    u.onstart = () => setSpeaking(true);
    u.onend = u.onerror = () => setSpeaking(false);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }, []);

  const cancel = useCallback(() => {
    speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return { speaking, speak, cancel };
}
