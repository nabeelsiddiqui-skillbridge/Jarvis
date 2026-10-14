import { INTERNAL_METRICS, METRICS, type BaseMetric } from "@bca/shared";

/**
 * Shared table parser for the CSV upload and Google Sheets connectors.
 *
 * Format ("wide"): one row per day. A `date` column (YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY or
 * MM/DD/YYYY when the column makes the order unambiguous, or spreadsheet serial numbers),
 * then one column per metric, named by metric key ("store_net_sales") or label
 * ("Store net sales"), case-insensitive. An optional `currency` column sets the currency
 * of each row's money figures (else the business currency).
 *
 * Empty cells mean "no figure for that day" — never zero. Numbers may carry thousands
 * separators, currency symbols or codes, a % sign, or parentheses for negatives. When a
 * date appears twice the later row wins (with a warning). Only base metrics whose sources
 * list the importing provider are accepted; other columns are reported as ignored.
 */

export type Cell = string | number | boolean | null | undefined;
export type ImportProvider = "csv" | "google_sheets";

export interface TableRow {
  date: string;
  values: Record<string, number>;
  currency: string | null;
}

export interface ParsedTable {
  /** One entry per date, sorted. */
  rows: TableRow[];
  metrics: { key: string; label: string }[];
  ignoredColumns: string[];
  warnings: string[];
  /** Data rows read (non-empty rows below the header). */
  rowCount: number;
  from: string | null;
  to: string | null;
  /** Currency of the money figures kept. */
  currency: string;
}

/** The file can't be imported; `problems` are user-facing explanations. */
export class TableError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(" "));
  }
}

export const MAX_ROWS = 50_000;
const MAX_WARNINGS = 25;

/** Base metrics a provider may import (the catalog's `sources` include it). */
export function importableMetrics(provider: ImportProvider): BaseMetric[] {
  return METRICS.filter((m): m is BaseMetric => m.kind === "base" && m.sources.includes(provider) && !INTERNAL_METRICS.has(m.key));
}

// ------------------------------------------------------------------ CSV text → cells

/** Detect the delimiter from the header line (outside quotes): `,`, `;` or tab. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  const best = (Object.entries(counts) as [keyof typeof counts, number][]).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ",";
}

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, CRLF/LF/CR, BOM. */
export function parseCsv(text: string, delimiter = detectDelimiter(text.replace(/^﻿/, ""))): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r" && s[i + 1] === "\n") i++;
    } else field += ch;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------------ cells → values

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const EMPTY = new Set(["", "-", "–", "—", "n/a", "na", "null", "none"]);

/**
 * Parse a numeric cell. Returns null for empty cells and NaN for text that isn't a number.
 * `decimalComma`: the file uses `;` as delimiter, so "1,5" is one and a half.
 */
