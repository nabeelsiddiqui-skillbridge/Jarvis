import { useQuery } from "@tanstack/react-query";
import type { AppNotification, Automation, AutomationRun, Insight, MetricEvidence, Report, ReportSummary, Task } from "@bca/shared";
import { get } from "./api";

export const k = {
  insights: (b: string, status: string) => ["b", b, "insights", status] as const,
  insight: (b: string, id: string) => ["b", b, "insights", "one", id] as const,
  tasks: (b: string, status: string) => ["b", b, "tasks", status] as const,
  automations: (b: string) => ["b", b, "automations"] as const,
  runs: (b: string, a: string) => ["b", b, "automations", "runs", a] as const,
  run: (b: string, r: string) => ["b", b, "automations", "run", r] as const,
  reports: (b: string) => ["b", b, "reports"] as const,
  report: (b: string, id: string) => ["b", b, "reports", "one", id] as const,
  briefing: (b: string) => ["b", b, "reports", "latest-briefing"] as const,
  commentary: (b: string, d: string) => ["b", b, "dashboard", d, "commentary"] as const,
  notifications: ["notifications"] as const,
};

export interface InsightList { insights: Insight[]; counts: Record<string, number>; lastDetectedAt: string | null; aiConfigured: boolean }

export const useInsights = (b: string, status = "open") =>
  useQuery({ queryKey: k.insights(b, status), queryFn: ({ signal }) => get<InsightList>(`/businesses/${b}/insights?status=${status}`, signal) });
export const useTasks = (b: string, status = "open") =>
  useQuery({ queryKey: k.tasks(b, status), queryFn: ({ signal }) => get<Task[]>(`/businesses/${b}/tasks?status=${status}`, signal) });
export const useAutomations = (b: string) =>
  useQuery({ queryKey: k.automations(b), queryFn: ({ signal }) => get<{ automations: Automation[]; emailConfigured: boolean; timezone: string }>(`/businesses/${b}/automations`, signal) });
export const useRuns = (b: string, a: string | null) =>
  useQuery({ queryKey: k.runs(b, a ?? "none"), queryFn: ({ signal }) => get<AutomationRun[]>(`/businesses/${b}/automations/${a}/runs`, signal), enabled: Boolean(a), refetchInterval: (q) => (q.state.data?.some((r) => r.status === "queued" || r.status === "running") ? 2000 : false) });
export const useRun = (b: string, r: string | null) =>
  useQuery({ queryKey: k.run(b, r ?? "none"), queryFn: ({ signal }) => get<AutomationRun>(`/businesses/${b}/automation-runs/${r}`, signal), enabled: Boolean(r) });
export const useReports = (b: string) =>
  useQuery({ queryKey: k.reports(b), queryFn: ({ signal }) => get<ReportSummary[]>(`/businesses/${b}/reports`, signal) });
export const useReport = (b: string, id: string) =>
  useQuery({ queryKey: k.report(b, id), queryFn: ({ signal }) => get<Report>(`/businesses/${b}/reports/${id}`, signal) });
export const useLatestBriefing = (b: string) =>
  useQuery({ queryKey: k.briefing(b), queryFn: ({ signal }) => get<{ report: Report | null; automation: { id: string; enabled: boolean; next_run_at: string | null } | null }>(`/businesses/${b}/reports/latest-briefing`, signal) });
export const useCommentary = (b: string, d: string) =>
  useQuery({ queryKey: k.commentary(b, d), queryFn: ({ signal }) => get<{ commentary: { id: string; text: string; evidence: MetricEvidence[]; createdAt: string } | null; aiConfigured: boolean }>(`/businesses/${b}/dashboards/${d}/commentary`, signal) });
export const useNotifications = () =>
  useQuery({ queryKey: k.notifications, queryFn: ({ signal }) => get<{ unread: number; items: AppNotification[] }>(`/notifications`, signal), refetchInterval: 60_000 });

export interface Member { userId: string; name: string; email: string; role: string | null }
/** People with access to the business (for recipients and assignees). */
export const useMembers = (b: string) =>
  useQuery({ queryKey: ["b", b, "access"], queryFn: ({ signal }) => get<Member[]>(`/businesses/${b}/access`, signal), select: (rows) => rows.filter((r) => r.role) });
