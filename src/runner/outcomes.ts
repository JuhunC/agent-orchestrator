import { bus } from "../bus.ts";
import { config } from "../config.ts";
import {
  backfillPullOutcomes,
  branchesToDelete,
  createTask,
  getSetting,
  handoffsInto,
  markBranchDeleted,
  outcomesByVersion,
  markPullChecked,
  openAgentPulls,
  pullOutcomes,
  pullsToCheck,
  queuedTaskForThread,
  runningTasksForThread,
  setPullBranch,
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
import { isIssueBranch } from "../github/relations.ts";
import { signed } from "../github/threads.ts";

/**
 * What agents' work came to, beside what it cost: tasks that did their work, did part of it, got
 * blocked, gave up or failed, pull requests merged or closed without merging, cards sent to a
 * person (needs-human), and the cost per merged pull request. Pull requests are followed from
 * webhooks, and checked with GitHub hourly in case one was missed.
 */

/** Of the tasks that ended without an error: those whose agent said it didn't do all of it (report_outcome). */
export interface ReportedOutcomes {
  partial: number;
  blocked: number;
  gaveUp: number;
}

export interface AgentOutcome {
  agent: string;
  tasks: { succeeded: number; failed: number; cancelled: number };
  reported: ReportedOutcomes;
  /** Share of finished tasks whose work was done: succeeded, and not reported as partial, blocked or given up (cancelled ones left out). */
  successRate: number | null;
  pulls: { opened: number; merged: number; closed: number; open: number };
  /** Share of decided pull requests (merged or closed) that were merged. */
  mergeRate: number | null;
  needsHuman: number;
  costUsd: number;
  costPerMergedPull: number | null;
  avgTaskMinutes: number | null;
}

export interface VersionOutcome {
  version: string;
  commit: string | null;
  firstUsed: string;
  lastUsed: string;
  tasks: { succeeded: number; failed: number; cancelled: number };
  reported: ReportedOutcomes;
  successRate: number | null;
  pulls: { merged: number; closed: number; open: number };
  mergeRate: number | null;
  costUsd: number;
  costPerMergedPull: number | null;
}

export interface OutcomeReport {
  days: number;
  since: string;
  agents: AgentOutcome[];
  totals: Omit<AgentOutcome, "agent">;
  /** For one agent: the same numbers per version of its profile, newest first. */
  versions?: VersionOutcome[];
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const REPORTED_KEY: Record<string, keyof ReportedOutcomes> = { partial: "partial", blocked: "blocked", gave_up: "gaveUp" };
const notDone = (reported: ReportedOutcomes) => reported.partial + reported.blocked + reported.gaveUp;

export function outcomeReport(days: number, agent?: string): OutcomeReport {
  const span = Math.max(1, Math.min(366, Math.floor(days)));
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (span - 1));
  const since = start.toISOString();
  const rows = new Map<string, AgentOutcome>();
  const row = (name: string) => {
    if (!rows.has(name)) rows.set(name, { agent: name, tasks: { succeeded: 0, failed: 0, cancelled: 0 }, reported: { partial: 0, blocked: 0, gaveUp: 0 }, successRate: null, pulls: { opened: 0, merged: 0, closed: 0, open: 0 }, mergeRate: null, needsHuman: 0, costUsd: 0, costPerMergedPull: null, avgTaskMinutes: null });
    return rows.get(name)!;
  };
  const minutes = new Map<string, number>();
  for (const entry of taskOutcomes(since, agent)) {
    const target = row(entry.agent);
    target.tasks[entry.status as keyof AgentOutcome["tasks"]] += entry.count;
    if (REPORTED_KEY[entry.outcome]) target.reported[REPORTED_KEY[entry.outcome]!] += entry.count;
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
    target.successRate = ratio(target.tasks.succeeded - notDone(target.reported), finished);
    target.mergeRate = ratio(target.pulls.merged, target.pulls.merged + target.pulls.closed);
    target.costPerMergedPull = target.pulls.merged ? target.costUsd / target.pulls.merged : null;
    const all = finished + target.tasks.cancelled;
    target.avgTaskMinutes = all ? runMinutes / all : null;
  };
  for (const target of rows.values()) finish(target, minutes.get(target.agent) ?? 0);
  const totals: Omit<AgentOutcome, "agent"> = { tasks: { succeeded: 0, failed: 0, cancelled: 0 }, reported: { partial: 0, blocked: 0, gaveUp: 0 }, successRate: null, pulls: { opened: 0, merged: 0, closed: 0, open: 0 }, mergeRate: null, needsHuman: 0, costUsd: 0, costPerMergedPull: null, avgTaskMinutes: null };
  for (const target of rows.values()) {
    for (const key of ["succeeded", "failed", "cancelled"] as const) totals.tasks[key] += target.tasks[key];
    for (const key of ["partial", "blocked", "gaveUp"] as const) totals.reported[key] += target.reported[key];
    for (const key of ["opened", "merged", "closed", "open"] as const) totals.pulls[key] += target.pulls[key];
    totals.needsHuman += target.needsHuman;
    totals.costUsd += target.costUsd;
  }
  finish(totals, [...minutes.values()].reduce((sum, value) => sum + value, 0));
  const versions = agent
    ? outcomesByVersion(agent, since).map((entry) => {
        const tasks = { succeeded: entry.tasks.succeeded ?? 0, failed: entry.tasks.failed ?? 0, cancelled: entry.tasks.cancelled ?? 0 };
        const reported = { partial: entry.reported.partial ?? 0, blocked: entry.reported.blocked ?? 0, gaveUp: entry.reported.gave_up ?? 0 };
        const pulls = { merged: entry.pulls.merged ?? 0, closed: entry.pulls.closed ?? 0, open: entry.pulls.open ?? 0 };
        return {
          version: entry.version,
          commit: entry.commit,
          firstUsed: entry.firstUsed,
          lastUsed: entry.lastUsed,
          tasks,
          reported,
          successRate: ratio(tasks.succeeded - notDone(reported), tasks.succeeded + tasks.failed),
          pulls,
          mergeRate: ratio(pulls.merged, pulls.merged + pulls.closed),
          costUsd: entry.costUsd,
          costPerMergedPull: pulls.merged ? entry.costUsd / pulls.merged : null,
        };
      })
    : undefined;
  return { days: span, since, agents: [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || a.agent.localeCompare(b.agent)), totals, ...(versions ? { versions } : {}) };
}

/** From a pull_request webhook: an agent's pull request was merged, closed or reopened. */
export function notePullEvent(payload: Record<string, any>): void {
  const pr = payload.pull_request;
  const [owner, repo] = String(payload.repository?.full_name ?? "").split("/");
  if (!pr || !owner || !repo) return;
  const action = String(payload.action ?? "");
  const state = action === "closed" ? (pr.merged ? "merged" : "closed") : action === "reopened" ? "open" : null;
  if (pr.head?.ref) setPullBranch(owner, repo, Number(pr.number), String(pr.head.ref));
  // Anyone's merge can leave agents' pull requests into the same branch in conflict.
  if (action === "closed" && pr.merged && pr.base?.ref) scheduleConflictCheck(owner, repo, String(pr.base.ref), Number(payload.installation?.id) || undefined);
  if (state && setPullState(owner, repo, Number(pr.number), state, pr.merged_at ?? pr.closed_at ?? undefined)) {
    bus.publish({ type: "settings" });
    scheduler.kick(); // work held back by MAX_OPEN_AGENT_PRS_PER_REPO may start now
    if (state === "merged") {
      void closeIssuesAfterMerge(payload, owner, repo).catch((error) => log.warn("Couldn't close the issue of a merged pull request", { pull: `${owner}/${repo}#${pr.number}`, error: errorMessage(error) }));
    }
  }
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/**
 * GitHub closes the issues a pull request says it closes ("Closes #12") only when it merges into
 * the default branch. An agent's pull request into another base branch (base_branch) closes them
 * here instead. Pull requests into a parent issue's branch don't: the parent's work isn't done.
 */
async function closeIssuesAfterMerge(payload: Record<string, any>, owner: string, repo: string): Promise<void> {
  const pr = payload.pull_request;
  const base = String(pr.base?.ref ?? "");
  const defaultBranch = String(payload.repository?.default_branch ?? "");
  if (!base || !defaultBranch || base === defaultBranch || isIssueBranch(base)) return;
  const numbers = [...new Set([...String(pr.body ?? "").matchAll(CLOSING)].map((match) => Number(match[1])))];
  if (!numbers.length) return;
  const gh = await installationClient(Number(payload.installation?.id) || (await findInstallation(owner, repo)));
  for (const number of numbers) {
    const { data: issue } = await gh.rest.issues.get({ owner, repo, issue_number: number });
    if (issue.state !== "open" || issue.pull_request) continue;
    await gh.rest.issues.createComment({ owner, repo, issue_number: number, body: signed(`Closing: pull request #${pr.number} was merged into \`${base}\`. (GitHub only closes issues for pull requests into \`${defaultBranch}\`.)`) });
    await gh.rest.issues.update({ owner, repo, issue_number: number, state: "closed", state_reason: "completed" });
    log.info("Closed the issue of a merged pull request", { issue: `${owner}/${repo}#${number}`, pull: Number(pr.number), base });
  }
}

const NUDGE_EVERY_MS = 24 * 60 * 60_000;
/** A pull request whose branch changed since its last nudge has a new conflict: it may be nudged again this soon, */
const NUDGE_AGAIN_MS = 30 * 60_000;
/** but no more than this often in a day. */
const MAX_NUDGES_PER_DAY = 4;

/** When a pull request's agent was last asked to fix a conflict, and what its branch was at then. */
interface Nudged {
  at: number;
  sha: string | null;
  /** The first nudge of the day this one belongs to, and how many there have been since. */
  first: number;
  count: number;
}

function lastNudge(key: string): Nudged {
  const raw = getSetting(key);
  // Before conflicts were checked after merges, only the time was kept.
  if (raw && /^\d+$/.test(raw)) return { at: Number(raw), sha: null, first: Number(raw), count: 1 };
  try {
    if (raw) return JSON.parse(raw) as Nudged;
  } catch {
    // unreadable: as if never nudged
  }
  return { at: 0, sha: null, first: 0, count: 0 };
}

/**
 * An agent's pull request conflicts with its base: start the agent that opened it to merge the
 * base in, unless it's already working on it. Once a day per pull request; sooner only when its
 * branch has changed since (the last conflict was dealt with, so this is a new one), and then at
 * most MAX_NUDGES_PER_DAY times, half an hour apart.
 */
function nudgeConflicted(pull: PullOutcome, base: string, installationId: number, headSha: string | null = null): boolean {
  const profile = loadProfiles().agents.find((agent) => agent.name === pull.agent);
  if (!profile?.enabled || profile.errors.length || !profile.github.push) return false;
  const key = `conflict_nudged:${pull.owner}/${pull.repo}#${pull.number}`.toLowerCase();
  const now = Date.now();
  const last = lastNudge(key);
  const sameDay = now - last.first < NUDGE_EVERY_MS;
  if (now - last.at < NUDGE_EVERY_MS) {
    const changed = Boolean(headSha && last.sha && headSha !== last.sha);
    if (!changed || now - last.at < NUDGE_AGAIN_MS || (sameDay && last.count >= MAX_NUDGES_PER_DAY)) return false;
  }
  const ref = { owner: pull.owner, repo: pull.repo, kind: "pull" as const, number: pull.number };
  if (queuedTaskForThread(ref, profile.name) || runningTasksForThread(ref).some((task) => task.agent === profile.name)) return false;
  setSetting(key, JSON.stringify({ at: now, sha: headSha, first: sameDay ? last.first : now, count: sameDay ? last.count + 1 : 1 } satisfies Nudged));
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
        if (config.rebaseConflictedPulls && data.mergeable_state === "dirty" && nudged < 5 && nudgeConflicted(pull, data.base.ref, installationId, data.head.sha)) nudged++;
      }
    } catch (error) {
      markPullChecked(pull.owner, pull.repo, pull.number);
      log.warn("Couldn't check a pull request's state", { pull: `${pull.owner}/${pull.repo}#${pull.number}`, error: errorMessage(error) });
    }
  }
}

