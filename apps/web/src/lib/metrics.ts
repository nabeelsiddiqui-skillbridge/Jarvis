import { useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DateRangeSpec, QueryResult, SourceInfo, WidgetQueryInput } from "@bca/shared";
import { get, post } from "./api";

export interface CatalogMetric {
  key: string;
  label: string;
  description: string;
  unit: string;
  category: string;
  kind: "base" | "derived" | "calculated";
  family?: string | null;
  dimensions: string[];
  sources?: string[];
  available: boolean;
  missing: { metric: string; label?: string; needs?: string[] }[];
  expression?: string;
}

export interface Catalog {
  metrics: CatalogMetric[];
  calculated: CatalogMetric[];
  dimensions: Record<string, string>;
  sources: SourceInfo[];
  isDemo: boolean;
}

export function useCatalog(businessId: string) {
  return useQuery({
    queryKey: ["b", businessId, "catalog"],
    queryFn: ({ signal }) => get<Catalog>(`/businesses/${businessId}/metrics/catalog`, signal),
    staleTime: 60_000,
  });
}

/**
 * Widget data. The key includes the business id so cached results can never be
 * shown under another business; requests are aborted when the widget unmounts.
 */
export function useMetricQuery(businessId: string, query: WidgetQueryInput | null, dashboardRange?: DateRangeSpec, refetchIntervalSec?: number) {
  return useQuery<QueryResult>({
    queryKey: ["b", businessId, "q", query, dashboardRange],
    queryFn: ({ signal }) =>
      fetch(`/api/businesses/${businessId}/metrics/query`, {
        method: "POST",
        signal,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-BCA-Client": "web" },
        body: JSON.stringify({ query, dashboardRange }),
      }).then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error?.message ?? "Couldn't load this widget");
        return data as QueryResult;
      }),
    enabled: Boolean(query),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchInterval: refetchIntervalSec ? refetchIntervalSec * 1000 : false,
  });
}

export const runQueryOnce = (businessId: string, query: WidgetQueryInput, dashboardRange?: DateRangeSpec) =>
  post<QueryResult>(`/businesses/${businessId}/metrics/query`, { query, dashboardRange });

/**
 * Subscribe to the business's server-sent events. When new data lands (a sync
 * finishes), every widget query for *this* business is refetched.
 */
export function useBusinessEvents(businessId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(`/api/businesses/${businessId}/events`);
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["b", businessId, "q"] });
      qc.invalidateQueries({ queryKey: ["b", businessId, "catalog"] });
      qc.invalidateQueries({ queryKey: ["b", businessId, "overview"] });
      qc.invalidateQueries({ queryKey: ["b", businessId, "connections"] });
    };
    es.addEventListener("data_updated", refresh);
    es.addEventListener("connection_updated", () => qc.invalidateQueries({ queryKey: ["b", businessId, "connections"] }));
    es.addEventListener("dashboard_updated", (e) => {
      const id = JSON.parse((e as MessageEvent).data || "{}").dashboardId;
      if (id) qc.invalidateQueries({ queryKey: ["b", businessId, "dashboard", id] });
    });
    es.addEventListener("insight_created", () => qc.invalidateQueries({ queryKey: ["b", businessId, "insights"] }));
    es.addEventListener("report_created", () => qc.invalidateQueries({ queryKey: ["b", businessId, "reports"] }));
    es.addEventListener("actions_updated", () => qc.invalidateQueries({ queryKey: ["b", businessId, "actions"] }));
    es.addEventListener("tasks_updated", () => qc.invalidateQueries({ queryKey: ["b", businessId, "tasks"] }));
    es.addEventListener("notification", () => qc.invalidateQueries({ queryKey: ["notifications"] }));
    return () => es.close();
  }, [businessId, qc]);
}
