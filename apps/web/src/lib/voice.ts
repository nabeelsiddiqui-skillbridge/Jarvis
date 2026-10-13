import { SentenceChunker, toSpeech } from "@bca/shared";
import { ApiError, post } from "./api";

export { SentenceChunker, toSpeech };

/**
 * Voice I/O in the browser.
 * - Listening: Deepgram streaming speech-to-text over a WebSocket opened with a
 *   short-lived token from our server, or the browser's SpeechRecognition.
 * - Speaking: audio from our server's speech proxy (no credentials in the
 *   browser), or the browser's speechSynthesis.
 */

export interface VoiceSession {
  stt: { provider: "deepgram"; url: string; token: string; expiresIn: number; authScheme: string } | { provider: "browser" };
  tts: { provider: "server" | "browser" };
  language: string;
  note: string;
}

export const startVoiceSession = (businessId: string) => post<VoiceSession>(`/businesses/${businessId}/voice/session`);

export interface ListenerEvents {
  onInterim(text: string): void;
  /** A complete spoken utterance (the user stopped talking). */
  onUtterance(text: string): void;
  onError(message: string): void;
}

export interface Listener {
  start(): Promise<void>;
  stop(): void;
  /** Temporarily ignore audio (used while the browser voice speaks, to avoid hearing itself). */
  setMuted(muted: boolean): void;
}

const SpeechRecognitionImpl: any = typeof window !== "undefined" ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;
export const browserSpeechSupported = () => Boolean(SpeechRecognitionImpl);

export function micErrorMessage(e: unknown) {
  const name = (e as Error)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.";
  if (name === "NotFoundError") return "No microphone was found on this device.";
  if (e instanceof ApiError) return e.message;
  return (e as Error)?.message || "Couldn't start the microphone.";
}

/** Deepgram live transcription. The token only needs to be valid while the socket opens. */
export class DeepgramListener implements Listener {
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private keepAlive: number | undefined;
  private finals: string[] = [];
  private muted = false;
  private stopped = false;

  constructor(private session: Extract<VoiceSession["stt"], { provider: "deepgram" }>, private ev: ListenerEvents) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ws = new WebSocket(this.session.url, [this.session.authScheme, this.session.token]);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Couldn't connect to the voice service."));
    });
    ws.onerror = () => this.ev.onError("The voice connection was interrupted.");
    ws.onclose = (e) => { if (!this.stopped && e.code !== 1000) this.ev.onError("The voice connection closed. Turn voice on again to continue."); };
    ws.onmessage = (m) => this.handle(m.data);
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size && ws.readyState === WebSocket.OPEN) ws.send(e.data); };
    this.recorder.start(250);
    // Keep the socket open through silences (Deepgram closes idle streams).
    this.keepAlive = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "KeepAlive" })), 8000);
  }

  private handle(raw: unknown) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "Results") {
      const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
      if (this.muted) return;
      if (msg.is_final) {
        if (text) this.finals.push(text);
        this.ev.onInterim(this.finals.join(" "));
        if (msg.speech_final) this.flush();
      } else if (text) this.ev.onInterim([...this.finals, text].join(" "));
    } else if (msg.type === "UtteranceEnd") this.flush();
  }

  private flush() {
    const text = this.finals.join(" ").trim();
    this.finals = [];
    if (text) this.ev.onUtterance(text);
  }

  setMuted(m: boolean) { this.muted = m; if (m) this.finals = []; }

  stop() {
    this.stopped = true;
    window.clearInterval(this.keepAlive);
    try { if (this.recorder?.state !== "inactive") this.recorder?.stop(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify({ type: "CloseStream" })); this.ws.close(1000); }
    this.ws = null;
  }
}

/** The browser's own speech recognition (Chrome, Edge, Safari). */
export class BrowserListener implements Listener {
  private rec: any = null;
  private stopped = false;
  private muted = false;

  constructor(private language: string, private ev: ListenerEvents) {}

  async start() {
    if (!SpeechRecognitionImpl) throw new Error("This browser doesn't support speech recognition. Use Chrome, Edge or Safari, or type your question.");
    this.stopped = false;
    const rec = new SpeechRecognitionImpl();
    rec.lang = this.language;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      if (this.muted) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) { const t = r[0].transcript.trim(); if (t) this.ev.onUtterance(t); }
        else interim += r[0].transcript;
      }
      this.ev.onInterim(interim.trim());
    };
    rec.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      this.ev.onError(e.error === "not-allowed" ? "Microphone access was blocked. Allow the microphone for this site, then try again." : "Speech recognition stopped unexpectedly.");
    };
    // Browsers end recognition after silence; restart while voice mode is on.
    rec.onend = () => { if (!this.stopped) { try { rec.start(); } catch { /* already started */ } } };
    this.rec = rec;
    rec.start();
  }

  setMuted(m: boolean) { this.muted = m; }

  stop() {
    this.stopped = true;
    try { this.rec?.stop(); } catch { /* ignore */ }
    this.rec = null;
  }
}

// ------------------------------------------------------------------ speaking

export class Speaker {
  private queue: string[] = [];
  private playing = false;
  private audio: HTMLAudioElement | null = null;
  private ctrl: AbortController | null = null;
  private generation = 0;
  onStateChange: (speaking: boolean) => void = () => undefined;

  constructor(private mode: "server" | "browser", private businessId: string, private language: string) {}

  say(text: string) {
    const t = toSpeech(text);
    if (!t) return;
    this.queue.push(t);
    if (!this.playing) void this.next();
  }

  get speaking() { return this.playing; }

  /** Stop immediately (user barged in or turned voice off). */
  stop() {
    this.generation++;
    this.queue = [];
    this.ctrl?.abort();
    this.audio?.pause();
    this.audio = null;
    if (this.mode === "browser" && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (this.playing) { this.playing = false; this.onStateChange(false); }
  }

  private async next() {
    const gen = this.generation;
    const text = this.queue.shift();
    if (text === undefined) { if (this.playing) { this.playing = false; this.onStateChange(false); } return; }
    if (!this.playing) { this.playing = true; this.onStateChange(true); }
    try {
      if (this.mode === "browser") await this.speakBrowser(text);
      else await this.speakServer(text);
    } catch {
      /* skip this sentence; text remains on screen */
    }
    if (gen === this.generation) void this.next();
  }

  private speakBrowser(text: string) {
    return new Promise<void>((resolve) => {
      if (typeof speechSynthesis === "undefined") return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.language;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  private async speakServer(text: string) {
    this.ctrl = new AbortController();
    const res = await fetch(`/api/businesses/${this.businessId}/voice/speak`, {
      method: "POST", credentials: "same-origin", signal: this.ctrl.signal,
      headers: { "Content-Type": "application/json", "X-BCA-Client": "web" }, body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("speak failed");
    const url = URL.createObjectURL(await res.blob());
    try {
      await new Promise<void>((resolve) => {
        const a = new Audio(url);
        this.audio = a;
        a.onended = () => resolve();
        a.onerror = () => resolve();
        a.onpause = () => resolve();
        a.play().catch(() => resolve());
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
