import { config } from "../config.ts";
import type { Task } from "../types.ts";

/**
 * The order queued tasks start in: what people asked for first (mentions, assignments, runs and
 * retries from the admin UI), then work agents started for each other, then board stages. A task
 * that has waited longer than QUEUE_AGING_MINUTES moves to the front of the line, so a stream of
 * mentions can't hold board work back forever. First come, first served within each group.
 */
export function priority(task: Pick<Task, "triggerKind" | "createdAt">, now = Date.now()): number {
  if (config.queueAgingMinutes > 0 && now - Date.parse(task.createdAt) > config.queueAgingMinutes * 60_000) return 0;
  if (task.triggerKind === "board") return 3;
  if (task.triggerKind === "agent" || task.triggerKind === "maintenance") return 2;
  return 1;
}

export function queueOrder<T extends Pick<Task, "id" | "triggerKind" | "createdAt">>(tasks: T[], now = Date.now()): T[] {
  return [...tasks].sort((a, b) => priority(a, now) - priority(b, now) || a.id - b.id);
}
