/** Calendar-date helpers. Reporting dates are plain 'YYYY-MM-DD' strings in the business timezone. */

export const DATE_PRESETS = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_28_days: "Last 28 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  month_to_date: "Month to date",
  last_month: "Last month",
  quarter_to_date: "Quarter to date",
  year_to_date: "Year to date",
  last_12_months: "Last 12 months",
} as const;
export type DatePreset = keyof typeof DATE_PRESETS;

export interface DateRange {
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Today's date in a timezone, as YYYY-MM-DD. */
export function todayIn(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const fromUtc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function addDays(d: string, n: number): string {
  const x = toUtc(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fromUtc(x);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000) + 1;
}

export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

function addMonths(d: string, n: number): string {
  const x = toUtc(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return fromUtc(x);
}

/** Ranges are inclusive. "Last N days" ends yesterday (today is incomplete). */
export function resolvePreset(preset: DatePreset, today: string): DateRange {
  const y = addDays(today, -1);
  const [Y, M] = today.split("-").map(Number);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: y, to: y };
    case "last_7_days":
      return { from: addDays(today, -7), to: y };
    case "last_28_days":
      return { from: addDays(today, -28), to: y };
    case "last_30_days":
      return { from: addDays(today, -30), to: y };
    case "last_90_days":
      return { from: addDays(today, -90), to: y };
    case "month_to_date":
      return { from: `${Y}-${pad(M)}-01`, to: today };
    case "last_month": {
      const firstThis = `${Y}-${pad(M)}-01`;
      return { from: addMonths(firstThis, -1), to: addDays(firstThis, -1) };
    }
    case "quarter_to_date":
      return { from: `${Y}-${pad(Math.floor((M - 1) / 3) * 3 + 1)}-01`, to: today };
    case "year_to_date":
      return { from: `${Y}-01-01`, to: today };
    case "last_12_months":
      return { from: addMonths(`${Y}-${pad(M)}-01`, -12), to: addDays(`${Y}-${pad(M)}-01`, -1) };
  }
}

export function previousPeriod(r: DateRange): DateRange {
  const n = daysBetween(r.from, r.to);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

export function previousYear(r: DateRange): DateRange {
  return { from: addMonths(r.from, -12), to: addMonths(r.to, -12) };
}

/** Bucket key for a date at a granularity: day → date, week → Monday, month → YYYY-MM-01. */
export function bucketOf(date: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return date;
  if (granularity === "month") return `${date.slice(0, 7)}-01`;
  const dow = (toUtc(date).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -dow);
}

export function formatRange(r: DateRange, locale?: string): string {
  const f = (d: string, withYear: boolean) =>
    toUtc(d).toLocaleDateString(locale, { month: "short", day: "numeric", year: withYear ? "numeric" : undefined, timeZone: "UTC" });
  if (r.from === r.to) return f(r.from, true);
  return `${f(r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} – ${f(r.to, true)}`;
}

export function formatBucket(date: string, granularity: "day" | "week" | "month", locale?: string): string {
  const d = toUtc(date);
  if (granularity === "month") return d.toLocaleDateString(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
}
