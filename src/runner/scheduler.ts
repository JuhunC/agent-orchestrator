import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { getSetting, getTask, queuedTasks, setSetting, tasksWithStatus, updateTask } from "../db.ts";
import { errorMessage, log } from "../log.ts";
import type { Task } from "../types.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { sessions } from "../runtime/manager.ts";
import { workspaceDir } from "../runtime/workspace.ts";
import { clearLimit, getLimit } from "./limit-store.ts";
import { executeTask, markInterrupted } from "./run-task.ts";

/**
 * Runs queued tasks, up to the concurrency limit. Two tasks that share a workspace (same agent
 * on the same thread) never run at the same time.
 */
class Scheduler {
  private running = new Map<number, { controller: AbortController; workspace: string }>();
  private draining: Promise<void>[] = [];
  private wakeTimer: NodeJS.Timeout | null = null;

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

  /** Recovers from a restart: running tasks are marked interrupted, queued ones resume. */
  async start(): Promise<void> {
    for (const task of tasksWithStatus("running")) await markInterrupted(task);
    this.kick();
  }

  kick(): void {
    if (this.paused) return;
    const now = Date.now();
    let wakeAt = Infinity;
    const queued = queuedTasks();
    const profiles = queued.length ? loadProfiles().agents : [];
    const limit = getLimit();
    const busy = new Set([...this.running.values()].map((entry) => entry.workspace));
    for (const task of queued) {
      if (this.running.size >= this.maxConcurrent) break;
      const workspace = workspaceDir(task);
      if (busy.has(workspace)) continue;
      const profile = profiles.find((candidate) => candidate.name === task.agent);
      if (!profile) {
        this.finishWithoutRunning(task, "cancelled", "The agent was removed before this task ran");
        continue;
      }
      if (!profile.enabled) continue;
      // Waiting for a usage limit to reset: this task's own, or the model service's.
      const blockedUntil = Math.max(task.retryAt ? Date.parse(task.retryAt) : 0, limit ? Date.parse(limit.until) : 0);
      if (blockedUntil > now) {
        wakeAt = Math.min(wakeAt, blockedUntil);
        continue;
      }
      busy.add(workspace);
      this.launch(task, workspace);
    }
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
  }

  cancel(taskId: number): boolean {
    const running = this.running.get(taskId);
    if (running) {
      running.controller.abort();
      return true;
    }
    const task = getTask(taskId);
    if (task?.status === "queued") {
      this.finishWithoutRunning(task, "cancelled", "Cancelled from the admin UI before it started");
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

  async shutdown(): Promise<void> {
    for (const { controller } of this.running.values()) controller.abort("shutdown");
    await this.idle();
    sessions.closeAll();
  }
}

export const scheduler = new Scheduler();
