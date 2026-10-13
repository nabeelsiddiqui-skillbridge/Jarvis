import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, Bot, CheckCircle2, Loader2, Mic, Square, XCircle } from "lucide-react";
import type { ActionProposal, AssistantStep, Business, DisplayMessage, Evidence, ProposalSummary } from "@bca/shared";
import { cn } from "@/lib/cn";
import { errorMessage, post } from "@/lib/api";
import { assistantKeys, streamMessage, useAssistantStatus, useConversation, type ConversationDetail } from "@/lib/assistant";
import { Prerequisite } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { ActionCard } from "@/components/actions/ActionCard";
import { useMe } from "@/lib/session";
import { CitationChip, EvidenceCard, EvidenceNote } from "./Evidence";
import { Markdown } from "./Markdown";
import { ProposalCard } from "./Proposal";
import { VoiceBar, useVoiceMode } from "./Voice";

interface Pending {
  user: DisplayMessage;
  text: string;
  steps: (AssistantStep & { done: boolean })[];
  evidence: Evidence[];
  proposals: ProposalSummary[];
  actions: ActionProposal[];
}

const SUGGESTIONS = [
  "How did sales do in the last 30 days compared with the previous period?",
  "Which channels brought the most sessions this month?",
  "What's our Google Ads ROAS over the last 30 days, by campaign?",
  "Is any of our data stale or missing?",
  "Build me a marketing performance dashboard",
];

/**
 * The conversation UI shared by the side panel and the Assistant page. Replies
 * stream in; every figure links to the evidence it came from.
 */
