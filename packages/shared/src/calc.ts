/**
 * Calculated metrics: a tiny, safe arithmetic language over metric references.
 *   {store_net_sales} / {ad_spend}
 *   ({store_net_sales} - {store_cogs}) / {store_orders}
 * Only + - * / parentheses, numbers and {metric_key}. No functions, no code execution.
 * Evaluated on *aggregated* inputs (period totals or per-bucket totals).
 */
import { INTERNAL_METRICS, METRIC_MAP } from "./metrics.js";

export type CalcNode =
  | { t: "num"; v: number }
  | { t: "ref"; key: string }
  | { t: "op"; op: "+" | "-" | "*" | "/"; a: CalcNode; b: CalcNode }
  | { t: "neg"; a: CalcNode };

export class CalcError extends Error {}

export function parseCalc(src: string): CalcNode {
  if (src.length > 500) throw new CalcError("Formula is too long");
  let i = 0;
  let depth = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const expr = (): CalcNode => {
    let a = term();
    for (;;) {
      ws();
      const c = src[i];
      if (c !== "+" && c !== "-") return a;
      i++;
      a = { t: "op", op: c, a, b: term() };
    }
  };
  const term = (): CalcNode => {
    let a = factor();
    for (;;) {
      ws();
      const c = src[i];
      if (c !== "*" && c !== "/") return a;
      i++;
      a = { t: "op", op: c, a, b: factor() };
    }
  };
  const factor = (): CalcNode => {
    ws();
    const c = src[i];
    if (c === "-") {
      i++;
      return { t: "neg", a: factor() };
    }
    if (c === "(") {
      if (++depth > 10) throw new CalcError("Too many nested parentheses");
      i++;
      const e = expr();
      ws();
      if (src[i] !== ")") throw new CalcError(`Expected ")" at position ${i + 1}`);
      i++;
      depth--;
      return e;
    }
    if (c === "{") {
      const end = src.indexOf("}", i);
      if (end < 0) throw new CalcError("Unclosed {metric}");
      const key = src.slice(i + 1, end).trim();
      if (!METRIC_MAP.has(key) || INTERNAL_METRICS.has(key)) throw new CalcError(`Unknown metric "${key}"`);
      i = end + 1;
      return { t: "ref", key };
    }
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      return { t: "num", v: Number(m[0]) };
    }
    throw new CalcError(c ? `Unexpected "${c}" at position ${i + 1}` : "Formula is incomplete");
  };
  const node = expr();
  ws();
  if (i < src.length) throw new CalcError(`Unexpected "${src[i]}" at position ${i + 1}`);
  if (!calcRefs(node).length) throw new CalcError("Use at least one {metric}");
  return node;
}

export function calcRefs(n: CalcNode): string[] {
  switch (n.t) {
    case "num":
      return [];
    case "ref":
      return [n.key];
    case "neg":
      return calcRefs(n.a);
    case "op":
      return [...new Set([...calcRefs(n.a), ...calcRefs(n.b)])];
  }
}

/** Evaluate with resolved inputs. Any missing input or division by zero → null (unavailable). */
export function evalCalc(n: CalcNode, values: Record<string, number | null>): number | null {
  switch (n.t) {
    case "num":
      return n.v;
    case "ref":
      return values[n.key] ?? null;
    case "neg": {
      const a = evalCalc(n.a, values);
      return a == null ? null : -a;
    }
    case "op": {
      const a = evalCalc(n.a, values);
      const b = evalCalc(n.b, values);
      if (a == null || b == null) return null;
      if (n.op === "/") return b === 0 ? null : a / b;
      return n.op === "+" ? a + b : n.op === "-" ? a - b : a * b;
    }
  }
}

export function formatCalc(n: CalcNode): string {
  switch (n.t) {
    case "num":
      return String(n.v);
    case "ref":
      return METRIC_MAP.get(n.key)?.label ?? n.key;
    case "neg":
      return `−${formatCalc(n.a)}`;
    case "op":
      return `(${formatCalc(n.a)} ${n.op === "*" ? "×" : n.op === "/" ? "÷" : n.op} ${formatCalc(n.b)})`;
  }
}

export interface CalculatedMetric {
  id: string;
  name: string;
  expression: string;
  unit: "currency" | "count" | "percent" | "multiplier" | "number";
  description: string | null;
  createdAt: string;
}
