export type ThreadKind = "issue" | "pull" | "discussion";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** "agent": another issue's agent started it (start_related_agent). */
export type TriggerKind = "mention" | "assignment" | "manual" | "retry" | "board" | "agent";
/** "github": something a person did on the thread while the agent was working. */
export type EventKind = "status" | "tool" | "text" | "stderr" | "system" | "error" | "github";


export interface Task {
  id: number;
  agent: string;
  installationId: number;
  owner: string;
  repo: string;
  threadKind: ThreadKind;
  threadNumber: number;
  threadTitle: string;
  threadUrl: string;
  triggerKind: TriggerKind;
  requestedBy: string;
  requestText: string;
  requestUrl: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progressCommentId: string | null;
  branch: string | null;
  baseBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prompt: string | null;
  resultText: string | null;
  error: string | null;
  exitCode: number | null;
  sessionId: string | null;
  /** What this task cost (Claude Code's estimate), and its tokens. */
  costUsd: number | null;
  usage: TaskUsage | null;
  commits: number | null;
  retryOf: number | null;
  forgotten: boolean;
  /** Set while the task waits for a usage limit to reset. */
  retryAt: string | null;
  /** How many times a usage limit paused the task. */
  attempts: number;
  /** Commit the first attempt started from, so retries count earlier commits. */
  startSha: string | null;
  live: boolean;
  /** Set for tasks started by a project board: which board, column and card. */
  board: string | null;
  boardColumn: string | null;
  boardItemId: string | null;
  /** Set when several agents work the same card at once ("all" columns). */
  boardRound: string | null;
  /** The task whose agent started this one from a related issue (start_related_agent). */
  startedByTask: number | null;
}

/** Tokens one model used. */
export interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** A task's token usage: totals, and per model (main loop, subagents and compaction together). */
export interface TaskUsage extends Omit<ModelTokens, "costUsd"> {
  models: Record<string, ModelTokens>;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  ts: string;
  kind: EventKind;
  message: string;
}

export interface Delivery {
  id: number;
  deliveryId: string;
  event: string;
  action: string;
  repo: string;
  sender: string;
  /** forwarded: passed to an agent already working on the thread. */
  decision: "triggered" | "forwarded" | "ignored" | "rejected" | "error";
  detail: string;
  ts: string;
}

export interface ThreadRef {
  owner: string;
  repo: string;
  kind: ThreadKind;
  number: number;
}
