import { z } from "zod";
import { METRIC_MAP, INTERNAL_METRICS } from "./metrics.js";
import type { ConnectionsEvidence, MetricEvidence } from "./assistant.js";

/** Insights: numeric findings from deterministic rules; AI only explains. */
export type InsightSeverity = "critical" | "warning" | "info" | "positive";
export type InsightStatus = "open" | "acknowledged" | "dismissed" | "resolved";
export type InsightRule = "period_change" | "anomaly" | "threshold" | "data_health" | "goal_pacing";

export interface InsightDriver { dimension: string; label: string; delta: number; current: number | null; previous: number | null }

export interface Insight {
  id: string;
  rule: InsightRule;
  severity: InsightSeverity;
  title: string;
  finding: string;
  impact: string | null;
  nextStep: string | null;
  metricKey: string | null;
  period: { from: string; to: string } | null;
  comparison: { from: string; to: string } | null;
  evidence: (MetricEvidence | ConnectionsEvidence)[];
  drivers: InsightDriver[];
  dashboardId: string | null;
  explanation: string | null;
  explanationStatus: "none" | "pending" | "ready" | "failed" | "unavailable";
  status: InsightStatus;
  statusBy: string | null;
  statusAt: string | null;
  isDemo: boolean;
  detectedAt: string;
  updatedAt: string;
}

export const SEVERITY_LABEL: Record<InsightSeverity, string> = { critical: "Critical", warning: "Needs attention", info: "Info", positive: "Positive" };

// ------------------------------------------------------------------ automations

export const AUTOMATION_KINDS = {
  daily_briefing: { label: "Daily briefing", description: "Every morning: yesterday and month-to-date figures, open alerts and data health, with an AI summary." },
  weekly_report: { label: "Weekly report", description: "Every week: the last 7 days against the previous 7, top movers, goals and insights." },
  threshold_alert: { label: "Threshold alert", description: "Alert when a metric crosses a value or changes by more than a percentage." },
  connection_alert: { label: "Connection failure alert", description: "Alert when a data connection fails or needs to be reconnected." },
  insight_tasks: { label: "Tasks from insights", description: "Create an internal task whenever a new insight at or above a severity is detected." },
} as const;
export type AutomationKind = keyof typeof AUTOMATION_KINDS;

const metricKey = z.string().max(80).refine((k) => METRIC_MAP.has(k) && !INTERNAL_METRICS.has(k), "Unknown metric");

export const scheduleTrigger = z.object({
  type: z.literal("schedule"),
  frequency: z.enum(["hourly", "daily", "weekly"]),
  hour: z.number().int().min(0).max(23).default(8),
  minute: z.number().int().min(0).max(59).default(0),
  /** 0 = Sunday … 6 = Saturday (weekly only). */
  weekday: z.number().int().min(0).max(6).default(1),
});
export const eventTrigger = z.object({ type: z.literal("event"), event: z.enum(["connection_failed", "insights_detected"]) });
export const automationTrigger = z.discriminatedUnion("type", [scheduleTrigger, eventTrigger]);

export const thresholdConditions = z.object({
  metric: metricKey,
  window: z.enum(["yesterday", "last_7_days", "last_30_days", "month_to_date"]).default("yesterday"),
  test: z.enum(["above", "below", "change_up_pct", "change_down_pct"]),
  value: z.number().finite(),
});

export const automationActions = z.object({
  notify: z.object({
    /** Empty = the business's owners and administrators. */
    userIds: z.array(z.string().uuid()).max(50).default([]),
    email: z.boolean().default(false),
  }).default({ userIds: [], email: false }),
  task: z.object({ assigneeId: z.string().uuid().nullable().default(null) }).nullable().default(null),
});

