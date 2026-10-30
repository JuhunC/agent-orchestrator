/**
 * When a schedule runs. Three ways to say it:
 * - a cron expression, five fields: minute hour day-of-month month day-of-week ("0 9 * * 1-5");
 * - a shortcut: @hourly, @daily, @weekly, @monthly, @yearly;
 * - an interval: "every 30m", "every 6h", "every 2d", "every week".
 * Cron times are wall-clock times in the schedule's time zone; intervals count from when the
 * schedule was made.
 */

interface CronField {
  values: Set<number>;
  /** The field was "*" (every value). */
  any: boolean;
  source: string;
}

export type When =
  | { kind: "cron"; text: string; minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField }
  | { kind: "every"; text: string; ms: number };

const SHORTCUTS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function field(source: string, name: string, min: number, max: number, names: string[] = []): CronField {
  const values = new Set<number>();
  const value = (text: string): number => {
    const index = names.indexOf(text.toLowerCase().slice(0, 3));
    const number = /^\d+$/.test(text) ? Number(text) : names.length && index >= 0 && text.length >= 3 ? index + (min === 1 ? 1 : 0) : NaN;
    if (!Number.isInteger(number)) throw new Error(`"${text}" isn't a valid ${name}`);
    return number;
  };
  for (const part of source.split(",")) {
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${part}" has a bad step in the ${name} field`);
    let from = min;
    let to = max;
    if (range !== "*") {
      const [start, end] = range.split("-") as [string, string | undefined];
      from = value(start);
      to = end !== undefined ? value(end) : stepText !== undefined ? max : from;
    }
    // Day of week 7 is Sunday too.
    const top = name === "day of the week" ? 7 : max;
    if (from < min || to > top || from > to) throw new Error(`"${part}" is out of range for the ${name} field (${min}-${top})`);
    for (let number = from; number <= to; number += step) values.add(name === "day of the week" && number === 7 ? 0 : number);
  }
  return { values, any: source === "*", source };
}

