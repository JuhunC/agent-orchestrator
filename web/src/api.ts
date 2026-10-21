import { useCallback, useEffect, useRef, useState } from "react";

export type ThreadKind = "issue" | "pull" | "discussion";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface GithubPermissions {
  comment: boolean;
  updateIssue: boolean;
  review: boolean;
  push: boolean;
  pullRequest: boolean;
  clone: boolean;
  finalize: boolean;
}

/** An agent profile (profiles/agents/<name>/agent.md). */
export interface Agent {
  name: string;
  handle: string;
  description: string;
  model: string | null;
  effort: Effort | null;
  prompt: string;
  toolsAllow: string[] | null;
  toolsDeny: string[];
  skills: string[];
  mcp: string[];
  subagents: string[];
  github: GithubPermissions;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  timeoutMinutes: number | null;
  live: boolean;
  enabledInFile: boolean;
  enabled: boolean;
  ownSkills: { name: string; description: string }[];
  ownMcp: string[];
  errors: string[];
  stats?: AgentStats | null;
}

export interface Library {
  skills: { name: string; description: string }[];
  roles: { name: string; description: string; tools: string[] | null; model: string | null }[];
  mcp: { name: string; type?: string; target?: string }[];
}

export interface AgentsResponse {
  agents: Agent[];
  library: Library;
  errors: string[];
  profilesDir: string;
}

export interface SessionInfo {
  key: string;
  agent: string;
  owner: string;
  repo: string;
  threadKind: ThreadKind;
  threadNumber: number;
  sessionId: string | null;
  busy: boolean;
  turns: number;
  startedAt: string;
  lastUsedAt: string;
  closesAt: string | null;
}

export interface ModelInfo {
  baseUrl: string;
  custom: boolean;
  model: string | null;
  credential: string | null;
  limit: { until: string; reason: string } | null;
}

export interface Task {
  id: number;
  agent: string;
  owner: string;
  repo: string;
  threadKind: ThreadKind;
  threadNumber: number;
  threadTitle: string;
  threadUrl: string;
  triggerKind: "mention" | "assignment" | "manual" | "retry";
  requestedBy: string;
  requestText: string;
  requestUrl: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
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
  retryAt: string | null;
  attempts: number;
  live: boolean;
  board: string | null;
  boardColumn: string | null;
  boardItemId: string | null;
}

export interface BoardColumnInfo {
  name: string;
  agent: string | null;
  roleName: string | null;
  roleText: string | null;
  model: string | null;
  effort: Effort | null;
  onStart: string | null;
  movesTo: string[] | "any";
}

export interface BoardCard {
  itemId: string;
  owner: string;
  repo: string;
  kind: ThreadKind;
  number: number;
  title: string;
  status: string | null;
  moves: number;
  entries: Record<string, number>;
  updatedAt: string;
}

export interface BoardInfo {
  name: string;
  file: string;
  project: string;
  statusField: string;
  needsHuman: string | null;
  pollSeconds: number;
  limits: { movesPerIssue: number; entriesPerColumn: number; budgetUsdPerIssue: number | null };
  columns: BoardColumnInfo[];
  errors: string[];
  status: { project: { title: string; url: string; columns: string[] } | null; lastSyncAt: string | null; error: string | null };
  items: BoardCard[];
}

export interface BoardsResponse {
  boards: BoardInfo[];
  errors: string[];
  agents: string[];
  roles: string[];
}

export interface TaskEvent {
  id: number;
  taskId: number;
  ts: string;
  kind: "status" | "tool" | "text" | "stderr" | "system" | "error";
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

export interface Settings {
  paused: boolean;
  maxConcurrent: number;
  running: number;
  liveIdleMinutes: number;
  maxLiveSessions: number;
  usageLimitRetries: number;
}

export interface Setup {
  configured: boolean;
  app: {
    appId: string;
    slug: string;
    htmlUrl: string;
    ownerLogin: string;
    source: "env" | "setup";
    githubLogin: boolean;
    installUrl: string | null;
  } | null;
  githubUrl: string;
  apiUrl: string;
  publicUrl: string;
  webhookUrl: string;
  webhookProxy: boolean;
  adminUsers: string[];
  triggerMinPermission: string;
  allowedRepos: string[];
  labelPrefix: string;
  defaultTimeoutMinutes: number;
  profilesDir: string;
}

export interface Overview {
  agents: Agent[];
  running: Task[];
  queued: Task[];
  recent: Task[];
  sessions: SessionInfo[];
  model: ModelInfo;
  settings: Settings;
  configured: boolean;
}

export interface ThreadSummary {
  owner: string;
  repo: string;
  threadKind: ThreadKind;
  threadNumber: number;
  threadTitle: string;
  threadUrl: string;
  agents: string[];
  taskCount: number;
  lastActivity: string;
}

export interface Installation {
  id: number;
  account: string;
  selection: string;
  htmlUrl: string;
  repositories: string[];
  totalRepositories: number;
}

export type BusMessage =
  | { type: "task"; task: Task }
  | { type: "event"; event: TaskEvent }
  | { type: "delivery"; delivery: Delivery }
  | { type: "agents" }
  | { type: "settings" }
  | { type: "sessions" }
  | { type: "limits" }
  | { type: "boards" };

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && !path.startsWith("/api/auth/")) unauthorizedListeners.forEach((listener) => listener());
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(data?.error ?? `Request failed (${response.status})`, response.status);
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T,>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T,>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T,>(path: string) => request<T>("DELETE", path),
};

// ---------- live stream ----------

type Listener = (message: BusMessage) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<(connected: boolean) => void>();
let source: EventSource | null = null;
let connected = false;

function setConnected(value: boolean) {
  connected = value;
  statusListeners.forEach((listener) => listener(value));
}

export function connectStream(): void {
  if (source) return;
  source = new EventSource("/api/stream");
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data) as BusMessage;
      listeners.forEach((listener) => listener(message));
    } catch {
      // ignore malformed frames
    }
  };
}

export function disconnectStream(): void {
  source?.close();
  source = null;
  setConnected(false);
}

export function useStream(listener: Listener): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    const wrapped: Listener = (message) => ref.current(message);
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}

export function useStreamStatus(): boolean {
  const [value, setValue] = useState(connected);
  useEffect(() => {
    statusListeners.add(setValue);
    return () => {
      statusListeners.delete(setValue);
    };
  }, []);
  return value;
}

/**
 * Fetches `path` and refetches (debounced) whenever a live message matches `refreshOn`.
 */
export function useApi<T>(path: string | null, refreshOn?: (message: BusMessage) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const result = await api.get<T>(path);
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useStream((message) => {
    if (!refreshOn || !refreshOn(message)) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), 250);
  });

  return { data, error, loading, reload: load, setData };
}

// ---------- formatting ----------

export const KIND_LABEL: Record<ThreadKind, string> = { issue: "Issue", pull: "PR", discussion: "Discussion" };

export function threadLabel(task: Pick<Task, "owner" | "repo" | "threadKind" | "threadNumber">): string {
  return `${task.owner}/${task.repo}#${task.threadNumber}`;
}

export function duration(fromIso: string | null, toIso: string | null, now = Date.now()): string {
  if (!fromIso) return "—";
  const ms = (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso);
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