export const automationInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(Object.keys(AUTOMATION_KINDS) as [AutomationKind, ...AutomationKind[]]),
  enabled: z.boolean().default(true),
  trigger: automationTrigger,
  conditions: z.record(z.string(), z.unknown()).default({}),
  scope: z.object({ sources: z.array(z.string().max(40)).max(10).default([]), connectionIds: z.array(z.string().uuid()).max(20).default([]) }).default({ sources: [], connectionIds: [] }),
  actions: automationActions.default({ notify: { userIds: [], email: false }, task: null }),
  timezone: z.string().min(1).max(60).optional(),
  approvalPolicy: z.enum(["auto", "approval_required"]).default("auto"),
}).superRefine((a, ctx) => {
  const need = (ok: boolean, path: string, message: string) => { if (!ok) ctx.addIssue({ code: "custom", path: [path], message }); };
  const t = a.trigger;
  if (a.kind === "daily_briefing") need(t.type === "schedule" && t.frequency === "daily", "trigger", "Daily briefings run on a daily schedule");
  if (a.kind === "weekly_report") need(t.type === "schedule" && t.frequency === "weekly", "trigger", "Weekly reports run on a weekly schedule");
  if (a.kind === "threshold_alert") {
    need(t.type === "schedule", "trigger", "Threshold alerts are checked on a schedule");
    const c = thresholdConditions.safeParse(a.conditions);
    if (!c.success) ctx.addIssue({ code: "custom", path: ["conditions"], message: c.error.issues.map((i) => `${i.path.join(".") || "condition"}: ${i.message}`).join("; ") });
  }
  if (a.kind === "connection_alert") need(t.type === "event" && t.event === "connection_failed", "trigger", "Connection alerts run when a connection fails");
  if (a.kind === "insight_tasks") {
    need(t.type === "event" && t.event === "insights_detected", "trigger", "Insight tasks run when new insights are detected");
    need(Boolean(a.actions.task), "actions", "Choose who the tasks are assigned to");
    need(["warning", "critical"].includes(String(a.conditions.minSeverity ?? "warning")), "conditions", "Minimum severity must be warning or critical");
  }
});
export type AutomationInput = z.input<typeof automationInput>;
export type AutomationSpec = z.infer<typeof automationInput>;

export interface Automation extends Omit<AutomationSpec, "timezone"> {
  id: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRun: AutomationRun | null;
  createdAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "awaiting_approval" | "rejected";
  triggerInfo: Record<string, unknown>;
  attempts: number;
  output: { summary?: string; reportId?: string; insightIds?: string[]; taskIds?: string[]; notified?: number; emailed?: number; emailSkipped?: string };
  error: string | null;
  pendingActions: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// ------------------------------------------------------------------ reports, tasks, notifications

export interface ReportSummary {
  id: string;
  kind: "daily_briefing" | "weekly_report" | "custom";
  title: string;
  period: { from: string; to: string };
  narrativeStatus: "none" | "ready" | "failed" | "unavailable";
  isDemo: boolean;
  createdAt: string;
  createdBy: string | null;
}

export interface ReportContent {
  headline: MetricEvidence[];
  comparisonLabel: string;
  movers: { metric: string; label: string; change: number; evidenceId: string }[];
  insights: Pick<Insight, "id" | "severity" | "title" | "finding">[];
  goals: { title: string; metric: string | null; value: number | null; target: number | null; pacePct: number | null; unit: string | null; currency: string | null }[];
  dataHealth: { provider: string; name: string; status: string; stale: boolean; lastSuccessAt: string | null }[];
  deterministicSummary: string[];
  limitations: string[];
}

export interface Report extends ReportSummary {
  comparison: { from: string; to: string } | null;
  content: ReportContent;
  narrative: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "open" | "done";
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  source: "manual" | "insight" | "automation";
  insightId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const taskInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(""),
  assigneeId: z.string().uuid().nullable().default(null),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  insightId: z.string().uuid().nullable().default(null),
});

export interface AppNotification {
  id: string;
  businessId: string;
  businessName: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}
