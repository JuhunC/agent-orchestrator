import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { addIncident, deliveryCounts, incidentCounts, listIncidents, pullStateCounts, taskTotals, tokenTotals, type IncidentRow } from "../db.ts";
import { onGithubThrottled } from "../github/app.ts";
import { errorMessage, log } from "../log.ts";

/**
 * Problems an administrator should hear about: failed tasks, loop guards that stopped agents,
 * spending and usage limits, agents that aren't isolated, rejected webhooks. They're kept in the
 * database (the last 1000) for the Dashboard, and posted to ALERT_WEBHOOK_URL when it's set.
 */

export type IncidentKind =
  | "task_failed"
  | "loop_guard"
  | "spend_limit"
  | "spend_warning"
  | "usage_limit"
  | "isolation"
  | "webhook_signature"
  | "account_token"
  | "backup"
  | "github_rate_limit";

const RANK = { info: 0, warning: 1, critical: 2 } as const;
/** The same problem isn't posted again within this long. */
const QUIET_MS = 10 * 60_000;
const lastPosted = new Map<string, number>();

export function recordIncident(kind: IncidentKind, severity: IncidentRow["severity"], message: string, extra: { taskId?: number | null; url?: string | null } = {}): IncidentRow {
  const incident = addIncident({ kind, severity, message, taskId: extra.taskId ?? null, url: extra.url ?? null });
  bus.publish({ type: "incidents" });
  if (config.alertWebhookUrl && RANK[severity] >= RANK[config.alertMinSeverity]) {
    const key = `${kind}:${message}`;
    const now = Date.now();
    if (now - (lastPosted.get(key) ?? 0) >= QUIET_MS) {
      lastPosted.set(key, now);
      void post(incident);
    }
  }
  return incident;
}

async function post(incident: IncidentRow): Promise<void> {
  const icon = incident.severity === "critical" ? "🔴" : incident.severity === "warning" ? "🟠" : "🔵";
  const link = incident.url ? ` ${incident.url}` : incident.taskId ? ` ${config.publicUrl}/#/tasks/${incident.taskId}` : "";
  const text = `${icon} Agent Orchestrator: ${incident.message}${link}`;
  try {
    // `text` for Slack (and most chat tools), `content` for Discord, the rest for anything else.
    const response = await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text, kind: incident.kind, severity: incident.severity, message: incident.message, url: incident.url, task: incident.taskId, at: incident.ts }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) log.warn("The alert webhook refused an alert", { status: response.status });
  } catch (error) {
    log.warn("Couldn't post an alert", { error: errorMessage(error) });
  }
}

export { listIncidents };

// GitHub rate-limiting the orchestrator: one incident per 10 minutes, not one per request.
let lastThrottleIncident = 0;
onGithubThrottled((what) => {
  if (Date.now() - lastThrottleIncident < QUIET_MS) return;
  lastThrottleIncident = Date.now();
  recordIncident("github_rate_limit", "warning", `GitHub is rate-limiting the orchestrator (${what}). Progress comments pause; other requests wait and retry. If it keeps happening, lower PROGRESS_EDITS_PER_HOUR or MAX_CONCURRENT_TASKS, or set PROGRESS_COMMENTS=minimal.`);
});

// ---------- Prometheus metrics ----------

const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (pairs: Record<string, string>) => `{${Object.entries(pairs).map(([key, value]) => `${key}="${escape(value)}"`).join(",")}}`;

/** /metrics in the Prometheus text format. */
export function renderMetrics(live: { running: number; queued: number; paused: boolean; sessions: number; limited: boolean; spendToday: number; spendMonth: number; isolated: boolean }): string {
  const lines: string[] = [];
  const metric = (name: string, type: "counter" | "gauge", help: string, samples: [Record<string, string>, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [pairs, value] of samples) lines.push(`${name}${Object.keys(pairs).length ? labels(pairs) : ""} ${Number.isFinite(value) ? value : 0}`);
  };
  const tasks = taskTotals();
  metric("ao_tasks_total", "counter", "Tasks by agent and status.", tasks.map((row) => [{ agent: row.agent, status: row.status }, row.count]));
  metric("ao_cost_usd_total", "counter", "Estimated spend by agent (Claude Code's estimates).", Object.entries(tasks.reduce<Record<string, number>>((sum, row) => ({ ...sum, [row.agent]: (sum[row.agent] ?? 0) + row.costUsd }), {})).map(([agent, cost]) => [{ agent }, cost]));
  metric(
    "ao_tokens_total",
    "counter",
    "Tokens by agent and type.",
    tokenTotals().flatMap((row) => [
      [{ agent: row.agent, type: "input" }, row.input],
      [{ agent: row.agent, type: "output" }, row.output],
      [{ agent: row.agent, type: "cache_read" }, row.cacheRead],
      [{ agent: row.agent, type: "cache_write" }, row.cacheWrite],
    ] as [Record<string, string>, number][]),
  );
  metric("ao_pull_requests_total", "counter", "Pull requests agents opened, by agent and state (open, merged, closed).", pullStateCounts().map((row) => [{ agent: row.agent, state: row.state }, row.count]));
  metric("ao_tasks_running", "gauge", "Tasks running now.", [[{}, live.running]]);
  metric("ao_tasks_queued", "gauge", "Tasks waiting to start.", [[{}, live.queued]]);
  metric("ao_queue_paused", "gauge", "1 when the queue is paused.", [[{}, live.paused ? 1 : 0]]);
  metric("ao_usage_limited", "gauge", "1 while the model service's usage limit holds tasks.", [[{}, live.limited ? 1 : 0]]);
  metric("ao_live_sessions", "gauge", "Open agent sessions.", [[{}, live.sessions]]);
  metric("ao_spend_today_usd", "gauge", "Estimated spend today (UTC).", [[{}, live.spendToday]]);
  metric("ao_spend_month_usd", "gauge", "Estimated spend this month (UTC).", [[{}, live.spendMonth]]);
  metric("ao_agents_isolated", "gauge", "1 when agents run as a separate user.", [[{}, live.isolated ? 1 : 0]]);
  metric("ao_incidents_total", "counter", "Problems recorded, by kind (the last 1000 are kept).", Object.entries(incidentCounts()).map(([kind, count]) => [{ kind }, count]));
  metric("ao_webhook_deliveries_total", "counter", "Webhook deliveries by decision (the last 2000 are kept).", Object.entries(deliveryCounts()).map(([decision, count]) => [{ decision }, count]));
  return `${lines.join("\n")}\n`;
}
