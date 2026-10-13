import { z } from "zod";
import { DATE_PRESETS, type DatePreset } from "./dates.js";
import { DIMENSIONS, INTERNAL_METRICS, METRIC_MAP, getMetric, type DimensionId } from "./metrics.js";

/**
 * Validated widget & dashboard specifications. Every widget's data comes from a
 * declarative query — never from AI-generated code or SQL.
 */

export const WIDGET_TYPES = {
  kpi: "KPI",
  line: "Line chart",
  area: "Area chart",
  bar: "Bar chart",
  donut: "Donut chart",
  table: "Table",
  funnel: "Funnel",
  ranking: "Ranking",
  pipeline: "Pipeline",
  goal: "Goal progress",
  geo: "Geographic breakdown",
  commentary: "AI commentary",
  freshness: "Data freshness",
} as const;
export type WidgetType = keyof typeof WIDGET_TYPES;

/** Which widget types can render which query shapes. */
export const WIDGET_SHAPES: Record<WidgetType, { needsMetric: boolean; series?: boolean; dimension?: "required" | "optional" | "none"; multiMetric?: boolean }> = {
  kpi: { needsMetric: true, dimension: "none" },
  line: { needsMetric: true, series: true, dimension: "none" },
  area: { needsMetric: true, series: true, dimension: "none" },
  bar: { needsMetric: true, dimension: "optional" },
  donut: { needsMetric: true, dimension: "required" },
  table: { needsMetric: true, dimension: "required", multiMetric: true },
  funnel: { needsMetric: true, dimension: "none", multiMetric: true },
  ranking: { needsMetric: true, dimension: "required" },
  pipeline: { needsMetric: true, dimension: "required" },
  goal: { needsMetric: false, dimension: "none" },
  geo: { needsMetric: true, dimension: "required" },
  commentary: { needsMetric: false, dimension: "none" },
  freshness: { needsMetric: false, dimension: "none" },
};

const presetKeys = Object.keys(DATE_PRESETS) as [DatePreset, ...DatePreset[]];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const dateRangeSpec = z.union([
  z.object({ preset: z.enum(presetKeys) }),
  z.object({ from: isoDate, to: isoDate }).refine((r) => r.from <= r.to, "Start date must be before end date"),
]);
export type DateRangeSpec = z.infer<typeof dateRangeSpec>;

const dimensionKeys = Object.keys(DIMENSIONS) as [DimensionId, ...DimensionId[]];

/** A metric reference: a registry key or a business calculated metric "calc:<uuid>". */
export const metricRef = z
  .string()
  .max(80)
  .refine((k) => /^calc:[0-9a-f-]{36}$/.test(k) || (METRIC_MAP.has(k) && !INTERNAL_METRICS.has(k)), "Unknown metric");

export const filterSpec = z.object({
  dimension: z.enum(dimensionKeys),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string().max(200)).min(1).max(50),
});

export const widgetQuery = z
  .object({
    metric: metricRef,
    /** Extra metrics for tables (columns) and funnels (steps), in order. */
    metrics: z.array(metricRef).max(8).default([]),
    dimension: z.enum(dimensionKeys).nullable().default(null),
    granularity: z.enum(["none", "day", "week", "month"]).default("none"),
    /** null = inherit the dashboard's date range. */
    dateRange: dateRangeSpec.nullable().default(null),
    comparison: z.enum(["none", "previous_period", "previous_year"]).default("previous_period"),
    /** Filters apply to the widget's dimension (facts are stored per single dimension). */
    filters: z.array(filterSpec).max(5).default([]),
    /** Restrict to specific providers, e.g. ["shopify"]. */
    sources: z.array(z.string().max(40)).max(10).default([]),
    limit: z.number().int().min(1).max(100).default(10),
    sort: z.enum(["value_desc", "value_asc", "label"]).default("value_desc"),
  })
  .superRefine((q, ctx) => {
    for (const k of [q.metric, ...q.metrics]) {
      const m = getMetric(k);
      if (q.dimension && m && !m.dimensions.includes(q.dimension)) {
        ctx.addIssue({ code: "custom", path: ["dimension"], message: `${m.label} can't be broken down by ${DIMENSIONS[q.dimension].toLowerCase()}` });
      }
    }
    for (const f of q.filters) {
      if (f.dimension !== q.dimension) ctx.addIssue({ code: "custom", path: ["filters"], message: "Filters must use the widget's breakdown dimension" });
    }
  });
export type WidgetQuery = z.infer<typeof widgetQuery>;
export type WidgetQueryInput = z.input<typeof widgetQuery>;

