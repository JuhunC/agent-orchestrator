import { readFileSync } from "node:fs";
import os from "node:os";
import { config } from "../config.ts";
import type { Task } from "../types.ts";
import { executeTask } from "./run-task.ts";

/**
 * Where tasks run. The scheduler decides what starts and in which order; an executor says whether
 * there's room for one more, and runs it. There is one: this process on this host, with each
 * agent a child process of it (LocalExecutor). Workers on other hosts would be another Executor;
 * nothing else in the scheduler knows where a task runs.
 */
export interface Executor {
  /** What the admin UI calls it. */
  readonly name: string;
  /** Why it shouldn't take another task now, or null when there's room. */
  pressure(): string | null;
  status(): HostStatus;
  /** Runs a task to its end; aborting the signal stops it. */
  run(task: Task, signal: AbortSignal): Promise<void>;
}

export interface HostReading {
  /** Memory a new process could use, in MB. */
  freeMb: number;
  /** The 1-minute load average per CPU; null where the system reports none (Windows). */
  loadPerCpu: number | null;
}

export interface HostLimits {
  /** HOST_MIN_FREE_MEMORY_MB; 0: not checked. */
  minFreeMemoryMb: number;
  /** HOST_MAX_LOAD, per CPU; 0: not checked. */
  maxLoad: number;
}

export interface HostStatus extends HostReading {
  executor: string;
  cpus: number;
  totalMb: number;
  limits: HostLimits;
  /** Why new tasks wait for the host now; null when there's room. */
  pressure: string | null;
}

const MB = 1024 * 1024;
export const megabytes = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/** Why a host with this reading shouldn't start another agent, or null. */
export function pressureOf(reading: HostReading, limits: HostLimits): string | null {
  if (limits.minFreeMemoryMb > 0 && reading.freeMb < limits.minFreeMemoryMb) return `${megabytes(reading.freeMb)} of memory is free, and HOST_MIN_FREE_MEMORY_MB is ${limits.minFreeMemoryMb}`;
  if (limits.maxLoad > 0 && reading.loadPerCpu !== null && reading.loadPerCpu > limits.maxLoad) return `the load is ${reading.loadPerCpu.toFixed(2)} per CPU, and HOST_MAX_LOAD is ${limits.maxLoad}`;
  return null;
}

/** A container's memory limit in bytes, or 0 when it has none. */
function memoryLimit(): number {
  const constrained = process.constrainedMemory();
  return constrained > 0 && constrained < os.totalmem() ? constrained : 0;
}

/** File cache the kernel gives back when memory is asked for, from a cgroup's memory.stat. */
export function inactiveFile(stat: string): number {
  const found = /^total_inactive_file (\d+)$/m.exec(stat) ?? /^inactive_file (\d+)$/m.exec(stat);
  return found ? Number(found[1]) : 0;
}

/**
 * Memory another process could get, in bytes. Under a container's memory limit Node reports the
 * limit minus all that's charged to the container, file cache included; the cache is given back
 * when memory is needed (checkouts fill it), so it's counted as free, as `docker stats` does.
 */
function availableMemory(): number {
  const free = process.availableMemory();
  if (process.platform !== "linux" || !memoryLimit()) return free;
  for (const path of ["/sys/fs/cgroup/memory.stat", "/sys/fs/cgroup/memory/memory.stat"]) {
    try {
      return Math.min(free + inactiveFile(readFileSync(path, "utf8")), os.freemem());
    } catch {
      // cgroup v1 keeps it in the second place; neither: Node's figure stands
    }
  }
  return free;
}

class LocalExecutor implements Executor {
  readonly name = "this host";

  reading(): HostReading {
    const cpus = os.availableParallelism();
    // Windows has no load average: it reports zeros.
    const load = process.platform === "win32" ? null : os.loadavg()[0]! / cpus;
    return { freeMb: availableMemory() / MB, loadPerCpu: load };
  }

  limits(): HostLimits {
    return { minFreeMemoryMb: config.hostMinFreeMemoryMb, maxLoad: config.hostMaxLoad };
  }

  pressure(): string | null {
    const limits = this.limits();
    return limits.minFreeMemoryMb > 0 || limits.maxLoad > 0 ? pressureOf(this.reading(), limits) : null;
  }

  status(): HostStatus {
    const reading = this.reading();
    const limits = this.limits();
    return { executor: this.name, cpus: os.availableParallelism(), totalMb: (memoryLimit() || os.totalmem()) / MB, ...reading, limits, pressure: pressureOf(reading, limits) };
  }

  run(task: Task, signal: AbortSignal): Promise<void> {
    return executeTask(task, signal);
  }
}

export const executor: Executor = new LocalExecutor();
