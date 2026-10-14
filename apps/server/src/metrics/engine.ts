import type pg from "pg";
import {
  addDays,
  baseDependencies,
  bucketOf,
  calcRefs,
  daysBetween,
  eachDay,
  evalCalc,
  formatCalc,
  getMetric,
  MANUAL_SOURCES,
  previousPeriod,
  previousYear,
  resolvePreset,
  todayIn,
  type BaseMetric,
  type CalcNode,
  type DateRange,
  type DateRangeSpec,
  type MetricDef,
  type ProviderId,
  type QueryResult,
  type SourceInfo,
  type WidgetQuery,
} from "@bca/shared";
import { PROVIDER_META } from "./providers.js";

/**
 * The metric query engine. Turns a validated widget query into numbers + provenance.
 * All SQL is parameterized; queries run on the caller's RLS-scoped connection.
 */

export interface EngineBusiness {
  id: string;
  timezone: string;
  currency: string;
  is_demo: boolean;
}

interface CalcDef {
  id: string;
  name: string;
  unit: string;
  ast: CalcNode;
  description: string | null;
  expression: string;
}

type Values = Record<string, number | null>;

// ------------------------------------------------------------------ availability

export interface Availability {
  /** base metric → providers with data, in registry precedence order */
  providers: Map<string, { provider: string; minDate: string; maxDate: string }[]>;
  sources: SourceInfo[];
  connections: Map<string, SourceInfo>;
}

/** What data this business has: which base metrics, from which providers, which date span. */
export async function loadAvailability(db: pg.PoolClient, business: EngineBusiness): Promise<Availability> {
  const facts = await db.query(
    `SELECT f.metric_key, f.provider, min(f.date)::text AS min_date, max(f.date)::text AS max_date
       FROM metric_facts f JOIN connection_assets a ON a.id = f.asset_id AND a.selected
      WHERE f.business_id = $1 AND f.dim_key = ''
      GROUP BY f.metric_key, f.provider`,
    [business.id],
  );
  const providers = new Map<string, { provider: string; minDate: string; maxDate: string }[]>();
  for (const r of facts.rows) {
    const list = providers.get(r.metric_key) ?? [];
    list.push({ provider: r.provider, minDate: r.min_date, maxDate: r.max_date });
    providers.set(r.metric_key, list);
  }
  for (const [key, list] of providers) {
    const order = (getMetric(key) as BaseMetric | undefined)?.sources ?? [];
    list.sort((a, b) => order.indexOf(a.provider as never) - order.indexOf(b.provider as never));
  }

  const conns = await db.query(
    `SELECT c.id, c.provider, c.display_name, c.is_demo, c.status, c.last_success_at, c.disconnected_at,
            string_agg(a.name, ', ' ORDER BY a.name) FILTER (WHERE a.selected) AS assets,
            max(a.latest_data_date)::text AS latest_data_date
       FROM connections c LEFT JOIN connection_assets a ON a.connection_id = c.id
      WHERE c.business_id = $1
      GROUP BY c.id`,
    [business.id],
  );
  const connections = new Map<string, SourceInfo>();
  for (const r of conns.rows) {
    const meta = PROVIDER_META[r.provider];
    const lastSuccess = r.last_success_at ? new Date(r.last_success_at) : null;
    const staleAfterMs = (meta?.staleAfterHours ?? 26) * 3_600_000;
    const stale = !r.is_demo && (r.disconnected_at != null || !lastSuccess || Date.now() - lastSuccess.getTime() > staleAfterMs);
    connections.set(r.id, {
      connectionId: r.id,
      provider: r.provider,
      accountName: r.display_name,
      assetName: r.assets,
      isDemo: r.is_demo,
      status: r.disconnected_at ? "disconnected" : r.status,
      lastSyncedAt: lastSuccess?.toISOString() ?? null,
      latestDataDate: r.latest_data_date,
      stale,
      reportingDelay: meta?.reportingDelay ?? null,
    });
  }
  return { providers, sources: [...connections.values()], connections };
}

export function availableBaseMetrics(av: Availability): Set<string> {
  return new Set(av.providers.keys());
}

