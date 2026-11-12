import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { addEvent, getSetting, getTask, lastStarts, linkedThreads, openAgentPullCount, queuedTasks, setSetting, tasksWithStatus, threadHasOpenAgentPull, updateTask } from "../db.ts";
import { recordIncident } from "./incidents.ts";
import { errorMessage, log } from "../log.ts";
import type { Task } from "../types.ts";
import { loadProfiles } from "../profiles/loader.ts";
import type { Profile } from "../profiles/types.ts";
import { sessions } from "../runtime/manager.ts";
import { workspaceDir } from "../runtime/workspace.ts";
import { clearLimit, getLimit } from "./limit-store.ts";
import { spendStatus } from "./spend.ts";
import { queueOrder } from "./queue-order.ts";
import { fallbackModels } from "../runtime/options.ts";
import { loadBoards } from "../boards/loader.ts";
import { boardTaskSettled } from "../boards/engine.ts";
import { notePausedCancelled, recoverInterrupted } from "./run-task.ts";
import { executor } from "./executor.ts";
import { settleInbox } from "./inbox.ts";

/** The queue in the order it will start now: what's running and who had a turn last count (queue-order.ts). */
export function startOrder(queued: Task[], running: Task[], now = Date.now()): Task[] {
  const served = config.queueFairness && queued.length > 1 ? lastStarts(new Date(now - 24 * 3_600_000).toISOString()) : [];
  return queueOrder(queued, now, running, served);
}

/**
 * What a task's agent changes when it pushes: its thread, and the threads linked to it (an issue's
 * pull request works on the same branch, and so does a pull request's issue).
 */
function workKeys(task: Task): string[] {
  const ref = { owner: task.owner, repo: task.repo, kind: task.threadKind, number: task.threadNumber };
  return [ref, ...linkedThreads(ref)].map((thread) => `${task.owner}/${task.repo} ${thread.kind}#${thread.number}`.toLowerCase());
}

/** While the host is short of memory or busy, the queue looks again this often. */
const HOST_RECHECK_MS = 15_000;
/** The host being under pressure is recorded as a problem at most this often. */
const HOST_INCIDENT_MS = 3_600_000;

/** Does this task change a branch? Its agent pushes, and it isn't a dry run. An agent that's gone counts, to be safe. */
const writes = (task: Task, profile: Profile | undefined) => !task.dryRun && (profile?.github.push ?? true);

/**
 * Runs queued tasks, up to the concurrency limit. Two tasks that share a workspace (same agent
 * on the same thread) never run at the same time, and neither do two agents that push on the
 * same thread (ONE_WRITER_PER_THREAD). Where a task runs is the executor's business
 * (executor.ts): it also says when the host has no room for one more.
 */
class Scheduler {
  private running = new Map<number, { controller: AbortController; workspace: string }>();
  private draining: Promise<void>[] = [];
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Set while shutting down: nothing new starts. */
  stopping = false;
  /** After the model service rate-limits a task, fewer tasks run for a while (see noteRateLimit). */
  private rateCap: number | null = null;
  private rateCapAt = 0;

  /**
   * The model service rate-limited a task: halve how many tasks run at once (at least one), then
   * allow one more every two minutes until it's back to the setting.
   */
  noteRateLimit(): void {
    this.rateCap = Math.max(1, Math.floor(this.effectiveConcurrent() / 2));
    this.rateCapAt = Date.now();
    log.warn("The model service is rate limiting; running fewer agents for a while", { atOnce: this.rateCap });
    bus.publish({ type: "settings" });
  }

  /**
   * Would this task open yet another pull request in a repository that already has
   * MAX_OPEN_AGENT_PRS_PER_REPO open ones from agents? Then it waits until some are merged or
   * closed. Only board stages and work agents started: people's own requests always run.
   */
  private overPullLimit(task: Task, profile: { github: { pullRequest: boolean; push: boolean } }, counts: Map<string, number>): boolean {
    const limit = config.maxOpenAgentPullsPerRepo;
    if (!limit || task.dryRun || task.threadKind !== "issue" || !["board", "agent"].includes(task.triggerKind)) return false;
    if (!profile.github.pullRequest || !profile.github.push) return false;
    const key = `${task.owner}/${task.repo}`.toLowerCase();
    if (!counts.has(key)) counts.set(key, openAgentPullCount(task.owner, task.repo));
    if (counts.get(key)! < limit) return false;
    if (threadHasOpenAgentPull({ owner: task.owner, repo: task.repo, kind: task.threadKind, number: task.threadNumber })) return false;
    const now = Date.now();
    if (now - (this.pullLimitNoted.get(key) ?? 0) > 60 * 60_000) {
      this.pullLimitNoted.set(key, now);
      recordIncident("loop_guard", "info", `${key} has ${counts.get(key)} open agent pull requests (MAX_OPEN_AGENT_PRS_PER_REPO is ${limit}), so board and agent-started work that would open another waits until some are merged or closed.`);
    }
    return true;
  }
  private pullLimitNoted = new Map<string, number>();

