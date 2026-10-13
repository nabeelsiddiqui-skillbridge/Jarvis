import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Play, Square } from "lucide-react";
import { errorMessage, get, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/session";
import { Prerequisite } from "@/components/ui/EmptyState";
import { Skeleton, Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

interface VoiceOption { id: string; name: string; description: string | null; category: string | null; accent: string | null; gender: string | null }
interface VoiceList { provider: "elevenlabs" | "deepgram" | "browser"; voices: VoiceOption[]; selected: string | null; defaultVoice: string | null; note: string | null }

const SAMPLE = "Good morning. Net sales are up five percent this week, and two alerts need your attention.";

/** Choose the voice JARVIS speaks with (ElevenLabs voices on the platform's account). Saved per user. */
export function VoicePicker() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["voices"], queryFn: ({ signal }) => get<VoiceList>("/voice/voices", signal), staleTime: 5 * 60_000 });
  const choose = useMutation({
    mutationFn: (voiceId: string) => put("/voice/preference", { voiceId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["voices"] }); toast("Voice saved — JARVIS will use it from the next answer"); },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // Previews go through the server (the API key never reaches the browser) via a business the user can access.
  const previewBusiness = me.data?.preferences.recentBusinessIds[0] ?? null;

  const preview = async (id: string) => {
    audio.current?.pause();
    if (playing === id) { setPlaying(null); return; }
    if (!previewBusiness) { toast("Open a business first to preview voices.", "info"); return; }
    setPlaying(id);
    try {
      const res = await fetch(`/api/businesses/${previewBusiness}/voice/speak`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-BCA-Client": "web" }, body: JSON.stringify({ text: SAMPLE, voiceId: id }) });
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

  if (list.isLoading) return <Skeleton className="h-40" />;
  if (list.error) return <Prerequisite tone="warning" title="Voices unavailable">{errorMessage(list.error)}</Prerequisite>;
  const d = list.data!;
  if (d.provider !== "elevenlabs") {
    return <Prerequisite title="Voice choice isn't available yet">{d.note} Until then JARVIS uses {d.provider === "deepgram" ? "the platform's standard voice" : "your browser's built-in voice"}.</Prerequisite>;
  }
  const current = d.selected ?? d.defaultVoice;
  return (
    <ul className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="JARVIS voice">
      {d.voices.map((v) => {
        const active = v.id === current;
        return (
          <li key={v.id} className={cn("flex items-center gap-3 rounded-[4px] border px-3 py-2.5", active ? "border-accent bg-accent/10" : "border-line bg-panel-2/60")}>
            <button type="button" role="radio" aria-checked={active} onClick={() => !active && choose.mutate(v.id)} className="min-w-0 flex-1 text-left">
              <span className="flex items-center gap-1.5 text-sm font-medium">{v.name}{active && <Check className="size-4 text-accent" aria-hidden />}{choose.isPending && choose.variables === v.id && <Spinner className="size-3.5" />}</span>
              <span className="block truncate font-mono text-[10.5px] uppercase tracking-wider text-subtle">{[v.gender, v.accent, v.description].filter(Boolean).join(" · ") || v.category || "voice"}</span>
            </button>
            <button type="button" onClick={() => preview(v.id)} aria-label={playing === v.id ? `Stop ${v.name} preview` : `Preview ${v.name}`} className="grid size-8 shrink-0 place-items-center rounded-[4px] border border-line text-muted hover:border-accent/50 hover:text-accent">
              {playing === v.id ? <Square className="size-3.5 fill-current" /> : <Play className="size-3.5" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
