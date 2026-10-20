/**
 * Recognises "you've hit your usage limit" errors from the agent CLIs (subscription plans have
 * rolling limits) and works out when the limit resets, so the task can wait instead of failing.
 */

export interface DetectedLimit {
  resetAt: Date | null;
  message: string;
}

const LIMIT_PHRASES = [
  /usage limit/i,
  /hit (?:your|the) (?:\w+[ -])?limit/i,
  /(?:session|weekly|5-hour|daily|monthly|opus|plan) limit/i,
  /limit (?:reached|exceeded)/i,
  /out of (?:extra )?usage/i,
  /rate[ _-]?limit(?:ed|_error| exceeded| reached)/i,
  /quota (?:exceeded|exhausted)|exceeded your current quota|RESOURCE_EXHAUSTED/i,
  /too many requests/i,
  /usage_limit_reached|usageLimitExceeded|rateLimitExceeded/,
];

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

function durationMs(text: string): number | null {
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi)) {
    const unit = match[2]!.toLowerCase()[0]!;
    total += Number(match[1]) * (UNIT_MS[unit] ?? 0);
    matched = true;
  }
  return matched ? total : null;
}

/** Offset of `timeZone` from UTC at `date`, in ms (wall clock minus UTC). */
function zoneOffset(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validZone(timeZone: string | undefined): string {
  const zone = timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

function wallClockToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const guess = Date.UTC(year, month, day, hour, minute);
  return new Date(guess - zoneOffset(new Date(guess), zone));
}

/** The next moment the clock in `timeZone` shows hour:minute. */
export function nextWallClock(hour: number, minute: number, timeZone: string | undefined, now: Date): Date {
  const zone = validZone(timeZone);
  const offset = zoneOffset(now, zone);
  const wallNow = new Date(now.getTime() + offset);
  let candidate = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate(), hour, minute) - offset;
  if (candidate <= now.getTime()) candidate += 86_400_000;
  return new Date(candidate);
}

function resetTime(text: string, now: Date): Date | null {
  const epoch = text.match(/(?:limit reached|resets?_?at"?\s*[:=]?)\s*\|?\s*"?(\d{10}|\d{13})\b/i) ?? text.match(/\|(\d{10}|\d{13})\b/);
  if (epoch) {
    const value = Number(epoch[1]);
    return new Date(epoch[1]!.length === 13 ? value : value * 1000);
  }
  const seconds = text.match(/resets?_in_seconds"?\s*[:=]\s*(\d+)/i);
  if (seconds) return new Date(now.getTime() + Number(seconds[1]) * 1000);
  const iso = text.match(/resets?\s+(?:at\s+|on\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (iso && !Number.isNaN(Date.parse(iso[1]!))) return new Date(iso[1]!);
  const relative = text.match(/(?:try again|retry|resets?|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i);
  if (relative) {
    const ms = durationMs(relative[1]!);
    if (ms !== null) return new Date(now.getTime() + ms);
  }
  const day = text.match(/resets?\s+(?:on\s+)?([A-Z][a-z]{2,8})\.?\s+(\d{1,2})(?:,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?(?:\s*\(([^)]+)\))?/);
  const month = day ? MONTHS.indexOf(day[1]!.slice(0, 3).toLowerCase()) : -1;
  if (day && month >= 0) {
    let hour = Number(day[3] ?? 0);
    if (day[5]) hour = (hour % 12) + (day[5].toLowerCase() === "pm" ? 12 : 0);
    const zone = validZone(day[6]);
    let year = now.getUTCFullYear();
    let at = wallClockToUtc(year, month, Number(day[2]), hour, Number(day[4] ?? 0), zone);
    if (at.getTime() < now.getTime() - 86_400_000) at = wallClockToUtc(++year, month, Number(day[2]), hour, Number(day[4] ?? 0), zone);
    return at;
  }
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([^)]+)\))?/i);
  if (clock && (clock[2] || clock[3])) {
    let hour = Number(clock[1]) % 12;
    if (!clock[3]) hour = Number(clock[1]);
    else if (clock[3].toLowerCase() === "pm") hour += 12;
    if (hour < 24) return nextWallClock(hour, Number(clock[2] ?? 0), clock[4], now);
  }
  return null;
}

/** Looks for a usage-limit error in an agent's output. Only call this for runs that failed. */
export function detectUsageLimit(text: string, now = new Date()): DetectedLimit | null {
  const lines = text.split("\n").filter((line) => LIMIT_PHRASES.some((phrase) => phrase.test(line)));
  if (!lines.length) return null;
  const message = lines[0]!.trim().slice(0, 300);
  return { resetAt: resetTime(lines.join("\n"), now) ?? resetTime(text, now), message };
}

/** When to try again: the reset time if known (plus a minute of slack), otherwise in 30 minutes. */
export function retryTime(limit: DetectedLimit, now = new Date()): Date {
  const min = now.getTime() + 60_000;
  const max = now.getTime() + 8 * 86_400_000;
  const target = limit.resetAt ? limit.resetAt.getTime() + 60_000 : now.getTime() + 30 * 60_000;
  return new Date(Math.min(max, Math.max(min, target)));
}
