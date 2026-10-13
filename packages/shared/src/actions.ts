/** External actions: changes made in a connected provider account, only after approval. */

export type ActionRisk = "low" | "medium" | "high";
export type ActionStatus = "pending_approval" | "approved" | "executing" | "needs_check" | "succeeded" | "failed" | "rejected" | "expired" | "superseded" | "cancelled";

export interface ActionParamField {
  key: string;
  label: string;
  kind: "select" | "money";
  options?: { value: string; label: string }[];
  help?: string;
}

/** An action a connected account supports, and whether it can be used right now. */
export interface ActionTypeInfo {
  type: string;
  label: string;
  description: string;
  targetKind: string;
  connectionId: string;
  connectionName: string;
  provider: string;
  providerName: string;
  available: boolean;
  unavailableReason: string | null;
}

export interface ActionTarget {
  id: string;
  name: string;
  kind: string;
  /** Account (asset) this target belongs to. */
  assetId: string | null;
  assetName: string | null;
  state: Record<string, unknown>;
  summary: string;
  fields: ActionParamField[];
}

export interface ActionAttempt { attempt: number; kind: "status_check" | "execute"; outcome: string; detail: unknown; createdAt: string }

export interface ActionProposal {
  id: string;
  businessName: string;
  provider: string;
  providerName: string;
  connectionId: string;
  connectionName: string;
  assetName: string | null;
  actionType: string;
  actionLabel: string;
  target: { kind: string; id: string; name: string };
  currentState: Record<string, unknown>;
  proposedState: Record<string, unknown>;
  /** Human-readable "field: current → proposed" lines. */
  changes: { label: string; current: string; proposed: string }[];
  expectedEffect: string;
  risk: ActionRisk;
  approvalRequirement: string;
  status: ActionStatus;
  payloadHash: string;
  source: "user" | "assistant";
  proposedBy: string | null;
  proposedById: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decision: "approved" | "rejected" | null;
  comment: string | null;
  error: string | null;
  providerResponse: unknown;
  attempts: ActionAttempt[];
  expiresAt: string;
  executedAt: string | null;
  createdAt: string;
}

export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  pending_approval: "Waiting for approval", approved: "Approved — queued", executing: "Executing", needs_check: "Checking status",
  succeeded: "Done", failed: "Failed", rejected: "Rejected", expired: "Expired", superseded: "Replaced by a newer version", cancelled: "Cancelled",
};
