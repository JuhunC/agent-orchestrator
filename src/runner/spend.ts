import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { getSetting, setSetting, spendSince } from "../db.ts";
import { log } from "../log.ts";

/**
 * Spending limits for all agents together, per UTC day and month. When one is reached, queued
 * tasks wait until the next day (or month) or until the limit is raised; running tasks finish.
 * Costs are Claude Code's estimates, as on the Dashboard.
 */

export interface SpendLimits {
  dailyUsd: number | null;
  monthlyUsd: number | null;
}

export interface SpendStatus extends SpendLimits {
  today: number;
  month: number;
  /** Set while new tasks wait for a limit. */
  blocked: { period: "day" | "month"; spent: number; limit: number; until: string } | null;
  /** Set past 80% of a limit. */
  warning: string | null;
}

const WARN_AT = 0.8;

function limit(key: string, fallback: number): number | null {
  const stored = getSetting(key);
  const value = stored === null ? fallback : Number(stored);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function spendLimits(): SpendLimits {
  return { dailyUsd: limit("spend_limit_daily_usd", config.spendLimitDailyUsd), monthlyUsd: limit("spend_limit_monthly_usd", config.spendLimitMonthlyUsd) };
}

/** Changes a limit from the admin UI: a positive number, or null for no limit. */
export function setSpendLimits(patch: Partial<SpendLimits>): void {
  for (const [field, key] of [["dailyUsd", "spend_limit_daily_usd"], ["monthlyUsd", "spend_limit_monthly_usd"]] as const) {
    if (!(field in patch)) continue;
    const value = patch[field];
    setSetting(key, value && value > 0 ? String(value) : "0");
  }
  bus.publish({ type: "settings" });
}

function periods(now = new Date()): { dayStart: Date; dayEnd: Date; monthStart: Date; monthEnd: Date } {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    dayStart,
    dayEnd: new Date(dayStart.getTime() + 86_400_000),
    monthStart,
    monthEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

const money = (value: number) => `$${value.toFixed(2)}`;
let lastWarning = "";

export function spendStatus(now = new Date()): SpendStatus {
  const limits = spendLimits();
  const { dayStart, dayEnd, monthStart, monthEnd } = periods(now);
  const today = spendSince(dayStart.toISOString());
  const month = spendSince(monthStart.toISOString());
  let blocked: SpendStatus["blocked"] = null;
  if (limits.monthlyUsd !== null && month >= limits.monthlyUsd) blocked = { period: "month", spent: month, limit: limits.monthlyUsd, until: monthEnd.toISOString() };
  else if (limits.dailyUsd !== null && today >= limits.dailyUsd) blocked = { period: "day", spent: today, limit: limits.dailyUsd, until: dayEnd.toISOString() };
  const near = [
    limits.dailyUsd !== null && today >= limits.dailyUsd * WARN_AT && today < limits.dailyUsd ? `Agents have spent ${money(today)} of today's ${money(limits.dailyUsd)} limit.` : null,
    limits.monthlyUsd !== null && month >= limits.monthlyUsd * WARN_AT && month < limits.monthlyUsd ? `Agents have spent ${money(month)} of this month's ${money(limits.monthlyUsd)} limit.` : null,
  ].filter(Boolean);
  const warning = near.length ? near.join(" ") : null;
  const notice = blocked ? `blocked:${blocked.period}:${blocked.until}` : warning ? `warn:${dayStart.toISOString()}:${warning}` : "";
  if (notice && notice !== lastWarning) {
    lastWarning = notice;
    if (blocked) log.warn("Spending limit reached; new tasks wait", { period: blocked.period, spent: blocked.spent, limit: blocked.limit, until: blocked.until });
    else log.warn("Spending is near its limit", { warning });
  }
  return { ...limits, today, month, blocked, warning };
}

/** Why new tasks can't start now, for the queue and the task page. */
export function spendBlockReason(status = spendStatus()): string | null {
  if (!status.blocked) return null;
  const { period, spent, limit, until } = status.blocked;
  return `Agents have spent ${money(spent)} this ${period}, reaching the ${money(limit)} ${period === "day" ? "daily" : "monthly"} limit. New tasks wait until ${until.replace("T", " ").slice(0, 16)} UTC, or until the limit is raised in Settings.`;
}
