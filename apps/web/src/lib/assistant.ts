import { useQuery } from "@tanstack/react-query";
import type { AssistantStreamEvent, ConversationSummary, DisplayMessage, DashboardSpec, ProposalSummary } from "@bca/shared";
import { ApiError, get, unauthorizedEvents } from "./api";

export const assistantKeys = {
  status: (b: string) => ["b", b, "assistant", "status"] as const,
  conversations: (b: string) => ["b", b, "assistant", "conversations"] as const,
  conversation: (b: string, c: string) => ["b", b, "assistant", "conversation", c] as const,
  proposal: (b: string, p: string) => ["b", b, "assistant", "proposal", p] as const,
};

export interface AssistantStatus { configured: boolean; reason: string | null; voice: boolean; voiceReason: string | null; dailyLimit: number }
export interface ConversationDetail { id: string; title: string; updatedAt: string; messages: DisplayMessage[] }
export interface ProposalDetail extends ProposalSummary { spec: DashboardSpec; baseVersion: number | null }

export const useAssistantStatus = (businessId: string) =>
  useQuery({ queryKey: assistantKeys.status(businessId), queryFn: ({ signal }) => get<AssistantStatus>(`/businesses/${businessId}/assistant/status`, signal), staleTime: 60_000 });

export const useConversations = (businessId: string) =>
  useQuery({ queryKey: assistantKeys.conversations(businessId), queryFn: ({ signal }) => get<ConversationSummary[]>(`/businesses/${businessId}/assistant/conversations`, signal) });

export const useConversation = (businessId: string, conversationId: string | null) =>
  useQuery({
    queryKey: assistantKeys.conversation(businessId, conversationId ?? "none"),
    queryFn: ({ signal }) => get<ConversationDetail>(`/businesses/${businessId}/assistant/conversations/${conversationId}`, signal),
    enabled: Boolean(conversationId),
  });

export const useProposal = (businessId: string, proposalId: string | null) =>
  useQuery({
    queryKey: assistantKeys.proposal(businessId, proposalId ?? "none"),
    queryFn: ({ signal }) => get<ProposalDetail>(`/businesses/${businessId}/assistant/proposals/${proposalId}`, signal),
    enabled: Boolean(proposalId),
  });

/**
 * Send a message and consume the streamed reply (server-sent events on the POST
 * response). Calls `onEvent` for each event; resolves when the stream ends.
 */
export async function streamMessage(businessId: string, conversationId: string, text: string, onEvent: (e: AssistantStreamEvent) => void, signal: AbortSignal, opts: { voice?: boolean } = {}) {
  let res: Response;
  try {
    res = await fetch(`/api/businesses/${businessId}/assistant/conversations/${conversationId}/messages`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-BCA-Client": "web", Accept: "text/event-stream" },
      body: JSON.stringify({ text, voice: opts.voice || undefined }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) unauthorizedEvents.dispatchEvent(new Event("unauthorized"));
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `Request failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (data) onEvent(JSON.parse(data) as AssistantStreamEvent);
    }
  }
}
