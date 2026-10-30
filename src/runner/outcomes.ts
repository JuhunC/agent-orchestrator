import { bus } from "../bus.ts";
import { config } from "../config.ts";
import {
  backfillPullOutcomes,
  createTask,
  getSetting,
  handoffsInto,
  markPullChecked,
  pullOutcomes,
  pullsToCheck,
  queuedTaskForThread,
  runningTasksForThread,
  setPullState,
  setSetting,
  spendByAgentSince,
  taskOutcomes,
  type PullOutcome,
} from "../db.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { scheduler } from "./scheduler.ts";
import { loadBoards } from "../boards/loader.ts";
import { findInstallation, installationClient } from "../github/app.ts";
import { errorMessage, log } from "../log.ts";

/**
 * What agents' work came to, beside what it cost: tasks that succeeded or failed, pull requests
 * merged or closed without merging, cards sent to a person (needs-human), and the cost per merged
 * pull request. Pull requests are followed from webhooks, and checked with GitHub hourly in case
 * one was missed.
 */

export interface AgentOutcome {
  agent: string;
  tasks: { succeeded: number; failed: number; cancelled: number };
  /** Share of finished tasks that succeeded (cancelled ones left out). */
  successRate: number | null;
  pulls: { opened: number; merged: number; closed: number; open: number };
  /** Share of decided pull requests (merged or closed) that were merged. */
  mergeRate: number | null;
  needsHuman: number;
  costUsd: number;
  costPerMergedPull: number | null;
  avgTaskMinutes: number | null;
}

export interface OutcomeReport {
  days: number;
  since: string;
  agents: AgentOutcome[];
  totals: Omit<AgentOutcome, "agent">;
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function outcomeReport(days: number, agent?: string): OutcomeReport {
  const span = Math.max(1, Math.min(366, Math.floor(days)));
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (span - 1));
  const since = start.toISOString();
  const rows = new Map<string, AgentOutcome>();
  const row = (name: string) => {
    if (!rows.has(name)) rows.set(name, { agent: name, tasks: { succeeded: 0, failed: 0, cancelled: 0 }, successRate: null, pulls: { opened: 0, merged: 0, closed: 0, open: 0 }, mergeRate: null, needsHuman: 0, costUsd: 0, costPerMergedPull: null, avgTaskMinutes: null });
    return rows.get(name)!;
  };
  const minutes = new Map<string, number>();
  for (const entry of taskOutcomes(since, agent)) {
    const target = row(entry.agent);
    target.tasks[entry.status as keyof AgentOutcome["tasks"]] += entry.count;
    minutes.set(entry.agent, (minutes.get(entry.agent) ?? 0) + entry.minutes);
  }
  for (const pull of pullOutcomes(since, agent)) {
    const target = row(pull.agent);
    target.pulls.opened++;
    target.pulls[pull.state]++;
  }
  const columns = [...new Set(loadBoards().boards.map((board) => board.needsHuman).filter((name): name is string => Boolean(name)))];
  for (const column of columns) for (const [name, count] of Object.entries(handoffsInto(column, since))) if (!agent || name === agent) row(name).needsHuman += count;
  for (const [name, cost] of Object.entries(spendByAgentSince(since))) if (!agent || name === agent) row(name).costUsd += cost;

  const finish = (target: Omit<AgentOutcome, "agent">, runMinutes: number) => {
    const finished = target.tasks.succeeded + target.tasks.failed;
    target.successRate = ratio(target.tasks.succeeded, finished);
    target.mergeRate = ratio(target.pulls.merged, target.pulls.merged + target.pulls.closed);
    target.costPerMergedPull = target.pulls.merged ? target.costUsd / target.pulls.merged : null;
    const all = finished + target.tasks.cancelled;
    target.avgTaskMinutes = all ? runMinutes / all : null;
  };
  for (const target of rows.values()) finish(target, minutes.get(target.agent) ?? 0);
  const totals: Omit<AgentOutcome, "agent"> = { tasks: { succeeded: 0, failed: 0, cancelled: 0 }, successRate: null, pulls: { opened: 0, merged: 0, closed: 0, open: 0 }, mergeRate: null, needsHuman: 0, costUsd: 0, costPerMergedPull: null, avgTaskMinutes: null };
  for (const target of rows.values()) {
    for (const key of ["succeeded", "failed", "cancelled"] as const) totals.tasks[key] += target.tasks[key];
    for (const key of ["opened", "merged", "closed", "open"] as const) totals.pulls[key] += target.pulls[key];
    totals.needsHuman += target.needsHuman;
    totals.costUsd += target.costUsd;
  }
  finish(totals, [...minutes.values()].reduce((sum, value) => sum + value, 0));
  return { days: span, since, agents: [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || a.agent.localeCompare(b.agent)), totals };
}

