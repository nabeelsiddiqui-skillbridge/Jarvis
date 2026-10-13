import type { AutomationSpec } from "@bca/shared";

/**
 * Next run time for a scheduled automation, in its own timezone (handles DST:
 * "08:00 every day" stays 08:00 local). Returns null for event-triggered ones.
 */
export function nextRunAt(trigger: AutomationSpec["trigger"], timezone: string, after: Date = new Date()): Date | null {
  if (trigger.type !== "schedule") return null;
  if (trigger.frequency === "hourly") {
    const t = new Date(after.getTime());
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(trigger.minute);
    if (t <= after) t.setUTCHours(t.getUTCHours() + 1);
    return t;
  }
  const local = localParts(after, timezone);
  for (let i = 0; i < 9; i++) {
    const day = addDaysYmd(local.date, i);
    if (trigger.frequency === "weekly" && weekdayOf(day) !== trigger.weekday) continue;
    const at = zonedToUtc(day, trigger.hour, trigger.minute, timezone);
    if (at > after) return at;
  }
  return null;
}

function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
const addDaysYmd = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();

/** The UTC instant at which the wall clock in `tz` shows `date hour:minute`. */
export function zonedToUtc(date: string, hour: number, minute: number, tz: string): Date {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(t), tz);
    const shown = Date.parse(`${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00Z`);
    t += guess - shown;
  }
  return new Date(t);
}