/** Reads a schedule's timing; throws an Error saying what's wrong. */
export function parseWhen(input: string): When {
  const text = input.trim().replace(/\s+/g, " ");
  const every = /^every (?:(\d+) ?)?(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i.exec(text);
  if (every) {
    const count = every[1] === undefined ? 1 : Number(every[1]);
    if (!count) throw new Error("An interval has to be at least 1");
    return { kind: "every", text: text.toLowerCase(), ms: count * UNITS[every[2]!.toLowerCase()[0]!]! };
  }
  if (/^every\b/i.test(text)) throw new Error(`"${text}" isn't an interval this understands: write it like "every 30m", "every 6h", "every 2d" or "every week"`);
  const expression = SHORTCUTS[text.toLowerCase()] ?? text;
  if (expression.startsWith("@")) throw new Error(`Unknown shortcut ${text} (use @hourly, @daily, @weekly, @monthly or @yearly)`);
  const parts = expression.split(" ");
  if (parts.length !== 5) throw new Error(`"${text}" needs five cron fields (minute hour day month weekday), a shortcut like @daily, or an interval like "every 6h"`);
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  return {
    kind: "cron",
    text,
    minute: field(minute, "minute", 0, 59),
    hour: field(hour, "hour", 0, 23),
    day: field(day, "day of the month", 1, 31),
    month: field(month, "month", 1, 12, MONTHS),
    weekday: field(weekday, "day of the week", 0, 6, DAYS),
  };
}

/** Throws unless this is a time zone the server knows ("UTC", "Asia/Seoul", "America/New_York"). */
export function checkTimezone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    throw new Error(`Unknown time zone "${timeZone}" (use a name like UTC, Europe/London or Asia/Seoul)`);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
interface Local {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function local(time: number, timeZone: string): Local {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(time)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
  };
}

/** The wall-clock minute a time falls on in a time zone, e.g. "2026-11-01 01:30". */
export function wallClock(time: Date | string, timeZone: string): string {
  const at = local(new Date(time).getTime(), timeZone);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${at.year}-${pad(at.month)}-${pad(at.day)} ${pad(at.hour)}:${pad(at.minute)}`;
}

function dayMatches(when: Extract<When, { kind: "cron" }>, at: Local): boolean {
  if (!when.month.values.has(at.month)) return false;
  const byDay = when.day.values.has(at.day);
  const byWeekday = when.weekday.values.has(at.weekday);
  // As in cron: when both are restricted, either one will do.
  if (!when.day.any && !when.weekday.any) return byDay || byWeekday;
  return byDay && byWeekday;
}

const MINUTE = 60_000;
/** Cron searches stop after this long (a Feb 29 schedule can wait almost 8 years). */
const HORIZON = 9 * 366 * 86_400_000;

/**
 * The first run strictly after `after`. Intervals count from `anchor` (when the schedule was made).
 * `previous` is the last run: a cron time that falls on the same wall-clock minute (a clock going
 * back for daylight saving) doesn't run twice. Null when a cron expression never matches.
 */
export function nextRun(when: When, timeZone: string, after: Date, anchor: Date = after, previous: Date | null = null): Date | null {
  if (when.kind === "every") {
    const steps = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / when.ms) + 1);
    return new Date(anchor.getTime() + steps * when.ms);
  }
  const skip = previous ? wallClock(previous, timeZone) : null;
  let time = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = time + HORIZON;
  while (time < end) {
    const at = local(time, timeZone);
    if (!dayMatches(when, at)) {
      // On to the next local midnight.
      time += ((23 - at.hour) * 60 + (60 - at.minute)) * MINUTE;
      continue;
    }
    if (!when.hour.values.has(at.hour)) {
      time += (60 - at.minute) * MINUTE;
      continue;
    }
    const minute = [...when.minute.values].sort((a, b) => a - b).find((value) => value >= at.minute);
    if (minute === undefined) {
      time += (60 - at.minute) * MINUTE;
      continue;
    }
    if (minute > at.minute) {
      time += (minute - at.minute) * MINUTE;
      continue;
    }
    if (skip && wallClock(new Date(time), timeZone) === skip) {
      time += MINUTE;
      continue;
    }
    return new Date(time);
  }
  return null;
}

/** The next few runs after `after`. */
export function upcomingRuns(when: When, timeZone: string, after: Date, anchor: Date = after, count = 3): Date[] {
  const runs: Date[] = [];
  let from = after;
  let previous: Date | null = null;
  while (runs.length < count) {
    const next = nextRun(when, timeZone, from, anchor, previous);
    if (!next) break;
    runs.push(next);
    previous = next;
    from = next;
  }
  return runs;
}

/** The shortest time between two runs, in minutes, looking a week or 30 runs ahead. */
export function shortestGapMinutes(when: When, timeZone: string, from: Date = new Date()): number {
  if (when.kind === "every") return when.ms / MINUTE;
  let shortest = Infinity;
  let previous: Date | null = null;
  let start: Date | null = null;
  let after = from;
  for (let index = 0; index < 30; index++) {
    const next = nextRun(when, timeZone, after, after, previous);
    if (!next) break;
    if (previous) shortest = Math.min(shortest, (next.getTime() - previous.getTime()) / MINUTE);
    start ??= next;
    if (next.getTime() - start.getTime() > 8 * 86_400_000) break;
    previous = next;
    after = next;
  }
  return shortest;
}

const pad = (number: number) => String(number).padStart(2, "0");
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const sorted = (values: Set<number>) => [...values].sort((a, b) => a - b);

/** When it runs, in words: "every weekday at 09:00", "every 6 hours". Falls back to the cron text. */
export function describeWhen(when: When, timeZone: string): string {
  if (when.kind === "every") {
    for (const [ms, word] of [[UNITS.w!, "week"], [UNITS.d!, "day"], [UNITS.h!, "hour"], [UNITS.m!, "minute"]] as const) {
      if (when.ms % ms === 0) {
        const count = when.ms / ms;
        return count === 1 ? `every ${word}` : `every ${count} ${word}s`;
      }
    }
  }
  if (when.kind !== "cron") return when.text;
  const { minute, hour, day, month, weekday } = when;
  const zone = timeZone === "UTC" ? "UTC" : timeZone;
  const everyDay = day.any && month.any && weekday.any;
  const step = /^\*\/(\d+)$/.exec(minute.source);
  if (everyDay && hour.any && step) return `every ${step[1]} minutes`;
  if (everyDay && hour.any && minute.values.size === 1) return `every hour at :${pad(sorted(minute.values)[0]!)}`;
  if (minute.values.size !== 1 || hour.values.size > 4 || hour.any) return `cron "${when.text}" (${zone})`;
  const times = list(sorted(hour.values).map((value) => `${pad(value)}:${pad(sorted(minute.values)[0]!)}`));
  let days: string;
  const weekdays = sorted(weekday.values);
  if (everyDay) days = "every day";
  else if (day.any && month.any && weekdays.join() === "1,2,3,4,5") days = "every weekday";
  else if (day.any && month.any && weekdays.join() === "0,6") days = "every weekend day";
  else if (day.any && month.any) days = `every ${list(weekdays.map((value) => DAY_NAMES[value]!))}`;
  else if (weekday.any && day.values.size <= 3) {
    const which = list(sorted(day.values).map((value) => `day ${value}`));
    days = month.any ? `on ${which} of every month` : `on ${which} of ${list(sorted(month.values).map((value) => MONTH_NAMES[value - 1]!))}`;
  } else return `cron "${when.text}" (${zone})`;
  return `${days} at ${times} ${zone}`;
}
