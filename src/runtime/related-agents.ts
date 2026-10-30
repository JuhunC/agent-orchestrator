import { startColumnAgent } from "../boards/engine.ts";
import { loadBoards, type Board } from "../boards/loader.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { activeBoardTasks, createTask, getTask, listBoardItems, queuedTaskForThread, runningTasksForThread, tasksForThread, updateTask } from "../db.ts";
import { findInstallation } from "../github/app.ts";
import { refText, sameRepo, type IssueRef, type Relation, type Relations } from "../github/relations.ts";
import { loadProfiles } from "../profiles/loader.ts";
import type { Profile } from "../profiles/types.ts";
import { deliver } from "../runner/inbox.ts";
import { scheduler } from "../runner/scheduler.ts";
import type { Task } from "../types.ts";

/**
 * An agent on one issue starting (or messaging) the agent responsible for a related issue: its
 * parent, a sub-issue, a blocker, or an issue it blocks (start_related_agent). The start waits
 * until the asking task finishes, so the other agent sees its finished work.
 */

/** Most related-issue starts one task may ask for. */
export const MAX_RELATED_STARTS_PER_TASK = 5;

export interface RelatedStart {
  target: IssueRef;
  /** What the target is to the asking task's issue. */
  relation: Relation;
  /** The agent asked for (name), or null for whoever is responsible. */
  agent: string | null;
  message: string;
}

/** Who a start reaches: a board column's agent, or one agent on the issue itself. */
export type StartPlan =
  | { kind: "board"; board: Board; itemId: string; column: string; agent: string | null; agents: string[] }
  | { kind: "thread"; agent: Profile };

/** The target as the asking issue sees it ("#12 is this issue's parent"). */
export const RELATION_NAME: Record<Relation, string> = {
  parent: "this issue's parent",
  sub_issue: "a sub-issue of this issue",
  blocked_by: "an issue blocking this one",
  blocks: "an issue this one blocks",
};

/** The asking issue as the target sees it, for the started agent. */
const SEEN_FROM_TARGET: Record<Relation, string> = {
  parent: "a sub-issue of this issue",
  sub_issue: "this issue's parent",
  blocked_by: "an issue this one blocks",
  blocks: "an issue blocking this one",
};

/** How the target is related to the issue whose relations these are, or null when it isn't. */
export function relationOf(relations: Relations, owner: string, repo: string, number: number): { relation: Relation; issue: IssueRef } | null {
  const same = (issue: IssueRef) => issue.number === number && sameRepo(issue, owner, repo);
  if (relations.parent && same(relations.parent)) return { relation: "parent", issue: relations.parent };
  const lists: [Relation, IssueRef[]][] = [
    ["sub_issue", relations.subIssues],
    ["blocked_by", relations.blockedBy],
    ["blocks", relations.blocking],
  ];
  for (const [relation, issues] of lists) {
    const issue = issues.find(same);
    if (issue) return { relation, issue };
  }
  return null;
}

/**
 * How many agents in a row started each other to get here: the tasks in this one's chain (itself,
 * the task that started it, and so on) that start_related_agent started. Board stages an agent's
 * card move started are links in the chain but don't count, so a loop through the board counts too.
 */
export function chainDepth(task: Task): number {
  let depth = 0;
  const seen = new Set<number>();
  let current: Task | null = task;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.triggerKind === "agent") depth++;
    current = current.startedByTask ? getTask(current.startedByTask) : null;
  }
  return depth;
}

/** Why this task may not start agents on related issues (MAX_AGENT_CHAIN), or null when it may. */
export function chainProblem(task: Task): string | null {
  if (config.maxAgentChain === 0) return "Starting agents on related issues is turned off on this orchestrator (MAX_AGENT_CHAIN=0).";
  const depth = chainDepth(task);
  if (depth < config.maxAgentChain) return null;
  return `This task is the end of a chain of ${depth} agent${depth === 1 ? "" : "s"} starting each other, and MAX_AGENT_CHAIN is ${config.maxAgentChain}, so it can't start another. Say in your reply what the other issue needs, for a person to pick up.`;
}

function findAgent(name: string, agents: Profile[]): Profile | null {
  const wanted = name.replace(/^@/, "").toLowerCase();
  return agents.find((agent) => agent.name.toLowerCase() === wanted || agent.handle.toLowerCase() === wanted) ?? null;
}

const usable = (agent: Profile) => agent.enabled && !agent.errors.length;

