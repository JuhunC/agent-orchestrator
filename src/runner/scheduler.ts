import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { getSetting, getTask, queuedTasks, setSetting, tasksWithStatus, updateTask } from "../db.ts";
import { errorMessage, log } from "../log.ts";
import type { Task } from "../types.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { sessions } from "../runtime/manager.ts";
import { workspaceDir } from "../runtime/workspace.ts";
import { clearLimit, getLimit } from "./limit-store.ts";
import { spendStatus } from "./spend.ts";
import { queueOrder } from "./queue-order.ts";
import { fallbackModels } from "../runtime/options.ts";
import { loadBoards } from "../boards/loader.ts";
import { boardTaskSettled } from "../boards/engine.ts";
import { executeTask, recoverInterrupted } from "./run-task.ts";

/**
 * Runs queued tasks, up to the concurrency limit. Two tasks that share a workspace (same agent
 * on the same thread) never run at the same time.
 */
class Scheduler {
  private running = new Map<number, { controller: AbortController; workspace: string }>();
  private draining: Promise<void>[] = [];
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Set while shutting down: nothing new starts. */
  private stopping = false;
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
    for (const task of tasksWithStatus("running")) await recoverInterrupted(task);
    this.kick();
  }

  kick(): void {
    if (this.paused || this.stopping) return;
    const now = Date.now();
    let wakeAt = Infinity;
    const queued = queuedTasks();
    // Over a spending limit, nothing new starts until the period ends (or the limit is raised).
    const spend = queued.length ? spendStatus() : null;
    if (spend?.blocked) {
      if (this.wakeTimer) clearTimeout(this.wakeTimer);
      this.wakeTimer = setTimeout(() => this.kick(), Math.min(Math.max(1000, Date.parse(spend.blocked.until) - now + 1000), 2 ** 31 - 1));
      this.wakeTimer.unref();
      return;
    }
    const profiles = queued.length ? loadProfiles().agents : [];
    // Boards with limits.max_running work at most that many of their cards at once.
    const boards = queued.some((task) => task.board) ? loadBoards().boards : [];
    const perBoard = new Map<string, number>();
    const limit = getLimit();
    const busy = new Set([...this.running.values()].map((entry) => entry.workspace));
    // Agents with `replicas: N` work at most N cards at once.
    const perAgent = new Map<string, number>();
    for (const id of this.running.keys()) {
      const running = getTask(id);
      if (running) perAgent.set(running.agent, (perAgent.get(running.agent) ?? 0) + 1);
      if (running?.board) perBoard.set(running.board, (perBoard.get(running.board) ?? 0) + 1);
    }
    for (const task of queueOrder(queued, now)) {
      if (this.running.size >= this.effectiveConcurrent(now)) break;
      const workspace = workspaceDir(task);
      if (busy.has(workspace)) continue;
      const profile = profiles.find((candidate) => candidate.name === task.agent);
      if (!profile) {
        this.finishWithoutRunning(task, "cancelled", "The agent was removed before this task ran");
        continue;
      }
      if (!profile.enabled) continue;
      if (profile.replicas && (perAgent.get(profile.name) ?? 0) >= profile.replicas) continue;
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
      busy.add(workspace);
      perAgent.set(profile.name, (perAgent.get(profile.name) ?? 0) + 1);
      if (task.board) perBoard.set(task.board, (perBoard.get(task.board) ?? 0) + 1);
      this.launch(task, workspace);
    }
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
    const run = executeTask(task, controller.signal)
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
      this.finishWithoutRunning(task, "cancelled", reason ?? "Cancelled from the admin UI before it started");
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