  /** ONE_WRITER_PER_THREAD: the threads being changed now, with the running task changing each. */
  private writing(profiles: Profile[], running: Task[]): Map<string, Task> {
    const held = new Map<string, Task>();
    if (!config.oneWriterPerThread) return held;
    for (const task of running) {
      if (!writes(task, profiles.find((profile) => profile.name === task.agent))) continue;
      for (const key of workKeys(task)) if (!held.has(key)) held.set(key, task);
    }
    return held;
  }

  /**
   * For each of these queued tasks that has to wait for it: the running task whose agent is
   * changing the same thread (or its pull request). Agents that don't push run alongside.
   */
  writersAhead(queued: Task[]): Map<number, Task> {
    const ahead = new Map<number, Task>();
    if (!config.oneWriterPerThread || !queued.length || !this.running.size) return ahead;
    const profiles = loadProfiles().agents;
    const held = this.writing(profiles, this.runningIds().map((id) => getTask(id)).filter((task): task is Task => Boolean(task)));
    if (!held.size) return ahead;
    for (const task of queued) {
      if (!writes(task, profiles.find((profile) => profile.name === task.agent))) continue;
      const other = workKeys(task).map((key) => held.get(key)).find((holder) => holder && holder.id !== task.id);
      if (other) ahead.set(task.id, other);
    }
    return ahead;
  }