export function Chat({ business, conversationId, onConversation, onMissing, compact, initialDraft }: {
  business: Business;
  conversationId: string | null;
  onConversation: (id: string) => void;
  /** The selected conversation no longer exists (deleted elsewhere). */
  onMissing?: () => void;
  compact?: boolean;
  /** Pre-filled question (e.g. from a suggested question link). */
  initialDraft?: string;
}) {
  const status = useAssistantStatus(business.id);
  const conv = useConversation(business.id, conversationId);
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = Boolean(pending);

  const createdRef = useRef<string | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  // Switching to another conversation stops a reply in progress (except for the one we just created).
  useEffect(() => {
    if (conversationId !== createdRef.current) { abortRef.current?.abort(); setPending(null); setError(null); }
  }, [conversationId]);
  useEffect(() => { if ((conv.error as any)?.status === 404) onMissing?.(); }, [conv.error]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }, [conv.data?.messages.length, pending?.text.length, pending?.steps.length]);

  const sendRef = useRef<(text: string, opts?: { voice?: boolean }) => void>(() => undefined);
  const voice = useVoiceMode(business, (t) => sendRef.current(t, { voice: true }));

  async function send(text: string, opts: { voice?: boolean } = {}) {
    text = text.trim();
    if (!text || busy) return;
    if (opts.voice) voice.sent();
    setError(null);
    setDraft("");
    let id = conversationId;
    try {
      if (!id) {
        id = (await post<{ id: string }>(`/businesses/${business.id}/assistant/conversations`)).id;
        qc.setQueryData<ConversationDetail>(assistantKeys.conversation(business.id, id), { id, title: text.slice(0, 80), updatedAt: new Date().toISOString(), messages: [] });
        createdRef.current = id;
        onConversation(id);
      }
    } catch (e) {
      setError(errorMessage(e));
      setDraft(text);
      if (opts.voice) voice.finish();
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const now = new Date().toISOString();
    setPending({ user: { id: "pending", role: "user", status: "complete", text, steps: [], evidence: [], proposals: [], createdAt: now }, text: "", steps: [], evidence: [], proposals: [], actions: [] });
    const key = assistantKeys.conversation(business.id, id);
    try {
      await streamMessage(business.id, id, text, (e) => {
        if (e.type === "start") setPending((p) => p && { ...p, user: e.userMessage });
        else if (e.type === "text") { setPending((p) => p && { ...p, text: p.text + e.delta }); if (opts.voice) voice.feed(e.delta); }
        else if (e.type === "step") { setPending((p) => p && { ...p, steps: [...p.steps.filter((s) => s.id !== e.step.id), { ...e.step, done: e.done }] }); if (opts.voice) voice.step(!e.done); }
        else if (e.type === "evidence") setPending((p) => p && { ...p, evidence: [...p.evidence, e.evidence] });
        else if (e.type === "proposal") setPending((p) => p && { ...p, proposals: [...p.proposals, e.proposal] });
        else if (e.type === "action") setPending((p) => p && { ...p, actions: [...p.actions, e.action] });
        else if (e.type === "error") setError(e.message);
        else if (e.type === "done") {
          setPending((p) => {
            if (p) qc.setQueryData<ConversationDetail>(key, (old) => old && { ...old, messages: [...old.messages, p.user, e.message] });
            return null;
          });
        }
      }, ctrl.signal, { voice: opts.voice });
    } catch (e) {
      if ((e as Error).name !== "AbortError") { setError(errorMessage(e)); setDraft(text); }
    } finally {
      if (opts.voice) voice.finish();
      abortRef.current = null;
      setPending(null);
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: assistantKeys.conversations(business.id) });
    }
  }

  sendRef.current = send;

  const messages = conv.data?.messages ?? [];
  // Citations may refer to evidence from earlier answers in the same conversation.
  const lookup = new Map<string, Evidence>([...messages.flatMap((m) => m.evidence), ...(pending?.evidence ?? [])].map((e) => [e.id, e]));
  const configured = status.data?.configured;
  const empty = !messages.length && !pending;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="log" aria-live="polite" aria-busy={busy} aria-label="Conversation" className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "px-3 py-3" : "px-4 py-5 md:px-6")}>
        <div className={cn("mx-auto flex flex-col gap-5", !compact && "max-w-3xl")}>
          {conversationId && conv.isLoading && <div className="py-8"><Spinner label="Loading conversation" /></div>}
          {empty && !conv.isLoading && (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent/30 to-violet/30 text-accent"><Bot className="size-5" /></span>
                <div className="text-sm text-muted">
                  <p className="font-medium text-fg">Ask about {business.name}</p>
                  <p className="mt-0.5">Answers use only this business's connected data, with the sources, date range and limitations behind every figure.</p>
                </div>
              </div>
              {configured === false && <Prerequisite title="Assistant not configured" tone="warning">{status.data?.reason}</Prerequisite>}
              {configured && (
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.slice(0, compact ? 4 : 5).map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} className="rounded-lg border border-line bg-panel px-3 py-2 text-left text-[13px] text-muted transition-colors hover:border-accent/40 hover:text-fg">{s}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map((m) => <MessageView key={m.id} m={m} business={business} lookup={lookup} />)}
          {pending && (
            <>
              <MessageView m={pending.user} business={business} lookup={lookup} />
              <MessageView business={business} streaming m={{ id: "streaming", role: "assistant", status: "complete", text: pending.text, steps: pending.steps, evidence: pending.evidence, proposals: pending.proposals, actions: pending.actions, createdAt: "" }} liveSteps={pending.steps} lookup={lookup} />
            </>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-[#fecaca]"><XCircle className="mt-0.5 size-4 shrink-0" />{error}</p>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <VoiceBar voice={voice} compact={compact} />
      <Composer value={draft} onChange={setDraft} onSend={() => send(draft)} onStop={() => { abortRef.current?.abort(); }} busy={busy} disabled={configured === false} compact={compact} businessName={business.name}
        onVoice={voice.state === "off" ? () => voice.start() : undefined} voiceUnavailable={status.data?.voiceReason ?? null} />
    </div>
  );
}

function MessageView({ m, business, streaming, liveSteps, lookup }: { m: DisplayMessage; business: Business; streaming?: boolean; liveSteps?: (AssistantStep & { done: boolean })[]; lookup: Map<string, Evidence> }) {
  const [open, setOpen] = useState<string | null>(null);
  const me = useMe();
  if (m.role === "user") {
    return <div className="ml-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2 text-sm text-fg">{m.text}</div>;
  }
  const toggle = (id: string) => {
    setOpen((cur) => (cur === id ? null : id));
    requestAnimationFrame(() => document.getElementById(`evidence-${id}`)?.scrollIntoView({ block: "nearest" }));
  };
  const steps = liveSteps ?? m.steps.map((s) => ({ ...s, done: true }));
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent/25 to-violet/25 text-accent"><Bot className="size-4" /></span>
      <div className="min-w-0 flex-1 space-y-2.5 text-sm leading-relaxed text-[#dbe4ef]">
        {steps.length > 0 && (
          <ul className="space-y-1" aria-label="Steps">
            {steps.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5 text-xs text-subtle">
                {!s.done ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : s.error ? <AlertTriangle className="size-3.5 text-warning" aria-hidden /> : <CheckCircle2 className="size-3.5 text-success" aria-hidden />}
                <span className={cn(s.error && "text-warning/90")}>{s.label}{s.error ? ` — ${s.error}` : ""}</span>
                {s.evidenceId && <CitationChip id={s.evidenceId} active={open === s.evidenceId} onClick={() => toggle(s.evidenceId!)} />}
              </li>
            ))}
          </ul>
        )}
        {m.text ? (
          <Markdown text={m.text} renderCitation={(id, key) => <CitationChip key={key} id={id} active={open === id} missing={!streaming && !lookup.has(id)} onClick={() => toggle(id)} />} />
        ) : streaming && !steps.some((s) => !s.done) ? <span className="inline-flex items-center gap-2 text-xs text-subtle"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />Thinking…</span> : null}
        {streaming && m.text && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent/70 align-middle motion-reduce:animate-none" aria-hidden />}
        {m.status !== "complete" && (
          <p className="text-xs text-warning">{m.status === "refused" ? "The AI provider declined this request." : m.status === "truncated" ? "This answer was cut short." : "This answer didn't complete."}</p>
        )}
        {m.proposals.map((p) => <ProposalCard key={p.id} business={business} proposal={p} />)}
        {m.actions?.map((a) => <ActionCard key={a.id} business={business} action={a} me={me.data?.user.id ?? ""} compact />)}
        {open && <EvidencePanel evidence={lookup.get(open)} open={open} />}
        {!streaming && m.evidence.length > 0 && !open && (
          <div className="flex flex-wrap items-center gap-1 text-xs text-subtle">
            <span>Evidence:</span>{m.evidence.map((e) => <CitationChip key={e.id} id={e.id} onClick={() => toggle(e.id)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function EvidencePanel({ evidence: e, open }: { evidence: Evidence | undefined; open: string }) {
  if (!e) return <p className="text-xs text-warning">No evidence {open} was returned by a tool in this conversation — treat that figure with caution.</p>;
  return (
    <div className="space-y-1.5">
      <EvidenceCard evidence={e} highlighted />
      <EvidenceNote />
    </div>
  );
}

function Composer({ value, onChange, onSend, onStop, busy, disabled, compact, businessName, onVoice, voiceUnavailable }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; busy: boolean; disabled: boolean; compact?: boolean; businessName: string; onVoice?: () => void; voiceUnavailable?: string | null;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);
  return (
    <form className={cn("border-t border-line bg-panel-2/60", compact ? "p-3" : "p-3 md:px-6 md:py-4")} onSubmit={(e) => { e.preventDefault(); onSend(); }}>
      <div className={cn("mx-auto flex items-end gap-2 rounded-xl border border-line bg-panel p-1.5 focus-within:border-accent/50", !compact && "max-w-3xl")}>
        <label htmlFor="assistant-input" className="sr-only">Ask about {businessName}</label>
        <textarea id="assistant-input" ref={ref} rows={1} value={value} disabled={disabled} maxLength={4000}
          placeholder={disabled ? "Assistant not configured" : `Ask about ${businessName}…`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy) onSend(); } }}
          className="max-h-[180px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-fg outline-none placeholder:text-subtle disabled:opacity-60" />
        {onVoice && !busy && !value.trim() && (
          <button type="button" onClick={onVoice} disabled={disabled || Boolean(voiceUnavailable)} aria-label={voiceUnavailable ? `Voice unavailable: ${voiceUnavailable}` : "Talk to the assistant"} title={voiceUnavailable ?? "Voice conversation"} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-white/5 hover:text-accent disabled:opacity-40"><Mic className="size-4" /></button>
        )}
        {busy ? (
          <button type="button" onClick={onStop} aria-label="Stop generating" className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-fg hover:bg-white/10"><Square className="size-3.5 fill-current" /></button>
        ) : (
          <button type="submit" disabled={disabled || !value.trim()} aria-label="Send" className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-[#04121a] transition-opacity disabled:opacity-40"><ArrowUp className="size-4" /></button>
        )}
      </div>
      <p className={cn("mx-auto mt-1.5 px-1 text-[11px] text-subtle", !compact && "max-w-3xl")}>Answers come from {businessName}'s connected data only. Check the evidence before acting on a figure.</p>
    </form>
  );
}
