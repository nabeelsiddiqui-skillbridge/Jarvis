import { DIMENSIONS, type MetricEvidence, type QueryResult, type WidgetQuery } from "@bca/shared";

/** Evidence snapshot of a query result, shown to users next to any figure derived from it. */
export function toMetricEvidence(id: string, r: QueryResult, q: Pick<WidgetQuery, "dimension" | "granularity">, question?: string): MetricEvidence {
  return {
    id, kind: "metric",
    question: question ?? `${r.metric.label}${q.dimension ? ` by ${DIMENSIONS[q.dimension].toLowerCase()}` : ""}${q.granularity !== "none" ? ` per ${q.granularity}` : ""}`,
    metric: r.metric, range: r.range, comparisonRange: r.comparisonRange, dimension: q.dimension, granularity: q.granularity,
    availability: r.availability, unavailableReason: r.unavailableReason, total: r.total, comparisonTotal: r.comparisonTotal, change: r.change,
    comparisonPartial: r.comparisonPartial, rows: r.rows?.map((x) => ({ label: x.label, value: x.value, share: x.share })) ?? null,
    currency: r.currency, timezone: r.timezone, sources: r.sources, freshness: r.freshness, limitations: r.limitations, isDemo: r.isDemo,
  };
}