const conflictChecks = new Map<string, NodeJS.Timeout>();

/**
 * A pull request was merged into `base`: agents' open pull requests into that branch may conflict
 * with it now. Looks CONFLICT_CHECK_SECONDS later (GitHub needs a moment to work out what still
 * merges), once per branch however many merges land meanwhile, instead of at the next hourly check.
 */
function scheduleConflictCheck(owner: string, repo: string, base: string, installationId?: number): void {
  if (!config.rebaseConflictedPulls || !config.conflictCheckSeconds) return;
  const key = `${owner}/${repo}@${base}`.toLowerCase();
  if (conflictChecks.has(key)) return;
  const timer = setTimeout(() => {
    conflictChecks.delete(key);
    void checkConflictsInto(owner, repo, base, installationId).catch((error) => log.warn("Conflict check after a merge failed", { branch: key, error: errorMessage(error) }));
  }, config.conflictCheckSeconds * 1000);
  timer.unref();
  conflictChecks.set(key, timer);
}

/**
 * Agents' open pull requests into `base`: starts the agent of each one that conflicts with it
 * (see nudgeConflicted). Returns how many it started.
 */
export async function checkConflictsInto(owner: string, repo: string, base: string, installationId?: number, askAgainMs = 5000): Promise<number> {
  const pulls = openAgentPulls(owner, repo);
  if (!pulls.length) return 0;
  const installation = installationId ?? (await findInstallation(owner, repo));
  const gh = await installationClient(installation);
  let nudged = 0;
  for (const pull of pulls) {
    if (nudged >= 5) break;
    try {
      let { data } = await gh.rest.pulls.get({ owner: pull.owner, repo: pull.repo, pull_number: pull.number });
      if (data.state === "closed") {
        setPullState(pull.owner, pull.repo, pull.number, data.merged ? "merged" : "closed", data.merged_at ?? data.closed_at ?? undefined);
        continue;
      }
      if (data.base.ref !== base) continue;
      // GitHub works this out in the background after a merge: when it hasn't yet, ask once more.
      if (data.mergeable_state === "unknown" && askAgainMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, askAgainMs));
        ({ data } = await gh.rest.pulls.get({ owner: pull.owner, repo: pull.repo, pull_number: pull.number }));
      }
      if (data.mergeable_state === "dirty" && nudgeConflicted(pull, base, installation, data.head.sha)) nudged++;
    } catch (error) {
      log.warn("Couldn't check a pull request for conflicts", { pull: `${pull.owner}/${pull.repo}#${pull.number}`, error: errorMessage(error) });
    }
  }
  if (nudged) log.info("Pull requests conflict after a merge: asked their agents to merge the base in", { branch: `${owner}/${repo}@${base}`, count: nudged });
  return nudged;
}