/** Who a start would reach right now, or why there's no one. */
export function planStart(start: Pick<RelatedStart, "target" | "agent">): StartPlan | string {
  const { target } = start;
  const where = `${target.owner}/${target.repo}#${target.number}`;
  if (target.state === "closed") return `${where} is closed, so there's no work to start an agent on. Reopen it first, or ask a person to.`;
  const agents = loadProfiles().agents;
  const named = start.agent ? findAgent(start.agent, agents) : null;
  if (start.agent && !named) return `There's no agent called "${start.agent}". Agents: ${agents.map((agent) => agent.name).join(", ") || "none"}.`;
  if (named && !usable(named)) return `${named.name} is ${named.errors.length ? "invalid (its agent.md has errors)" : "turned off"}.`;

  // A card on a board is worked by its column's agent.
  let idle: string | null = null;
  for (const board of loadBoards().boards) {
    if (board.errors.length) continue;
    const card = listBoardItems(board.name).find((row) => row.kind === "issue" && row.number === target.number && sameRepo(row, target.owner, target.repo));
    if (!card?.status) continue;
    const column = board.columns[card.status];
    if (!column?.agents.length) {
      idle ??= `${where} is in "${card.status}" on the ${board.name} board, which has no agent. Name the agent to start with \`agent\`, or move the card to a column with one.`;
      continue;
    }
    if (board.relatedAgents.columns && !board.relatedAgents.columns.includes(column.name)) {
      return `The ${board.name} board doesn't let agents on related issues start the agent of "${column.name}", where ${where} is (related_agents.columns in its board file).`;
    }
    if (named && !column.agents.includes(named.name)) {
      return `${where} is in "${column.name}" on the ${board.name} board, which ${column.agents.join(", ")} ${column.agents.length === 1 ? "works" : "work"}. Leave out \`agent\` to start the column's agent, or name ${column.agents.length === 1 ? "it" : "one of them"}.`;
    }
    return { kind: "board", board, itemId: card.itemId, column: column.name, agent: named?.name ?? null, agents: named ? [named.name] : column.agents };
  }
  if (named) return { kind: "thread", agent: named };
  if (idle) return idle;

  // Otherwise: the agent that worked on the issue last.
  const ref = { owner: target.owner, repo: target.repo, kind: "issue" as const, number: target.number };
  const last = tasksForThread(ref)
    .reverse()
    .map((task) => agents.find((agent) => agent.name === task.agent))
    .find((agent): agent is Profile => Boolean(agent));
  if (!last) {
    return `No agent has worked on ${where} yet and it isn't in a board column with an agent, so no agent is responsible for it. Name one with \`agent\` (${agents.filter(usable).map((agent) => agent.name).join(", ") || "none are available"}).`;
  }
  if (!usable(last)) return `${last.name}, the agent that last worked on ${where}, is turned off. Name another with \`agent\`.`;
  return { kind: "thread", agent: last };
}

/** "the In progress agent (coder) of the delivery board", or "**coder**". */
export function describePlan(plan: StartPlan): string {
  if (plan.kind === "thread") return `**${plan.agent.name}**`;
  return `the "${plan.column}" agent (${plan.agents.join(" or ")}) of the ${plan.board.name} board`;
}

/**
 * Starts (or messages) the target's agent for a finished task. Returns one line saying what
 * happened, for the task's events.
 */
export async function runRelatedStart(start: RelatedStart, source: { task: Task; profile: Profile; title: string; url: string }): Promise<string> {
  const { target } = start;
  const { task, profile } = source;
  const where = refText(target, task.owner, task.repo);
  const plan = planStart(start);
  if (typeof plan === "string") return `Didn't start an agent on ${where}: ${plan}`;

  const from = `${task.owner}/${task.repo}#${task.threadNumber}`;
  const request = [
    `**${profile.name}** (@${profile.handle}) asked you to pick this up from ${from} "${source.title}", ${SEEN_FROM_TARGET[start.relation]} (orchestrator task #${task.id}):`,
    "",
    start.message
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  ].join("\n");
  const activity = {
    ref: { owner: target.owner, repo: target.repo, kind: "issue" as const, number: target.number },
    author: profile.handle,
    summary: `(agent ${profile.name}, on ${from}: ${SEEN_FROM_TARGET[start.relation]}) asked you to pick this up`,
    body: start.message.trim(),
    url: source.url,
  };
  // Already working (or about to): tell it rather than start another.
  const tell = (busy: Task[]): string | null => {
    const running = busy.filter((other) => other.status === "running");
    for (const other of running) deliver(other, activity, { trusted: true, mention: true, startedByTask: task.id });
    const queued = busy.filter((other) => other.status === "queued");
    for (const other of queued) bus.publish({ type: "task", task: updateTask(other.id, { requestText: `${other.requestText}\n\n---\n\n${request}` }) });
    if (!busy.length) return null;
    const names = [...new Set(busy.map((other) => other.agent))].join(", ");
    return `Passed the message to ${names} on ${where}, already ${running.length ? "working on it" : "queued for it"} (task ${busy.map((other) => `#${other.id}`).join(", ")})`;
  };

  if (plan.kind === "board") {
    const busy = activeBoardTasks(plan.board.name, plan.itemId).filter((other) => other.boardColumn === plan.column && (!plan.agent || other.agent === plan.agent));
    const told = tell(busy);
    if (told) return told;
    const { tasks, skipped } = await startColumnAgent(plan.board, plan.itemId, { request, requestedBy: profile.handle, requestUrl: source.url, startedByTask: task.id, ...(plan.agent ? { agent: plan.agent } : {}) });
    if (!tasks.length) return `Didn't start an agent on ${where}: ${skipped ?? "the board started none"}`;
    return `Started ${tasks.map((other) => `${other.agent} (task #${other.id})`).join(", ")} on ${where} in "${plan.column}" on the ${plan.board.name} board`;
  }

  const ref = activity.ref;
  const busy = [...runningTasksForThread(ref).filter((other) => other.agent === plan.agent.name && other.threadKind === "issue" && other.threadNumber === target.number)];
  const queued = queuedTaskForThread(ref, plan.agent.name);
  if (queued) busy.push(queued);
  const told = tell(busy);
  if (told) return told;
  const installationId = sameRepo(target, task.owner, task.repo) ? task.installationId : await findInstallation(target.owner, target.repo);
  const created = createTask({
    agent: plan.agent.name,
    installationId,
    owner: target.owner,
    repo: target.repo,
    threadKind: "issue",
    threadNumber: target.number,
    threadTitle: target.title,
    threadUrl: target.url,
    triggerKind: "agent",
    requestedBy: profile.handle,
    requestText: request,
    requestUrl: source.url,
    startedByTask: task.id,
  });
  bus.publish({ type: "task", task: created });
  scheduler.kick();
  return `Started ${plan.agent.name} on ${where} (task #${created.id})`;
}
