export type ThreadKind = "issue" | "pull" | "discussion";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** "agent": another issue's agent started it (start_related_agent). */
/** "maintenance": the orchestrator started it itself (e.g. to fix a pull request that conflicts with its base). */
/** "schedule": one of the agent's schedules came round (see schedules/runner.ts). */
export type TriggerKind = "mention" | "assignment" | "manual" | "retry" | "board" | "agent" | "maintenance" | "schedule";
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
  /** A replay that changes nothing on GitHub: write tools only say what they would do. */
  dryRun: boolean;
  /** How many times the orchestrator restarted under this task (it resumes each time, up to RESTART_RESUMES). */
  restarts: number;
  /** Fingerprint of the agent's profile that ran it, and the profiles folder's commit (see profiles/version.ts). */
  profileVersion: string | null;
  profileCommit: string | null;
  /** The schedule that started this run, if one did. */
  scheduleId: number | null;
}

/**
 * A timetable an agent runs on: "ui" made in the admin UI, "agent" made by the agent itself
 * (create_schedule), "file" listed under schedules: in its agent.md.
 */
export interface Schedule {
  id: number;
  agent: string;
  name: string;
  /** A cron expression, a shortcut (@daily) or an interval ("every 6h"); see schedules/when.ts. */
  when: string;
  timezone: string;
  owner: string;
  repo: string;
  installationId: number | null;
  /** The issue, pull request or discussion each run works on; null until the first run opens an issue for it. */
  threadKind: ThreadKind | null;
  threadNumber: number | null;
  /** What to do on each run. */
  prompt: string;
  enabled: boolean;
  source: "ui" | "agent" | "file";
  /** For file schedules: "<agent>/<name>", to match the file on reload. */
  fileKey: string | null;
  createdBy: string;
  createdByTask: number | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: number | null;
  runs: number;
  /** Stop after this many runs, or after this time (null: keep going). */
  maxRuns: number | null;
  endsAt: string | null;
  /** Why it's paused or finished, or what happened to the last run. */
  note: string | null;
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
