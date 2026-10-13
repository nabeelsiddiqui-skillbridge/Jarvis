/**
 * Chart color roles. The categorical order was validated with the dataviz
 * palette checker against the panel surface #111A2B (dark): every adjacent pair
 * clears CVD ΔE ≥ 8 and normal-vision ΔE ≥ 15, all slots ≥ 3:1 contrast.
 * Assign in this fixed order; never cycle — a 9th category folds into "Other".
 */
export const SERIES = ["#0fa3c4", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;
/** Single-series charts use the brand accent; the comparison period is a muted dashed line. */
export const PRIMARY = "#22d3ee";
export const COMPARISON = "#64748b";
export const TARGET = "#8b5cf6";
export const GRID = "rgb(148 163 184 / 0.12)";
export const AXIS = "#94a3b8";
export const SURFACE = "#111a2b";

export const MAX_CATEGORIES = SERIES.length;

/** Fold a long breakdown into the first N-1 rows + "Other" so no hue is ever generated or reused. */
export function foldOther<T extends { label: string; value: number | null }>(rows: T[], max = MAX_CATEGORIES): { label: string; value: number | null }[] {
  if (rows.length <= max) return rows;
  const head = rows.slice(0, max - 1);
  const rest = rows.slice(max - 1).reduce((s, r) => s + (r.value ?? 0), 0);
  return [...head, { label: "Other", value: rest }];
}
