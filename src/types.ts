export type ThreadKind = "issue" | "pull" | "discussion";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type TriggerKind = "mention" | "assignment" | "manual" | "retry";
export type OutputFormat = "text" | "claude-stream-json" | "codex-json" | "gemini-stream-json";
export type EventKind = "status" | "tool" | "text" | "stderr" | "system" | "error";

export const OUTPUT_FORMATS: OutputFormat[] = ["text", "claude-stream-json", "codex-json", "gemini-stream-json"];

export interface Agent {
  name: string;
  handle: string;
  description: string;
  command: string;
  args: string[];
  resumeArgs: string[];
  output: OutputFormat;
  env: Record<string, string>;
  timeoutMinutes: number | null;
  openPullRequest: boolean;
  exposeGithubToken: boolean;
  enabled: boolean;
  source: "file" | "ui";
  createdAt: string;
  updatedAt: string;
}

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
  costUsd: number | null;
  commits: number | null;
  retryOf: number | null;
  forgotten: boolean;
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
  decision: "triggered" | "ignored" | "rejected" | "error";
  detail: string;
  ts: string;
}

export interface ThreadRef {
  owner: string;
  repo: string;
  kind: ThreadKind;
  number: number;
}