  /** Says once in a waiting task's log whose turn it is on the thread. */
  private noteWriterAhead(task: Task, other: Task): void {
    if (this.writerNoted.get(task.id) === other.id) return;
    this.writerNoted.set(task.id, other.id);
    bus.publish({ type: "event", event: addEvent(task.id, "system", `Waiting for ${other.agent} (task #${other.id}) to finish on ${other.threadKind === task.threadKind && other.threadNumber === task.threadNumber ? "this thread" : `${other.threadKind === "pull" ? "pull request" : other.threadKind} #${other.threadNumber}`}: agents that push take turns, so two never change the same branch at once`) });
  }
  private writerNoted = new Map<number, number>();

  /** Why queued tasks wait for the host now (HOST_MIN_FREE_MEMORY_MB, HOST_MAX_LOAD), or null. */
  hostHold: string | null = null;
  private hostNoted = new Set<number>();
  private hostIncidentAt = 0;

  private setHostHold(reason: string | null): void {
    const changed = (this.hostHold === null) !== (reason === null);
    this.hostHold = reason;
    if (changed) bus.publish({ type: "settings" });
  }

  /** The host has no room for this task yet: says so once in its log, and tells an administrator now and then. */
  private holdForHost(task: Task, reason: string, now: number): void {
    this.setHostHold(reason);
    if (!this.hostNoted.has(task.id)) {
      this.hostNoted.add(task.id);
      bus.publish({ type: "event", event: addEvent(task.id, "system", `Waiting for the host: ${reason}. It starts when a running agent finishes or the host has room again`) });
    }
    if (now - this.hostIncidentAt < HOST_INCIDENT_MS) return;
    this.hostIncidentAt = now;
    recordIncident("host_pressure", "warning", `The host is holding queued tasks back: ${reason}. Running agents carry on, and one task always runs. Give the host more memory or CPU, lower MAX_CONCURRENT_TASKS, or change the limit.`, { taskId: task.id });
  }

  /** How many tasks may run at once now: the setting, or less while recovering from rate limits. */
  effectiveConcurrent(now = Date.now()): number {
    if (this.rateCap === null) return this.maxConcurrent;
    const cap = this.rateCap + Math.floor((now - this.rateCapAt) / 120_000);
    if (cap >= this.maxConcurrent) {
      this.rateCap = null;
      return this.maxConcurrent;
    }
    return cap;
  }

  get maxConcurrent(): number {
    const stored = Number(getSetting("max_concurrent"));
    return Number.isFinite(stored) && stored > 0 ? stored : config.maxConcurrent;
  }

  get paused(): boolean {
    return getSetting("paused") === "true";
  }

  setPaused(paused: boolean): void {
    setSetting("paused", String(paused));
    bus.publish({ type: "settings" });
    if (!paused) this.kick();
  }

  setMaxConcurrent(value: number): void {
    setSetting("max_concurrent", String(Math.max(1, Math.min(32, Math.floor(value)))));
    bus.publish({ type: "settings" });
    this.kick();
  }

  runningIds(): number[] {
    return [...this.running.keys()];
  }

  /** Recovers from a restart: tasks that were running go back in the queue to resume (or fail after RESTART_RESUMES). */
  async start(): Promise<void> {
    this.stopping = false;
    for (const task of tasksWithStatus("running")) {
      await recoverInterrupted(task);
      // One that failed for good (restarted too often) leaves its card for a person.
      if (getTask(task.id)?.status === "failed") void boardTaskSettled(task.id).catch((error) => log.warn("Board follow-up failed", { task: task.id, error: errorMessage(error) }));
    }
    this.kick();
  }

  kick(): void {
    if (this.paused || this.stopping) return this.setHostHold(null);
    const now = Date.now();
    let wakeAt = Infinity;
    const queued = queuedTasks();
    // Over a spending limit, nothing new starts until the period ends (or the limit is raised).
    const spend = queued.length ? spendStatus() : null;
    if (spend?.blocked) {
      if (this.wakeTimer) clearTimeout(this.wakeTimer);
      this.wakeTimer = setTimeout(() => this.kick(), Math.min(Math.max(1000, Date.parse(spend.blocked.until) - now + 1000), 2 ** 31 - 1));
      this.wakeTimer.unref();
      return this.setHostHold(null);
    }
    const profiles = queued.length ? loadProfiles().agents : [];
    // Boards with limits.max_running work at most that many of their cards at once.
    const boards = queued.some((task) => task.board) ? loadBoards().boards : [];
    const perBoard = new Map<string, number>();
    const pullCounts = new Map<string, number>();
    const limit = getLimit();
    const busy = new Set([...this.running.values()].map((entry) => entry.workspace));
    // Agents with `replicas: N` work at most N cards at once.
    const perAgent = new Map<string, number>();
    // MAX_RUNNING_PER_REPO: one repository takes at most that many of the slots.
    const perRepo = new Map<string, number>();
    const repoKey = (task: Task) => `${task.owner}/${task.repo}`.toLowerCase();
    // What runs now, and what this pass starts: whoever has more of it waits more turns (queue-order.ts).
    const active: Task[] = [];
    for (const id of this.running.keys()) {
      const running = getTask(id);
      if (!running) continue;
      active.push(running);
      perAgent.set(running.agent, (perAgent.get(running.agent) ?? 0) + 1);
      perRepo.set(repoKey(running), (perRepo.get(repoKey(running)) ?? 0) + 1);
      if (running.board) perBoard.set(running.board, (perBoard.get(running.board) ?? 0) + 1);
    }
    const writing = queued.length ? this.writing(profiles, active) : new Map<string, Task>();
    for (const id of this.writerNoted.keys()) if (!queued.some((task) => task.id === id)) this.writerNoted.delete(id);
    for (const id of this.hostNoted) if (!queued.some((task) => task.id === id)) this.hostNoted.delete(id);
    // Short of memory or CPU, the host takes no further task next to the ones running.
    const pressure = queued.length ? executor.pressure() : null;
    let held = false;
    for (const task of startOrder(queued, active, now)) {
      if (this.running.size >= this.effectiveConcurrent(now)) break;
      const workspace = workspaceDir(task);
      if (busy.has(workspace)) continue;
      if (config.maxRunningPerRepo && (perRepo.get(repoKey(task)) ?? 0) >= config.maxRunningPerRepo) continue;
      const profile = profiles.find((candidate) => candidate.name === task.agent);
      if (!profile) {
        this.finishWithoutRunning(task, "cancelled", "The agent was removed before this task ran");
        continue;
      }
      if (!profile.enabled) continue;
      if (profile.replicas && (perAgent.get(profile.name) ?? 0) >= profile.replicas) continue;
      if (this.overPullLimit(task, profile, pullCounts)) continue;
      const boardLimit = task.board ? boards.find((board) => board.name === task.board)?.limits.maxRunning : null;
      if (task.board && boardLimit && (perBoard.get(task.board) ?? 0) >= boardLimit) continue;
      // Waiting for a usage limit to reset: this task's own, or the model service's (unless the
      // agent has a fallback model to run on meanwhile).
      const serviceLimit = limit && !fallbackModels(profile).length ? Date.parse(limit.until) : 0;
      const blockedUntil = Math.max(task.retryAt ? Date.parse(task.retryAt) : 0, serviceLimit);
      if (blockedUntil > now) {
        wakeAt = Math.min(wakeAt, blockedUntil);
        continue;
      }
      // Another agent is changing this thread's branch: this one goes after it, on what it pushed.
      const keys = config.oneWriterPerThread && writes(task, profile) ? workKeys(task) : [];
      const writer = keys.map((key) => writing.get(key)).find(Boolean);
      if (writer) {
        this.noteWriterAhead(task, writer);
        continue;
      }
      // One task always runs, whatever the host says: otherwise a full host would stop the queue for good.
      if (pressure && this.running.size > 0) {
        this.holdForHost(task, pressure, now);
        held = true;
        wakeAt = Math.min(wakeAt, now + HOST_RECHECK_MS);
        break;
      }
      for (const key of keys) writing.set(key, task);
      busy.add(workspace);
      perAgent.set(profile.name, (perAgent.get(profile.name) ?? 0) + 1);
      perRepo.set(repoKey(task), (perRepo.get(repoKey(task)) ?? 0) + 1);
      if (task.board) perBoard.set(task.board, (perBoard.get(task.board) ?? 0) + 1);
      this.launch(task, workspace);
    }
    if (!held) this.setHostHold(null);
    // Recovering from rate limits: a slot comes back every two minutes, so look again then.
    if (this.rateCap !== null && queued.length) wakeAt = Math.min(wakeAt, now + 120_000);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (Number.isFinite(wakeAt)) {
      this.wakeTimer = setTimeout(() => this.kick(), Math.min(Math.max(1000, wakeAt - now + 500), 2 ** 31 - 1));
      this.wakeTimer.unref();
    }
  }

  /** Runs a task that's waiting for a usage limit right away, and lifts the limit. */
  runNow(taskId: number): boolean {
    const task = getTask(taskId);
    if (task?.status !== "queued") return false;
    clearLimit();
    bus.publish({ type: "task", task: updateTask(task.id, { retryAt: null }) });
    this.kick();
    return true;
  }

  private launch(task: Task, workspace: string): void {
    const controller = new AbortController();
    this.running.set(task.id, { controller, workspace });
    log.info("Starting task", { task: task.id, agent: task.agent, repo: `${task.owner}/${task.repo}`, thread: `${task.threadKind}#${task.threadNumber}` });
    const run = executor
      .run(task, controller.signal)
      .catch((error) => log.error("Task crashed", { task: task.id, error: errorMessage(error) }))
      .then(() => boardTaskSettled(task.id))
      .catch((error) => log.error("Board follow-up failed", { task: task.id, error: errorMessage(error) }))
      .finally(() => {
        this.running.delete(task.id);
        this.draining = this.draining.filter((promise) => promise !== run);
        this.kick();
      });
    this.draining.push(run);
  }

  private finishWithoutRunning(task: Task, status: "cancelled" | "failed", reason: string): void {
    const updated = updateTask(task.id, { status, finishedAt: new Date().toISOString(), error: reason });
    bus.publish({ type: "task", task: updated });
    settleInbox(updated, false); // what waited for a task that was interrupted and never resumed
    void boardTaskSettled(task.id).catch(() => undefined);
  }

  /** Stops a task. `reason` is shown on GitHub; without one it was cancelled from the admin UI. */
  cancel(taskId: number, reason?: string): boolean {
    const running = this.running.get(taskId);
    if (running) {
      running.controller.abort(reason ?? "admin");
      return true;
    }
    const task = getTask(taskId);
    if (task?.status === "queued") {
      // One its agent had paused (wait_for) told the thread it would carry on: say that it won't.
      const paused = Boolean(task.waitFor);
      const why = reason ?? (paused ? "Cancelled from the admin UI while it was paused" : "Cancelled from the admin UI before it started");
      this.finishWithoutRunning(task, "cancelled", why);
      if (paused) void notePausedCancelled(task, why);
      return true;
    }
    return false;
  }

  cancelAll(): number {
    let count = 0;
    for (const task of queuedTasks()) if (this.cancel(task.id)) count++;
    for (const id of this.runningIds()) if (this.cancel(id)) count++;
    return count;
  }

  /** Waits for running tasks to finish (used on shutdown and in tests). */
  async idle(): Promise<void> {
    while (this.draining.length) await Promise.all(this.draining);
  }

  /**
   * Stops for a restart: nothing new starts, running tasks get SHUTDOWN_WAIT_SECONDS to finish,
   * and the rest are stopped and queued again, to resume their sessions after the restart.
   */
  async shutdown(waitSeconds = config.shutdownWaitSeconds): Promise<void> {
    this.stopping = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.running.size && waitSeconds > 0) {
      log.info("Waiting for running agents before stopping", { running: this.running.size, seconds: waitSeconds });
      await Promise.race([this.idle(), new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000).unref())]);
    }
    for (const { controller } of this.running.values()) controller.abort("shutdown");
    await this.idle();
    sessions.closeAll();
  }
}

export const scheduler = new Scheduler();