export function parseNumber(cell: Cell, decimalComma = false): number | null {
  if (cell == null) return null;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : NaN;
  if (typeof cell === "boolean") return NaN;
  let s = cell.trim();
  if (EMPTY.has(s.toLowerCase())) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^[A-Za-z]{3}\s+|\s+[A-Za-z]{3}$/g, ""); // currency codes: "USD 12", "12 EUR"
  s = s.replace(/[$€£¥₹₩₽¢%\s '’]/g, "");
  if (/^[-−]/.test(s)) {
    negative = !negative;
    s = s.slice(1);
  } else if (/-$/.test(s)) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  s = s.replace(/^[$€£¥₹₩₽¢]/, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the last one is the decimal separator.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const groups = /^\d{1,3}(,\d{3})+$/.test(s);
    const many = (s.match(/,/g) ?? []).length > 1;
    s = many || (groups && !decimalComma) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if ((s.match(/\./g) ?? []).length > 1 || (decimalComma && /^\d{1,3}(\.\d{3})+$/.test(s))) {
    s = s.replace(/\./g, ""); // 1.234.567, or 1.234 in a decimal-comma file
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  const n = Number(s);
  return negative ? -n : n;
}

const pad = (n: number) => String(n).padStart(2, "0");
function validDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Spreadsheet serial day number (Sheets/Excel; day 0 = 1899-12-30) → YYYY-MM-DD. */
export function serialToDate(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 120_000) return null;
  const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000);
  return dt.toISOString().slice(0, 10);
}

type DateShape = { kind: "iso"; value: string | null } | { kind: "dm"; a: number; b: number; y: number } | { kind: "bad" } | { kind: "empty" };

function dateShape(cell: Cell): DateShape {
  if (cell == null || cell === "") return { kind: "empty" };
  if (typeof cell === "number") return { kind: "iso", value: serialToDate(cell) };
  const s = String(cell).trim();
  if (!s) return { kind: "empty" };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return { kind: "iso", value: validDate(+m[1]!, +m[2]!, +m[3]!) };
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return { kind: "dm", a: +m[1]!, b: +m[2]!, y: +m[3]! };
  if (/^\d{4,6}(\.\d+)?$/.test(s)) return { kind: "iso", value: serialToDate(Number(s)) };
  return { kind: "bad" };
}

// ------------------------------------------------------------------ table → rows

export interface ParseOptions {
  provider: ImportProvider;
  /** Business currency, used when there's no currency column. */
  defaultCurrency: string;
  maxRows?: number;
  /** Numbers use a decimal comma ("1.234,5"); detected for `;`-separated CSV. */
  decimalComma?: boolean;
}

/** Collects repeated problems into one line each ("12 cells … e.g. row 5"). */
class Warnings {
  private groups = new Map<string, { n: number; example: string }>();
  private plain: string[] = [];
  add(msg: string) {
    this.plain.push(msg);
  }
  group(kind: string, example: string) {
    const g = this.groups.get(kind);
    if (g) g.n++;
    else this.groups.set(kind, { n: 1, example });
  }
  list() {
    const out = [...this.plain];
    for (const [kind, g] of this.groups) out.push(`${kind}: ${g.n} ${g.n === 1 ? "case" : "cases"} (e.g. ${g.example}).`);
    return out.slice(0, MAX_WARNINGS);
  }
}

export function parseTable(cells: Cell[][], opts: ParseOptions): ParsedTable {
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const isBlank = (r: Cell[]) => r.every((c) => c == null || String(c).trim() === "");
  const start = cells.findIndex((r) => !isBlank(r));
  if (start < 0) throw new TableError(["The file is empty."]);
  const header = cells[start]!.map((c) => (c == null ? "" : String(c).trim()));
  const body = cells.slice(start + 1).map((r, i) => ({ r, line: start + i + 2 })).filter((x) => !isBlank(x.r));
  if (body.length > maxRows) throw new TableError([`The file has ${body.length.toLocaleString("en-US")} rows; the limit is ${maxRows.toLocaleString("en-US")} (one row per day).`]);

  // ---- columns
  const metrics = importableMetrics(opts.provider);
  const byName = new Map<string, BaseMetric>();
  for (const m of metrics) {
    byName.set(norm(m.key), m);
    byName.set(norm(m.label), m);
  }
  const warnings = new Warnings();
  let dateCol = -1;
  let currencyCol = -1;
  const metricCols: { col: number; metric: BaseMetric }[] = [];
  const ignored: string[] = [];
  header.forEach((h, col) => {
    const n = norm(h);
    if (!n) return;
    if ((n === "date" || n === "day") && dateCol < 0) dateCol = col;
    else if (n === "currency" && currencyCol < 0) currencyCol = col;
    else {
      const m = byName.get(n);
      if (!m) ignored.push(h);
      else if (metricCols.some((x) => x.metric.key === m.key)) {
        ignored.push(h);
        warnings.add(`Column "${h}" repeats ${m.label}; only the first such column is used.`);
      } else metricCols.push({ col, metric: m });
    }
  });
  const problems: string[] = [];
  if (dateCol < 0) problems.push('No "date" column found. The first row must be a header with a "date" column and one column per metric.');
  if (!metricCols.length) problems.push(`No recognised metric columns${ignored.length ? ` (found: ${ignored.slice(0, 8).map((h) => `"${h}"`).join(", ")})` : ""}. Use metric keys or names such as store_net_sales, ad_spend or acct_revenue — download the template for the full list.`);
  if (problems.length) throw new TableError(problems);
  if (!body.length) throw new TableError(["The file has a header but no data rows."]);

  // ---- date order for DD/MM/YYYY vs MM/DD/YYYY
  const shapes = body.map((x) => dateShape(x.r[dateCol]));
  const dm = shapes.filter((s): s is Extract<DateShape, { kind: "dm" }> => s.kind === "dm");
  let order: "dmy" | "mdy" | null = null;
  if (dm.length) {
    const dayFirst = dm.some((s) => s.a > 12);
    const monthFirst = dm.some((s) => s.b > 12);
    if (dayFirst && monthFirst) throw new TableError(["The date column mixes day/month and month/day order. Use YYYY-MM-DD dates."]);
    if (dayFirst) order = "dmy";
    else if (monthFirst) order = "mdy";
    else if (dm.some((s) => s.a !== s.b)) {
      throw new TableError([`Dates like "${body[shapes.indexOf(dm.find((s) => s.a !== s.b)!)]!.r[dateCol]}" are ambiguous (day/month or month/day?). Use YYYY-MM-DD dates.`]);
    } else order = "dmy";
  }

  const decimalComma = opts.decimalComma ?? false;
  const ccy = (c: Cell) => {
    const s = c == null ? "" : String(c).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(s) ? s : null;
  };
  // Money figures keep one currency: the business currency if the file uses it (or doesn't say), else the most common one.
  let currency = opts.defaultCurrency;
  if (currencyCol >= 0) {
    const counts = new Map<string, number>();
    for (const { r } of body) {
      const c = ccy(r[currencyCol]);
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    if (counts.size && !counts.has(opts.defaultCurrency)) currency = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  }

  const byDate = new Map<string, TableRow>();
  const duplicates = new Set<string>();
  let skippedCurrency = 0;
  body.forEach(({ r, line }, i) => {
    const shape = shapes[i]!;
    let date: string | null = null;
    if (shape.kind === "iso") date = shape.value;
    else if (shape.kind === "dm") date = order === "mdy" ? validDate(shape.y, shape.a, shape.b) : validDate(shape.y, shape.b, shape.a);
    if (!date) {
      warnings.group("Rows skipped because the date is missing or not a valid date", `row ${line}: "${r[dateCol] ?? ""}"`);
      return;
    }
    const rowCcy = currencyCol >= 0 ? ccy(r[currencyCol]) ?? currency : currency;
    const row = byDate.get(date) ?? { date, values: {}, currency: null };
    if (byDate.has(date)) duplicates.add(date);
    for (const { col, metric } of metricCols) {
      const v = parseNumber(r[col], decimalComma);
      if (v == null) continue;
      if (Number.isNaN(v)) {
        warnings.group("Cells ignored because they aren't numbers", `row ${line}, ${metric.label}: "${r[col]}"`);
        continue;
      }
      if (metric.unit === "currency") {
        if (rowCcy !== currency) {
          skippedCurrency++;
          continue;
        }
        row.values[metric.key] = Math.round(v * 100) / 100;
        row.currency = currency;
      } else row.values[metric.key] = v;
    }
    byDate.set(date, row);
  });
  if (duplicates.size) {
    const list = [...duplicates].sort();
    warnings.add(`${list.length} ${list.length === 1 ? "date appears" : "dates appear"} more than once (${list.slice(0, 3).join(", ")}${list.length > 3 ? "…" : ""}); the later row's figures were used.`);
  }
  if (skippedCurrency) warnings.add(`${skippedCurrency} money ${skippedCurrency === 1 ? "figure" : "figures"} in another currency than ${currency} ${skippedCurrency === 1 ? "was" : "were"} skipped (figures in different currencies can't be combined).`);
  if (ignored.length) warnings.add(`Ignored ${ignored.length} unrecognised ${ignored.length === 1 ? "column" : "columns"}: ${ignored.slice(0, 8).map((h) => `"${h}"`).join(", ")}${ignored.length > 8 ? "…" : ""}.`);

  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) throw new TableError(["No row has a valid date. Use YYYY-MM-DD dates.", ...warnings.list()]);
  return {
    rows,
    metrics: metricCols.map(({ metric }) => ({ key: metric.key, label: metric.label })),
    ignoredColumns: ignored,
    warnings: warnings.list(),
    rowCount: body.length,
    from: rows[0]!.date,
    to: rows[rows.length - 1]!.date,
    currency,
  };
}

/** Parse CSV text (delimiter detected; `;`-separated files use decimal commas: "1.234,5"). */
export function parseCsvTable(text: string, opts: ParseOptions): ParsedTable {
  const clean = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(clean);
  return parseTable(parseCsv(clean, delimiter), { ...opts, decimalComma: opts.decimalComma ?? delimiter === ";" });
}