export const refreshPolicy = z.object({
  /** on_new_data: refresh when a sync lands (pushed over SSE). interval: also poll. */
  mode: z.enum(["on_new_data", "interval", "manual"]).default("on_new_data"),
  intervalSec: z.number().int().min(60).max(86_400).optional(),
});

export const widgetOptions = z
  .object({
    /** Target for KPI/line/bar: a fixed value, optionally per period ("monthly target"). */
    target: z.object({ value: z.number().finite(), period: z.enum(["range", "day", "week", "month"]).default("range"), label: z.string().max(80).optional() }).nullable().default(null),
    goalId: z.string().uuid().nullable().default(null),
    showComparison: z.boolean().default(true),
    stacked: z.boolean().default(false),
    note: z.string().max(500).optional(),
  })
  .default({ target: null, goalId: null, showComparison: true, stacked: false });

export const gridLayout = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(2).max(40),
});

export const widgetSpec = z
  .object({
    id: z.string().min(1).max(64),
    type: z.enum(Object.keys(WIDGET_TYPES) as [WidgetType, ...WidgetType[]]),
    title: z.string().trim().min(1).max(120),
    query: widgetQuery.nullable().default(null),
    options: widgetOptions,
    refresh: refreshPolicy.default({ mode: "on_new_data" }),
    layout: gridLayout,
  })
  .superRefine((w, ctx) => {
    const shape = WIDGET_SHAPES[w.type];
    if (shape.needsMetric && !w.query) ctx.addIssue({ code: "custom", path: ["query"], message: `${WIDGET_TYPES[w.type]} widgets need a metric` });
    if (!w.query) return;
    if (shape.dimension === "required" && !w.query.dimension) ctx.addIssue({ code: "custom", path: ["query", "dimension"], message: `${WIDGET_TYPES[w.type]} widgets need a breakdown dimension` });
    if (shape.dimension === "none" && w.query.dimension) ctx.addIssue({ code: "custom", path: ["query", "dimension"], message: `${WIDGET_TYPES[w.type]} widgets don't support a breakdown` });
    if (w.type === "geo" && w.query.dimension !== "country") ctx.addIssue({ code: "custom", path: ["query", "dimension"], message: "Geographic widgets break down by country" });
    if (w.type === "goal" && !w.options.goalId) ctx.addIssue({ code: "custom", path: ["options", "goalId"], message: "Choose a goal" });
  });
export type WidgetSpec = z.infer<typeof widgetSpec>;
export type WidgetSpecInput = z.input<typeof widgetSpec>;

export const dashboardSpec = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(""),
  dateRange: dateRangeSpec.default({ preset: "last_30_days" }),
  widgets: z.array(widgetSpec).max(60).refine((ws) => new Set(ws.map((w) => w.id)).size === ws.length, "Widget ids must be unique"),
});
export type DashboardSpec = z.infer<typeof dashboardSpec>;
export type DashboardSpecInput = z.input<typeof dashboardSpec>;

export interface DashboardSummary {
  id: string;
  name: string;
  description: string;
  visibility: "business" | "private";
  version: number;
  widgetCount: number;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: string;
  canEdit: boolean;
  isOwner: boolean;
}

export interface DashboardDetail extends DashboardSummary {
  spec: DashboardSpec;
}

// ------------------------------------------------------------------ query results

export interface SourceInfo {
  connectionId: string;
  provider: string;
  accountName: string;
  assetName: string | null;
  isDemo: boolean;
  status: string;
  lastSyncedAt: string | null;
  latestDataDate: string | null;
  stale: boolean;
  /** Typical reporting delay of the provider, shown alongside freshness. */
  reportingDelay: string | null;
}

export interface QueryResult {
  metric: { key: string; label: string; unit: string; description: string; formula: string | null; higherIsBetter: boolean };
  currency: string;
  timezone: string;
  range: { from: string; to: string };
  comparisonRange: { from: string; to: string } | null;
  /** available: all inputs present; partial: some days/sources missing; unavailable: no data source. */
  availability: "available" | "partial" | "unavailable";
  unavailableReason: string | null;
  total: number | null;
  comparisonTotal: number | null;
  /** Percentage change vs comparison; null when either side is unavailable, incomplete, or comparison is zero. */
  change: number | null;
  /** The comparison period is only partly covered by data, so no % change is given. */
  comparisonPartial: boolean;
  series: { bucket: string; value: number | null; comparison: number | null }[] | null;
  rows: { label: string; value: number | null; share: number | null; extra?: Record<string, number | null> }[] | null;
  /** Extra metric totals (funnels, tables). */
  steps: { key: string; label: string; unit: string; value: number | null }[] | null;
  sources: SourceInfo[];
  freshness: { latestDataDate: string | null; lastSyncedAt: string | null; stale: boolean };
  limitations: string[];
  isDemo: boolean;
}