// ------------------------------------------------------------------ helpers

function resolveRange(spec: DateRangeSpec | null, fallback: DateRangeSpec, timezone: string): DateRange {
  const s = spec ?? fallback;
  return "preset" in s ? resolvePreset(s.preset, todayIn(timezone)) : { from: s.from, to: s.to };
}

function describeFormula(m: MetricDef): string | null {
  if (m.kind === "base") return null;
  const label = (k: string) => getMetric(k)?.label ?? k;
  const f = m.formula;
  if (f.op === "ratio") return `${label(f.numerator)} ÷ ${label(f.denominator)}${f.scale && f.scale !== 1 ? ` × ${f.scale}` : ""}`;
  if (f.op === "difference") return `${label(f.minuend)} − ${label(f.subtrahend)}`;
  return f.terms.map(label).join(" + ");
}

/** Evaluate a registry metric from base values (recursively for derived metrics). */
function evaluate(key: string, base: Values): number | null {
  const m = getMetric(key);
  if (!m) return null;
  if (m.kind === "base") return base[key] ?? null;
  const f = m.formula;
  if (f.op === "ratio") {
    const n = evaluate(f.numerator, base);
    const d = evaluate(f.denominator, base);
    if (n == null || d == null || d === 0) return null;
    return (n / d) * (f.scale ?? 1);
  }
  if (f.op === "difference") {
    const a = evaluate(f.minuend, base);
    const b = evaluate(f.subtrahend, base);
    return a == null || b == null ? null : a - b;
  }
  let sum = 0;
  for (const t of f.terms) {
    const v = evaluate(t, base);
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

interface Target {
  key: string;
  label: string;
  unit: string;
  description: string;
  formula: string | null;
  higherIsBetter: boolean;
  deps: string[];
  dimensions: string[];
  eval: (base: Values) => number | null;
}

function targetFor(ref: string, calcs: Map<string, CalcDef>): Target | null {
  if (ref.startsWith("calc:")) {
    const c = calcs.get(ref.slice(5));
    if (!c) return null;
    const refs = calcRefs(c.ast);
    const deps = [...new Set(refs.flatMap((r) => baseDependencies(r)))];
    // Breakdowns are allowed only on dimensions every referenced metric supports.
    const dims = refs.map((r) => getMetric(r)?.dimensions ?? []).reduce((a, b) => a.filter((d) => b.includes(d)));
    return {
      key: ref,
      label: c.name,
      unit: c.unit,
      description: c.description ?? `Calculated: ${c.expression}`,
      formula: formatCalc(c.ast),
      higherIsBetter: true,
      deps,
      dimensions: dims,
      eval: (base) => evalCalc(c.ast, Object.fromEntries(refs.map((r) => [r, evaluate(r, base)]))),
    };
  }
  const m = getMetric(ref);
  if (!m) return null;
  return {
    key: m.key,
    label: m.label,
    unit: m.unit,
    description: m.description,
    formula: describeFormula(m),
    higherIsBetter: m.higherIsBetter,
    deps: baseDependencies(m.key),
    dimensions: m.dimensions,
    eval: (base) => evaluate(m.key, base),
  };
}

// ------------------------------------------------------------------ main entry

export interface QueryContext {
  db: pg.PoolClient;
  business: EngineBusiness;
  availability: Availability;
  calcs: Map<string, CalcDef>;
  dashboardRange: DateRangeSpec;
}

export async function loadCalcs(db: pg.PoolClient, businessId: string): Promise<Map<string, CalcDef>> {
  const { rows } = await db.query("SELECT id, name, unit, ast, description, expression FROM calculated_metrics WHERE business_id = $1", [businessId]);
  return new Map(rows.map((r) => [r.id, r as CalcDef]));
}

export async function runQuery(ctx: QueryContext, q: WidgetQuery): Promise<QueryResult> {
  const { db, business, availability } = ctx;
  const target = targetFor(q.metric, ctx.calcs);
  if (!target) throw new Error(`Unknown metric ${q.metric}`);

  const range = resolveRange(q.dateRange, ctx.dashboardRange, business.timezone);
  const cmpRange = q.comparison === "previous_period" ? previousPeriod(range) : q.comparison === "previous_year" ? previousYear(range) : null;
  const limitations: string[] = [];
  const today = todayIn(business.timezone);
  if (range.to >= today) limitations.push("Includes today, which is still in progress.");

  // ---- choose providers for every base metric: precedence, or a sum across platforms for combinable metrics
  const extraTargets = q.metrics.map((k) => targetFor(k, ctx.calcs)).filter((t): t is Target => Boolean(t));
  const allDeps = [...new Set([target, ...extraTargets].flatMap((t) => t.deps))];
  const chosen = new Map<string, string[]>();
  const missing: string[] = [];
  const pname = (p: string) => PROVIDER_META[p]?.name ?? p;
  const names = (ps: string[]) => ps.map(pname).join(", ");
  for (const dep of allDeps) {
    const m = getMetric(dep) as BaseMetric | undefined;
    const options = (availability.providers.get(dep) ?? []).filter((p) => !q.sources.length || q.sources.includes(p.provider));
    if (!options.length) {
      missing.push(dep);
      continue;
    }
    if (m?.combine === "sum") {
      const platforms = options.filter((o) => !MANUAL_SOURCES.includes(o.provider as ProviderId));
      chosen.set(dep, (platforms.length ? platforms : [options[0]!]).map((o) => o.provider));
    } else {
      chosen.set(dep, [options[0]!.provider]);
      if (options.length > 1) limitations.push(`${m?.label} is available from several sources; using ${pname(options[0]!.provider)} (not combined).`);
    }
  }
  // Inputs of one figure must come from the same platforms (e.g. profit = sales − costs only where costs exist).
  const combinedDeps = target.deps.filter((d) => (getMetric(d) as BaseMetric | undefined)?.combine === "sum" && chosen.has(d));
  if (combinedDeps.length > 1) {
    const sets = combinedDeps.map((d) => chosen.get(d)!);
    const common = sets[0]!.filter((p) => sets.every((s) => s.includes(p)));
    if (common.length && sets.some((s) => s.length !== common.length)) {
      const dropped = [...new Set(sets.flat())].filter((p) => !common.includes(p));
      for (const d of combinedDeps) chosen.set(d, chosen.get(d)!.filter((p) => common.includes(p)));
      limitations.push(`${target.label} uses ${names(common)} only; ${names(dropped)} ${dropped.length > 1 ? "don't" : "doesn't"} report every input it needs.`);
    }
  }
  for (const dep of target.deps) {
    const ps = chosen.get(dep);
    if (!ps || ps.length < 2) continue;
    const m = getMetric(dep) as BaseMetric;
    limitations.push(`${m.label} combines ${names(ps)}.${m.combineNote ? ` ${m.combineNote}` : ""}`);
    for (const p of ps) {
      const span = availability.providers.get(dep)?.find((x) => x.provider === p);
      if (span && span.minDate > range.from) limitations.push(`${pname(p)} ${m.label.toLowerCase()} starts ${span.minDate}; earlier days include the other platforms only.`);
    }
  }

  const baseResult = (): QueryResult => ({
    metric: { key: target.key, label: target.label, unit: target.unit, description: target.description, formula: target.formula, higherIsBetter: target.higherIsBetter },
    currency: business.currency,
    timezone: business.timezone,
    range,
    comparisonRange: cmpRange,
    availability: "available",
    unavailableReason: null,
    total: null,
    comparisonTotal: null,
    change: null,
    comparisonPartial: false,
    series: null,
    rows: null,
    steps: null,
    sources: [],
    freshness: { latestDataDate: null, lastSyncedAt: null, stale: false },
    limitations,
    isDemo: business.is_demo,
  });

  const targetMissing = target.deps.filter((d) => missing.includes(d));
  if (targetMissing.length) {
    const r = baseResult();
    r.availability = "unavailable";
    const needs = [...new Set(targetMissing.flatMap((d) => (getMetric(d) as BaseMetric).sources))].map((p) => PROVIDER_META[p]?.name ?? p);
    r.unavailableReason = `No data for ${targetMissing.map((d) => getMetric(d)?.label).join(", ")}. Connect ${needs.join(" or ")} to enable this metric.`;
    if (target.deps.includes("store_cogs")) r.unavailableReason += " Profit needs product costs (COGS) from your store.";
    return r;
  }

  // ---- fetch daily totals for every chosen (metric, provider) across both ranges
  const spanFrom = cmpRange && cmpRange.from < range.from ? cmpRange.from : range.from;
  const pairs = [...chosen.entries()].flatMap(([k, ps]) => ps.map((p) => [k, p] as const));
  const keys = pairs.map((x) => x[0]);
  const provs = pairs.map((x) => x[1]);
  const totalsSql = `
    SELECT f.metric_key, f.date::text AS date, sum(f.value)::float8 AS value, array_agg(DISTINCT f.currency) FILTER (WHERE f.currency IS NOT NULL) AS currencies,
           array_agg(DISTINCT f.connection_id) AS connections
      FROM metric_facts f JOIN connection_assets a ON a.id = f.asset_id AND a.selected
      JOIN unnest($2::text[], $3::text[]) AS c(metric_key, provider) ON c.metric_key = f.metric_key AND c.provider = f.provider
     WHERE f.business_id = $1 AND f.dim_key = '' AND f.date BETWEEN $4 AND $5
     GROUP BY f.metric_key, f.date`;
  const { rows } = await db.query(totalsSql, [business.id, keys, provs, spanFrom, range.to]);

  // metric → date → value
  const daily = new Map<string, Map<string, number>>();
  const currencies = new Set<string>();
  const usedConnections = new Set<string>();
  for (const r of rows) {
    if (!daily.has(r.metric_key)) daily.set(r.metric_key, new Map());
    daily.get(r.metric_key)!.set(r.date, r.value); // summed across the chosen platforms
    const m = getMetric(r.metric_key);
    if (m?.unit === "currency") for (const c of r.currencies ?? []) currencies.add(c);
    for (const c of r.connections ?? []) usedConnections.add(c);
  }

  const result = baseResult();
  result.sources = [...usedConnections].map((id) => availability.connections.get(id)).filter((s): s is SourceInfo => Boolean(s));
  if (!result.sources.length) result.sources = availability.sources.filter((s) => provs.includes(s.provider));
  result.freshness = {
    latestDataDate: result.sources.map((s) => s.latestDataDate).filter(Boolean).sort().pop() ?? null,
    lastSyncedAt: result.sources.map((s) => s.lastSyncedAt).filter(Boolean).sort().shift() ?? null,
    stale: result.sources.some((s) => s.stale),
  };
  if (result.freshness.stale) limitations.push("One or more sources haven't synced recently; figures may be out of date.");

  // ---- currency integrity: never mix or silently convert
  if (currencies.size > 1) {
    result.availability = "unavailable";
    result.unavailableReason = `Connected accounts report in different currencies (${[...currencies].join(", ")}). Values aren't converted, so they can't be combined.`;
    return result;
  }
  if (currencies.size === 1) {
    const [cur] = [...currencies];
    if (cur !== business.currency) limitations.push(`Values are in ${cur} (the source account's currency), not the business reporting currency ${business.currency}.`);
    result.currency = cur!;
  }

  // ---- coverage: a day counts only if every dependency has a total row that day
  const covered = (r: DateRange, deps: string[]) => eachDay(r).filter((d) => deps.every((k) => daily.get(k)?.has(d)));
  const daysIn = covered(range, target.deps);
  const nDays = daysBetween(range.from, range.to);
  if (!daysIn.length) {
    result.availability = "unavailable";
    result.unavailableReason = `No data in ${range.from} – ${range.to}. Sources cover ${target.deps.map((k) => {
      const p = availability.providers.get(k)?.find((x) => chosen.get(k)?.includes(x.provider));
      return p ? `${p.minDate} – ${p.maxDate}` : "nothing";
    })[0]}.`;
    return result;
  }
  if (daysIn.length < nDays) {
    result.availability = "partial";
    const missingDays = eachDay(range).filter((d) => !daysIn.includes(d));
    const sample = missingDays.length > 3 ? `${missingDays[0]} … ${missingDays[missingDays.length - 1]}` : missingDays.join(", ");
    limitations.push(`Data is missing for ${missingDays.length} of ${nDays} days (${sample}); totals cover available days only.`);
  }

  // ---- aggregate days into values (sum, or last day for snapshots)
  const aggregate = (days: string[], deps: string[]): Values => {
    const out: Values = {};
    for (const k of deps) {
      const m = getMetric(k) as BaseMetric;
      const map = daily.get(k);
      if (!map || !days.length) {
        out[k] = null;
        continue;
      }
      if (m.aggregation === "snapshot") {
        const last = [...days].reverse().find((d) => map.has(d));
        out[k] = last ? map.get(last)! : null;
      } else out[k] = days.reduce((s, d) => s + (map.get(d) ?? 0), 0);
    }
    return out;
  };

  result.total = target.eval(aggregate(daysIn, target.deps));
  if (cmpRange) {
    const cmpDays = covered(cmpRange, target.deps);
    if (cmpDays.length === daysBetween(cmpRange.from, cmpRange.to)) {
      result.comparisonTotal = target.eval(aggregate(cmpDays, target.deps));
    } else if (cmpDays.length) {
      result.comparisonTotal = target.eval(aggregate(cmpDays, target.deps));
      result.comparisonPartial = true;
      limitations.push(`The comparison period is only partly covered (${cmpDays.length} of ${daysBetween(cmpRange.from, cmpRange.to)} days), so no % change is shown.`);
    } else {
      limitations.push("No data for the comparison period.");
    }
    if (!result.comparisonPartial && result.total != null && result.comparisonTotal != null && result.comparisonTotal !== 0) {
      result.change = ((result.total - result.comparisonTotal) / Math.abs(result.comparisonTotal)) * 100;
    }
  }

  // ---- time series
  if (q.granularity !== "none" && !q.dimension) {
    const g = q.granularity;
    const buckets = [...new Set(eachDay(range).map((d) => bucketOf(d, g)))];
    const cmpBuckets = cmpRange ? [...new Set(eachDay(cmpRange).map((d) => bucketOf(d, g)))] : [];
    const daysOf = (r: DateRange, bucket: string) => eachDay(r).filter((d) => bucketOf(d, g) === bucket);
    result.series = buckets.map((b, i) => {
      const days = covered(range, target.deps).filter((d) => bucketOf(d, g) === b);
      const cb = cmpBuckets[i];
      const cdays = cb && cmpRange ? daysOf(cmpRange, cb).filter((d) => target.deps.every((k) => daily.get(k)?.has(d))) : [];
      return {
        bucket: b,
        value: days.length ? target.eval(aggregate(days, target.deps)) : null,
        comparison: cdays.length ? target.eval(aggregate(cdays, target.deps)) : null,
      };
    });
  }

  // ---- funnel / multi-metric totals
  if (extraTargets.length && !q.dimension) {
    result.steps = [target, ...extraTargets].map((t) => {
      const miss = t.deps.filter((d) => missing.includes(d));
      const days = miss.length ? [] : covered(range, t.deps);
      return { key: t.key, label: t.label, unit: t.unit, value: days.length ? t.eval(aggregate(days, t.deps)) : null };
    });
    const unavailableSteps = result.steps.filter((s) => s.value == null).map((s) => s.label);
    if (unavailableSteps.length) limitations.push(`Unavailable: ${unavailableSteps.join(", ")}.`);
  }

  // ---- dimensional breakdown
  if (q.dimension) {
    result.rows = await breakdown(ctx, q, target, extraTargets, chosen, range, daysIn, limitations);
  }

  return result;
}

async function breakdown(
  ctx: QueryContext,
  q: WidgetQuery,
  target: Target,
  extras: Target[],
  chosen: Map<string, string[]>,
  range: DateRange,
  daysIn: string[],
  limitations: string[],
): Promise<QueryResult["rows"]> {
  if (!target.dimensions.includes(q.dimension!)) {
    limitations.push(`${target.label} can't be broken down by ${q.dimension}.`);
    return [];
  }
  const deps = [...new Set([target, ...extras].flatMap((t) => t.deps))].filter((k) => chosen.has(k));
  const pairs = deps.flatMap((k) => chosen.get(k)!.map((p) => [k, p] as const));
  // "platform" isn't stored as a dimension: it's the provider of each daily total.
  const byPlatform = q.dimension === "platform";
  const dimExpr = byPlatform ? "f.provider" : "f.dim_value";
  const filter = q.filters[0];
  const params: unknown[] = [ctx.business.id, pairs.map((x) => x[0]), pairs.map((x) => x[1]), byPlatform ? "" : q.dimension, range.from, range.to];
  let where = "";
  if (filter) {
    // Platform filters may use provider ids or names.
    const values = byPlatform ? filter.values.map((v) => Object.entries(PROVIDER_META).find(([id, m]) => id === v || m.name === v)?.[0] ?? v) : filter.values;
    params.push(values);
    where = filter.op === "in" ? `AND ${dimExpr} = ANY($${params.length}::text[])` : `AND NOT (${dimExpr} = ANY($${params.length}::text[]))`;
  }
  const { rows: raw } = await ctx.db.query(
    `SELECT f.metric_key, ${dimExpr} AS dim_value, f.date::text AS date, sum(f.value)::float8 AS value
       FROM metric_facts f JOIN connection_assets a ON a.id = f.asset_id AND a.selected
       JOIN unnest($2::text[], $3::text[]) AS c(metric_key, provider) ON c.metric_key = f.metric_key AND c.provider = f.provider
      WHERE f.business_id = $1 AND f.dim_key = $4 AND f.date BETWEEN $5 AND $6 ${where}
      GROUP BY f.metric_key, ${dimExpr}, f.date`,
    params,
  );
  const rows = byPlatform ? raw.map((r) => ({ ...r, dim_value: PROVIDER_META[r.dim_value]?.name ?? r.dim_value })) : raw;
  // dim value → metric → date → value
  const byDim = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rows) {
    if (!byDim.has(r.dim_value)) byDim.set(r.dim_value, new Map());
    const m = byDim.get(r.dim_value)!;
    if (!m.has(r.metric_key)) m.set(r.metric_key, new Map());
    m.get(r.metric_key)!.set(r.date, r.value);
  }
  const days = new Set(daysIn);
  const agg = (perMetric: Map<string, Map<string, number>>, ks: string[]): Values => {
    const out: Values = {};
    for (const k of ks) {
      const m = getMetric(k) as BaseMetric;
      const map = perMetric.get(k);
      if (!map) {
        // A dimension value with no row for a sum metric in the covered period = 0 for that value.
        out[k] = m.aggregation === "sum" ? 0 : null;
        continue;
      }
      if (m.aggregation === "snapshot") {
        const last = [...daysIn].reverse().find((d) => map.has(d));
        out[k] = last ? map.get(last)! : null;
      } else {
        let s = 0;
        for (const [d, v] of map) if (days.has(d)) s += v;
        out[k] = s;
      }
    }
    return out;
  };
  let list = [...byDim.entries()].map(([label, perMetric]) => {
    const base = agg(perMetric, deps);
    return {
      label,
      value: target.eval(base),
      share: null as number | null,
      extra: extras.length ? Object.fromEntries(extras.map((t) => [t.key, t.eval(base)])) : undefined,
    };
  });
  const additive = target.deps.length === 1 && target.unit !== "percent" && getMetric(target.key)?.kind === "base";
  if (additive) {
    const sum = list.reduce((s, r) => s + (r.value ?? 0), 0);
    list.forEach((r) => (r.share = sum > 0 && r.value != null ? (r.value / sum) * 100 : null));
  }
  list.sort((a, b) =>
    q.sort === "label" ? a.label.localeCompare(b.label) : q.sort === "value_asc" ? (a.value ?? Infinity) - (b.value ?? Infinity) : (b.value ?? -Infinity) - (a.value ?? -Infinity),
  );
  if (list.length > q.limit) {
    limitations.push(`Showing top ${q.limit} of ${list.length} ${q.dimension?.replace("_", " ")} values.`);
    list = list.slice(0, q.limit);
  }
  return list;
}

export { resolveRange, addDays };
