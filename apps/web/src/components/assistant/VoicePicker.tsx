import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Play, RotateCcw, Search, Square, Star } from "lucide-react";
import { errorMessage, get, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/session";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Prerequisite } from "@/components/ui/EmptyState";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Skeleton, Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

interface VoiceOption { id: string; name: string; description: string | null; category: string | null; accent: string | null; gender: string | null }
interface TtsSettings { model?: string; speed?: number; stability?: number; similarity?: number; style?: number }
interface VoiceList {
  provider: "elevenlabs" | "deepgram" | "browser";
  voices: VoiceOption[];
  selected: string | null;
  defaultVoice: string | null;
  note: string | null;
  settings: TtsSettings;
  models: { id: string; label: string; description: string }[];
  platformModel: string;
  admin: { canManage: boolean; keyFromEnvironment: boolean; defaultFromEnvironment: boolean };
}

const SAMPLE = "Good morning. Net sales are up five percent this week, and two alerts need your attention.";
/** ElevenLabs' own defaults, shown when the user hasn't tuned anything. */
const DEFAULTS = { speed: 1, stability: 0.5, similarity: 0.75, style: 0 };

/** Plays previews through the server (the API key never reaches the browser), via a business the user can access. */
function usePreview() {
  const me = useMe();
  const toast = useToast();
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const business = me.data?.preferences.recentBusinessIds[0] ?? null;
  useEffect(() => () => audio.current?.pause(), []);
  const play = async (id: string, body: Record<string, unknown>) => {
    audio.current?.pause();
    if (playing === id) { setPlaying(null); return; }
    if (!business) { toast("Open a business first to preview voices.", "info"); return; }
    setPlaying(id);
    try {
      const res = await fetch(`/api/businesses/${business}/voice/speak`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-BCA-Client": "web" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Couldn't play the preview.");
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = a.onpause = () => { setPlaying(null); URL.revokeObjectURL(url); };
      await a.play();
    } catch (e) {
      setPlaying(null);
      toast(errorMessage(e), "error");
    }
  };
  return { playing, play };
}

/** Platform admins: paste (or replace) the ElevenLabs API key right here. */
function ElevenLabsKey({ replacing, onDone }: { replacing?: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: () => put("/voice/elevenlabs-key", { apiKey: key.trim() }),
    onSuccess: async () => { setKey(""); await qc.invalidateQueries({ queryKey: ["voices"] }); toast("ElevenLabs connected — choose a voice below"); onDone(); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <form className="space-y-3 rounded-[4px] border border-line bg-panel-2/40 p-4 text-sm" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="font-medium">{replacing ? "Replace the ElevenLabs API key" : "Connect ElevenLabs"}</p>
      <ol className="list-decimal space-y-1 pl-5 text-muted">
        <li>Sign in at elevenlabs.io and open your profile (bottom left) → <b>API keys</b>.</li>
        <li>Click <b>Create API key</b>, name it “Business Command AI” and allow <b>Text to Speech</b> and <b>Voices (read)</b>.</li>
        <li>Copy the key and paste it here. It's checked with ElevenLabs, encrypted and never shown again.</li>
      </ol>
      <Field label="ElevenLabs API key">{(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} placeholder="sk_…" value={key} onChange={(e) => setKey(e.target.value)} />}</Field>
      <div className="flex justify-end"><Button type="submit" variant="primary" loading={save.isPending} disabled={key.trim().length < 20} icon={<KeyRound className="size-4" />}>Save key</Button></div>
    </form>
  );
}

/**
 * Choose the voice JARVIS speaks with (from the platform's ElevenLabs account) and tune it.
 * Choices are personal; platform administrators can also set the default voice for everyone
 * and manage the ElevenLabs API key here.
 */
export function VoicePicker() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["voices"], queryFn: ({ signal }) => get<VoiceList>("/voice/voices", signal), staleTime: 5 * 60_000 });
  const { playing, play } = usePreview();
  const [search, setSearch] = useState("");
  const [gender, setGender] = useState("");
  const [sample, setSample] = useState(SAMPLE);
  const [tuning, setTuning] = useState<TtsSettings>({});
  const [replacingKey, setReplacingKey] = useState(false);
  useEffect(() => { if (list.data) setTuning(list.data.settings ?? {}); }, [list.data?.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = useMutation({
    mutationFn: (voiceId: string | null) => put("/voice/preference", { voiceId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["voices"] }); toast("Voice saved — JARVIS uses it from the next answer"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const saveTuning = useMutation({
    mutationFn: (settings: TtsSettings) => put("/voice/preference", { settings }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["voices"] }); toast("Voice settings saved"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const makeDefault = useMutation({
    mutationFn: (voiceId: string) => put("/voice/default", { voiceId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["voices"] }); toast("Default voice set for everyone"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const d = list.data;
  const voices = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (d?.voices ?? []).filter((v) => (!gender || v.gender === gender) && (!term || `${v.name} ${v.accent ?? ""} ${v.description ?? ""} ${v.category ?? ""}`.toLowerCase().includes(term)));
  }, [d?.voices, search, gender]);
  const genders = useMemo(() => [...new Set((d?.voices ?? []).map((v) => v.gender).filter(Boolean))] as string[], [d?.voices]);

  if (list.isLoading) return <Skeleton className="h-40" />;
  if (list.error) return <Prerequisite tone="warning" title="Voices unavailable">{errorMessage(list.error)}</Prerequisite>;
  const admin = d!.admin;
  if (d!.provider !== "elevenlabs") {
    return (
      <div className="space-y-4">
        <Prerequisite title="Voice choice needs ElevenLabs">{d!.note} Until then JARVIS uses {d!.provider === "deepgram" ? "the platform's standard voice" : "your browser's built-in voice"}.</Prerequisite>
        {admin.canManage && !admin.keyFromEnvironment && <ElevenLabsKey onDone={() => undefined} />}
      </div>
    );
  }
  const current = d!.selected ?? d!.defaultVoice;
  const dirty = JSON.stringify(tuning) !== JSON.stringify(d!.settings ?? {});
  const value = (k: keyof typeof DEFAULTS) => tuning[k] ?? DEFAULTS[k];
  const slider = (k: keyof typeof DEFAULTS, label: string, min: number, max: number, step: number, hint: string) => (
    <label className="block text-sm">
      <span className="flex items-baseline justify-between"><span className="font-medium">{label}</span><span className="font-mono text-xs text-accent">{value(k).toFixed(2)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value(k)} onChange={(e) => setTuning({ ...tuning, [k]: Number(e.target.value) })} className="mt-1.5 w-full accent-[#22d3ee]" aria-label={label} />
      <span className="text-xs text-subtle">{hint}</span>
    </label>
  );

  return (
    <div className="space-y-6">
      <section aria-labelledby="voice-choose-h" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="voice-choose-h" className="hud-label text-[11px] text-subtle">Choose a voice</h3>
            <p className="text-xs text-muted">{d!.voices.length} voices on the ElevenLabs account{d!.selected ? "" : " · you're using the default"}. Press ▶ to hear one.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
              <Input aria-label="Search voices" placeholder="Search voices…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48 pl-8" />
            </div>
            {genders.length > 1 && (
              <Select aria-label="Filter by gender" value={gender} onChange={(e) => setGender(e.target.value)} className="w-32">
                <option value="">All voices</option>
                {genders.map((g) => <option key={g} value={g}>{g[0]!.toUpperCase() + g.slice(1)}</option>)}
              </Select>
            )}
          </div>
        </div>
        <ul className="grid max-h-[26rem] gap-2 overflow-y-auto pr-1 sm:grid-cols-2" role="radiogroup" aria-label="JARVIS voice">
          {voices.map((v) => {
            const active = v.id === current;
            const isDefault = v.id === d!.defaultVoice;
            return (
              <li key={v.id} className={cn("flex items-center gap-2 rounded-[4px] border px-3 py-2.5", active ? "border-accent bg-accent/10" : "border-line bg-panel-2/60")}>
                <button type="button" role="radio" aria-checked={active} onClick={() => !active && choose.mutate(v.id)} className="min-w-0 flex-1 text-left">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {v.name}{active && <Check className="size-4 text-accent" aria-hidden />}
                    {isDefault && <Badge tone="neutral">Default</Badge>}
                    {choose.isPending && choose.variables === v.id && <Spinner className="size-3.5" />}
                  </span>
                  <span className="block truncate font-mono text-[10.5px] uppercase tracking-wider text-subtle">{[v.gender, v.accent, v.description].filter(Boolean).join(" · ") || v.category || "voice"}</span>
                </button>
                {admin.canManage && !admin.defaultFromEnvironment && !isDefault && (
                  <button type="button" onClick={() => makeDefault.mutate(v.id)} title="Make this the default voice for everyone" aria-label={`Make ${v.name} the default for everyone`} className="grid size-8 shrink-0 place-items-center rounded-[4px] border border-line text-muted hover:border-accent/50 hover:text-accent">
                    {makeDefault.isPending && makeDefault.variables === v.id ? <Spinner className="size-3.5" /> : <Star className="size-3.5" />}
                  </button>
                )}
                <button type="button" onClick={() => play(v.id, { text: sample, voiceId: v.id, settings: tuning })} aria-label={playing === v.id ? `Stop ${v.name} preview` : `Preview ${v.name}`} className="grid size-8 shrink-0 place-items-center rounded-[4px] border border-line text-muted hover:border-accent/50 hover:text-accent">
                  {playing === v.id ? <Square className="size-3.5 fill-current" /> : <Play className="size-3.5" />}
                </button>
              </li>
            );
          })}
          {!voices.length && <li className="text-sm text-muted">No voices match.</li>}
        </ul>
        {d!.selected && <button type="button" className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => choose.mutate(null)}>Use the platform default voice instead</button>}
        {admin.canManage && <p className="text-xs text-subtle">As a platform administrator you can press ★ to make a voice the default for everyone who hasn't picked their own.</p>}
      </section>

      <section aria-labelledby="voice-tune-h" className="space-y-4 border-t border-line pt-5">
        <div>
          <h3 id="voice-tune-h" className="hud-label text-[11px] text-subtle">Tune the voice</h3>
          <p className="text-xs text-muted">Applies to every voice you use. Preview with ▶ above or the button below before saving.</p>
        </div>
        <Field label="Voice model" hint={d!.models.find((m) => m.id === (tuning.model ?? d!.platformModel))?.description}>{(p) => (
          <Select {...p} value={tuning.model ?? ""} onChange={(e) => setTuning({ ...tuning, model: e.target.value || undefined })}>
            <option value="">Platform default ({d!.models.find((m) => m.id === d!.platformModel)?.label ?? d!.platformModel})</option>
            {d!.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        )}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {slider("speed", "Speed", 0.7, 1.2, 0.05, "Below 1 is slower, above 1 is faster.")}
          {slider("stability", "Stability", 0, 1, 0.05, "Higher is steadier; lower is more expressive.")}
          {slider("similarity", "Clarity + similarity", 0, 1, 0.05, "How closely it sticks to the original voice.")}
          {slider("style", "Style exaggeration", 0, 1, 0.05, "Adds emphasis; can add latency. 0 is neutral.")}
        </div>
        <Field label="Preview text">{(p) => <Textarea {...p} rows={2} value={sample} maxLength={300} onChange={(e) => setSample(e.target.value)} />}</Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setTuning({})}>Reset</Button>
          <Button icon={playing === "tuning" ? <Square className="size-4" /> : <Play className="size-4" />} onClick={() => current && play("tuning", { text: sample, voiceId: current, settings: tuning })}>Preview</Button>
          <Button variant="primary" disabled={!dirty} loading={saveTuning.isPending} onClick={() => saveTuning.mutate(tuning)}>Save settings</Button>
        </div>
      </section>

      {admin.canManage && !admin.keyFromEnvironment && (
        <section className="border-t border-line pt-5">
          {replacingKey ? <ElevenLabsKey replacing onDone={() => setReplacingKey(false)} /> : (
            <p className="text-xs text-subtle">ElevenLabs is connected with the platform's API key. <button type="button" className="text-accent hover:underline" onClick={() => setReplacingKey(true)}>Replace the key</button></p>
          )}
        </section>
      )}
    </div>
  );
}
