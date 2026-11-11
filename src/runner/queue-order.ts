import { config } from "../config.ts";
import type { Task, TaskPriority } from "../types.ts";

type Queued = Pick<Task, "id" | "triggerKind" | "createdAt"> & Partial<Pick<Task, "priority" | "owner" | "repo" | "requestedBy">>;
type Requester = Partial<Pick<Task, "owner" | "repo" | "requestedBy">>;
type Served = Requester & { startedAt: string };

/**
 * Where a queued task stands; lower starts first.
 *
 * 0. High priority (a label in HIGH_PRIORITY_LABELS, or set in the admin UI).
 * 1. Anything that has waited longer than QUEUE_AGING_MINUTES, so nothing waits for ever.
 * 2. People's own requests (mentions, assignments, manual runs, retries).
 * 3. Work agents and the orchestrator started (related agents, conflict fixes, schedules).
 * 4. Board stages: a board with many cards mustn't hold up someone who asked just now.
 * 5. Low priority, which ages only after twice as long.
 */
export function rank(task: Pick<Task, "triggerKind" | "createdAt"> & Partial<Pick<Task, "priority">>, now = Date.now()): number {
  if (task.priority === "high") return 0;
  const aging = config.queueAgingMinutes * 60_000 * (task.priority === "low" ? 2 : 1);
  if (aging > 0 && now - Date.parse(task.createdAt) > aging) return 1;
  if (task.priority === "low") return 5;
  if (task.triggerKind === "board") return 4;
  if (task.triggerKind === "agent" || task.triggerKind === "maintenance" || task.triggerKind === "schedule") return 3;
  return 2;
}

/** Whose work a task is: the person (or board, schedule, agent) who asked, in that repository. */
function requester(task: Requester): string {
  return `${task.owner ?? ""}/${task.repo ?? ""}#${task.requestedBy ?? ""}`.toLowerCase();
}

/**
 * The order queued tasks start in: by standing (rank), and within one standing in turns, so
 * whoever has the least running and waiting goes first (QUEUE_FAIRNESS; one requester's own tasks
 * stay oldest first). `running` is what runs now: a requester with tasks running waits that many
 * turns. `served` is when requesters' latest tasks started: a tie goes to whoever was served
 * longest ago, so with a single slot people still alternate.
 */
export function queueOrder<T extends Queued>(tasks: T[], now = Date.now(), running: Requester[] = [], served: Served[] = []): T[] {
  const ranked = tasks.map((task) => ({ task, rank: rank(task, now), turn: 0, last: 0 })).sort((a, b) => a.rank - b.rank || a.task.id - b.task.id);
  if (config.queueFairness) {
    const held = new Map<string, number>();
    for (const task of running) held.set(requester(task), (held.get(requester(task)) ?? 0) + 1);
    const last = new Map<string, number>();
    for (const entry of served) last.set(requester(entry), Math.max(last.get(requester(entry)) ?? 0, Date.parse(entry.startedAt) || 0));
    // Turns are counted per standing: a requester's first task of a rank comes after as many
    // rounds as they have tasks running.
    const taken = new Map<string, number>();
    for (const entry of ranked) {
      const who = requester(entry.task);
      const key = `${entry.rank} ${who}`;
      entry.turn = (held.get(who) ?? 0) + (taken.get(key) ?? 0);
      entry.last = last.get(who) ?? 0;
      taken.set(key, (taken.get(key) ?? 0) + 1);
    }
    ranked.sort((a, b) => a.rank - b.rank || a.turn - b.turn || a.last - b.last || a.task.id - b.task.id);
  }
  return ranked.map((entry) => entry.task);
}

/** The priority an issue's or pull request's labels give its tasks (HIGH_PRIORITY_LABELS, LOW_PRIORITY_LABELS). */
export function priorityFromLabels(labels: unknown): TaskPriority {
  const names = (Array.isArray(labels) ? labels : []).map((label) => String(typeof label === "string" ? label : (label?.name ?? "")).toLowerCase());
  if (names.some((name) => config.highPriorityLabels.includes(name))) return "high";
  if (names.some((name) => config.lowPriorityLabels.includes(name))) return "low";
  return "normal";
}

/** Why a queued task stands where it does, for the task page: one sentence. */
export function rankReason(task: Parameters<typeof rank>[0], now = Date.now()): string {
  const fair = config.queueFairness ? " Among those, people take turns: whoever has the least running and waiting goes first." : "";
  switch (rank(task, now)) {
    case 0:
      return "It has high priority, so it goes before everything else.";
    case 1:
      return `It has waited more than ${config.queueAgingMinutes * (task.priority === "low" ? 2 : 1)} minutes, so it goes before newer work.${fair}`;
    case 2:
      return `People's own requests start before work that agents, schedules and boards started.${fair}`;
    case 3:
      return `Work that agents, schedules and the orchestrator started goes after people's own requests and before board stages.${fair}`;
    case 4:
      return `Board stages start after people's requests and agent-started work.${fair}`;
    default:
      return "It has low priority, so it goes after everything else.";
  }
}