const AGENT_BRANCH = /^(agent\/[^/]+\/(issue|pull|discussion)-\d+|ao\/(issue|discussion)-\d+)$/;

/**
 * Deletes agents' branches on GitHub a while after their pull requests were merged or closed, so
 * repositories (and every clone of them) don't collect thousands. Only agent branches, and not
 * while an open pull request still targets the branch (a parent issue's branch with open sub-issues).
 */
export async function deleteFinishedBranches(now = Date.now(), days = config.agentBranchCleanupDays): Promise<number> {
  if (days <= 0) return 0;
  let deleted = 0;
  for (const pull of branchesToDelete(new Date(now - days * 86_400_000).toISOString())) {
    if (!AGENT_BRANCH.test(pull.branch)) {
      markBranchDeleted(pull.owner, pull.repo, pull.number); // not ours to delete: stop looking at it
      continue;
    }
    try {
      const gh = await installationClient(await findInstallation(pull.owner, pull.repo));
      const { data: targeting } = await gh.rest.pulls.list({ owner: pull.owner, repo: pull.repo, base: pull.branch, state: "open", per_page: 1 });
      if (targeting.length) continue; // still the base of open work; try again later
      const { data: fromIt } = await gh.rest.pulls.list({ owner: pull.owner, repo: pull.repo, head: `${pull.owner}:${pull.branch}`, state: "open", per_page: 1 });
      if (fromIt.length) continue; // reopened, or a new pull request from the same branch
      await gh.rest.git.deleteRef({ owner: pull.owner, repo: pull.repo, ref: `heads/${pull.branch}` }).catch((error) => {
        if (![404, 422].includes(Number((error as { status?: number }).status))) throw error; // already gone
      });
      markBranchDeleted(pull.owner, pull.repo, pull.number);
      deleted++;
    } catch (error) {
      log.warn("Couldn't delete an agent's branch", { branch: `${pull.owner}/${pull.repo}@${pull.branch}`, error: errorMessage(error) });
    }
  }
  if (deleted) log.info("Deleted agents' branches of merged and closed pull requests", { deleted });
  return deleted;
}

export function startOutcomeChecks(): void {
  const added = backfillPullOutcomes();
  if (added) log.info("Following agents' earlier pull requests", { count: added });
  const tick = () =>
    void checkOpenPulls()
      .then(() => deleteFinishedBranches())
      .catch((error) => log.warn("Pull request check failed", { error: errorMessage(error) }));
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
