import type { QueryResult, SourceInfo } from "./widgets.js";
import type { ActionProposal } from "./actions.js";

/**
 * Assistant wire types. Evidence is built by the server from the exact query
 * results the model saw — the model cites evidence ids ([E1]) but never writes
 * the evidence itself.
 */

export interface MetricEvidence {
  id: string;
  kind: "metric";
  question: string;
  metric: QueryResult["metric"];
  range: QueryResult["range"];
  comparisonRange: QueryResult["comparisonRange"];
  dimension: string | null;
  granularity: string;
  availability: QueryResult["availability"];
  unavailableReason: string | null;
  total: number | null;
  comparisonTotal: number | null;
  change: number | null;
  comparisonPartial: boolean;
  /** share is a percentage (0–100). */
  rows: { label: string; value: number | null; share: number | null }[] | null;
  currency: string;
  timezone: string;
  sources: SourceInfo[];
  freshness: QueryResult["freshness"];
  limitations: string[];
  isDemo: boolean;
}

export interface ConnectionsEvidence {
  id: string;
  kind: "connections";
  question: string;
  connections: { provider: string; name: string; status: string; lastSuccessAt: string | null; latestDataDate: string | null; stale: boolean; lastError: string | null; isDemo: boolean }[];
}

export type Evidence = MetricEvidence | ConnectionsEvidence;

export interface AssistantStep {
  id: string;
  tool: string;
  label: string;
  evidenceId?: string;
  proposalId?: string;
  actionId?: string;
  error?: string;
}

export interface ProposalSummary {
  id: string;
  kind: "create" | "edit";
  dashboardId: string | null;
  name: string;
  summary: string;
  widgetCount: number;
  status: "pending" | "applied" | "discarded" | "undone";
  appliedVersion: number | null;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  status: "complete" | "error" | "refused" | "truncated";
  text: string;
  steps: AssistantStep[];
  evidence: Evidence[];
  proposals: ProposalSummary[];
  /** External actions the assistant proposed (always pending approval). */
  actions?: ActionProposal[];
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** Server-sent events while a reply is generated. */
export type AssistantStreamEvent =
  | { type: "start"; conversationId: string; userMessage: DisplayMessage }
  | { type: "text"; delta: string }
  | { type: "step"; step: AssistantStep; done: boolean }
  | { type: "evidence"; evidence: Evidence }
  | { type: "proposal"; proposal: ProposalSummary }
  | { type: "action"; action: ActionProposal }
  | { type: "done"; message: DisplayMessage }
  | { type: "error"; message: string };