/** From a pull_request webhook: an agent's pull request was merged, closed or reopened. */
export function notePullEvent(payload: Record<string, any>): void {
  const pr = payload.pull_request;
  const [owner, repo] = String(payload.repository?.full_name ?? "").split("/");
  if (!pr || !owner || !repo) return;
  const action = String(payload.action ?? "");
  const state = action === "closed" ? (pr.merged ? "merged" : "closed") : action === "reopened" ? "open" : null;
  if (state && setPullState(owner, repo, Number(pr.number), state, pr.merged_at ?? pr.closed_at ?? undefined)) {
    bus.publish({ type: "settings" });
    scheduler.kick(); // work held back by MAX_OPEN_AGENT_PRS_PER_REPO may start now
  }
}

const NUDGE_EVERY_MS = 24 * 60 * 60_000;

/**
 * An agent's pull request conflicts with its base: start the agent that opened it to merge the
 * base in, once a day at most per pull request, unless it's already working on it.
 */
function nudgeConflicted(pull: PullOutcome, base: string, installationId: number): boolean {
  const profile = loadProfiles().agents.find((agent) => agent.name === pull.agent);
  if (!profile?.enabled || profile.errors.length || !profile.github.push) return false;
  const key = `conflict_nudged:${pull.owner}/${pull.repo}#${pull.number}`.toLowerCase();
  if (Date.now() - Number(getSetting(key) ?? 0) < NUDGE_EVERY_MS) return false;
  const ref = { owner: pull.owner, repo: pull.repo, kind: "pull" as const, number: pull.number };
  if (queuedTaskForThread(ref, profile.name) || runningTasksForThread(ref).some((task) => task.agent === profile.name)) return false;
  setSetting(key, String(Date.now()));
  const task = createTask({
    agent: profile.name,
    installationId,
    owner: pull.owner,
    repo: pull.repo,
    threadKind: "pull",
    threadNumber: pull.number,
    threadTitle: "",
    threadUrl: "",
    triggerKind: "maintenance",
    requestedBy: "orchestrator",
    requestText: `Your pull request #${pull.number} can't be merged: it conflicts with \`${base}\`. Merge the base into this branch (\`git merge origin/${base}\`), resolve the conflicts keeping what both sides meant, run the tests, and push with commit_and_push. Don't change anything else, and say in your reply what conflicted and how you resolved it.`,
    requestUrl: "",
  });
  bus.publish({ type: "task", task });
  log.info("Asked an agent to fix its conflicting pull request", { pull: `${pull.owner}/${pull.repo}#${pull.number}`, agent: profile.name, task: task.id });
  scheduler.kick();
  return true;
}

/** Checks open ones with GitHub, in case a webhook was missed, and nudges agents whose pull requests conflict. */
export async function checkOpenPulls(before = new Date(Date.now() - 60 * 60_000)): Promise<void> {
  let nudged = 0;
  for (const pull of pullsToCheck(before.toISOString())) {
    try {
      const installationId = await findInstallation(pull.owner, pull.repo);
      const gh = await installationClient(installationId);
      const { data } = await gh.rest.pulls.get({ owner: pull.owner, repo: pull.repo, pull_number: pull.number });
      if (data.state === "closed") setPullState(pull.owner, pull.repo, pull.number, data.merged ? "merged" : "closed", data.merged_at ?? data.closed_at ?? undefined);
      else {
        markPullChecked(pull.owner, pull.repo, pull.number);
        if (config.rebaseConflictedPulls && data.mergeable_state === "dirty" && nudged < 5 && nudgeConflicted(pull, data.base.ref, installationId)) nudged++;
      }
    } catch (error) {
      markPullChecked(pull.owner, pull.repo, pull.number);
      log.warn("Couldn't check a pull request's state", { pull: `${pull.owner}/${pull.repo}#${pull.number}`, error: errorMessage(error) });
    }
  }
}

export function startOutcomeChecks(): void {
  const added = backfillPullOutcomes();
  if (added) log.info("Following agents' earlier pull requests", { count: added });
  const tick = () => void checkOpenPulls().catch((error) => log.warn("Pull request check failed", { error: errorMessage(error) }));
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
