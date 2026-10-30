import { bus } from "../bus.ts";
import { getSetting, setSetting } from "../db.ts";
import { recordIncident } from "./incidents.ts";

/**
 * Usage limits of the model service. Every agent shares one account (your ANTHROPIC_* settings),
 * so when one agent hits the limit, all of them wait for it to reset.
 */
export interface UsageLimit {
  until: string;
  reason: string;
}

const KEY = "usage_limit";

export function getLimit(): UsageLimit | null {
  const limit = JSON.parse(getSetting(KEY) ?? "{}") as Partial<UsageLimit>;
  if (!limit.until || Date.parse(limit.until) <= Date.now()) return null;
  return { until: limit.until, reason: limit.reason ?? "" };
}

export function setLimit(until: Date, reason: string): void {
  setSetting(KEY, JSON.stringify({ until: until.toISOString(), reason: reason.slice(0, 300) }));
  recordIncident("usage_limit", "warning", `The model service's usage limit was reached (${reason.slice(0, 200)}). Tasks continue at ${until.toISOString().replace("T", " ").slice(0, 16)} UTC.`);
  bus.publish({ type: "limits" });
}

export function clearLimit(): void {
  setSetting(KEY, "{}");
  bus.publish({ type: "limits" });
}
