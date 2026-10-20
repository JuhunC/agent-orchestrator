import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";
import type { Agent, Delivery, EventKind, Task, TaskEvent, TaskStatus, ThreadKind, ThreadRef } from "./types.ts";

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, "orchestrator.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  resume_args TEXT NOT NULL DEFAULT '[]',
  output TEXT NOT NULL DEFAULT 'text',
  env TEXT NOT NULL DEFAULT '{}',
  timeout_minutes INTEGER,
  open_pull_request INTEGER NOT NULL DEFAULT 1,
  expose_github_token INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'ui',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  thread_kind TEXT NOT NULL,
  thread_number INTEGER NOT NULL,
  thread_title TEXT NOT NULL DEFAULT '',
  thread_url TEXT NOT NULL DEFAULT '',
  trigger_kind TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  request_text TEXT NOT NULL,
  request_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  progress_comment_id TEXT,
  branch TEXT,
  base_branch TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  prompt TEXT,
  result_text TEXT,
  error TEXT,
  exit_code INTEGER,
  session_id TEXT,
  cost_usd REAL,
  commits INTEGER,
  retry_of INTEGER,
  forgotten INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_thread ON tasks (owner, repo, thread_kind, thread_number, agent);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, id);
CREATE TABLE IF NOT EXISTS thread_links (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_number INTEGER NOT NULL,
  to_kind TEXT NOT NULL,
  to_number INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, from_kind, from_number, to_kind, to_number)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT NOT NULL,
  repo TEXT NOT NULL,
  sender TEXT NOT NULL,
  decision TEXT NOT NULL,
  detail TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`);

export function now(): string {
  return new Date().toISOString();
}

type Row = Record<string, SQLInputValue>;

function json<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

// ---------- agents ----------

function toAgent(row: Row): Agent {
  return {
    name: String(row.name),
    handle: String(row.handle),
    description: String(row.description),
    command: String(row.command),
    args: json(row.args, []),
    resumeArgs: json(row.resume_args, []),
    output: String(row.output) as Agent["output"],
    env: json(row.env, {}),
    timeoutMinutes: row.timeout_minutes === null ? null : Number(row.timeout_minutes),
    openPullRequest: Boolean(row.open_pull_request),
    exposeGithubToken: Boolean(row.expose_github_token),
    enabled: Boolean(row.enabled),
    source: String(row.source) as Agent["source"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export type AgentInput = Omit<Agent, "createdAt" | "updatedAt">;

export function listAgents(): Agent[] {
  return (db.prepare("SELECT * FROM agents ORDER BY name").all() as Row[]).map(toAgent);
}

export function getAgent(name: string): Agent | null {
  const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as Row | undefined;
  return row ? toAgent(row) : null;
}

export function getAgentByHandle(handle: string): Agent | null {
  const row = db.prepare("SELECT * FROM agents WHERE handle = ? COLLATE NOCASE").get(handle) as Row | undefined;
  return row ? toAgent(row) : null;
}

export function upsertAgent(agent: AgentInput): Agent {
  const ts = now();
  db.prepare(
    `INSERT INTO agents (name, handle, description, command, args, resume_args, output, env, timeout_minutes,
       open_pull_request, expose_github_token, enabled, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET handle = excluded.handle, description = excluded.description,
       command = excluded.command, args = excluded.args, resume_args = excluded.resume_args,
       output = excluded.output, env = excluded.env, timeout_minutes = excluded.timeout_minutes,
       open_pull_request = excluded.open_pull_request, expose_github_token = excluded.expose_github_token,
       enabled = excluded.enabled, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(
    agent.name,
    agent.handle,
    agent.description,
    agent.command,
    JSON.stringify(agent.args),
    JSON.stringify(agent.resumeArgs),
    agent.output,
    JSON.stringify(agent.env),
    agent.timeoutMinutes,
    agent.openPullRequest ? 1 : 0,
    agent.exposeGithubToken ? 1 : 0,
    agent.enabled ? 1 : 0,
    agent.source,
    ts,
    ts,
  );
  return getAgent(agent.name)!;
}

export function setAgentEnabled(name: string, enabled: boolean): void {
  db.prepare("UPDATE agents SET enabled = ?, updated_at = ? WHERE name = ?").run(enabled ? 1 : 0, now(), name);
}

export function deleteAgent(name: string): void {
  db.prepare("DELETE FROM agents WHERE name = ?").run(name);
}

// ---------- tasks ----------

function toTask(row: Row): Task {
  return {
    id: Number(row.id),
    agent: String(row.agent),
    installationId: Number(row.installation_id),
    owner: String(row.owner),
    repo: String(row.repo),
    threadKind: String(row.thread_kind) as ThreadKind,
    threadNumber: Number(row.thread_number),
    threadTitle: String(row.thread_title),
    threadUrl: String(row.thread_url),
    triggerKind: String(row.trigger_kind) as Task["triggerKind"],
    requestedBy: String(row.requested_by),
    requestText: String(row.request_text),
    requestUrl: String(row.request_url),
    status: String(row.status) as TaskStatus,
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    progressCommentId: (row.progress_comment_id as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
    baseBranch: (row.base_branch as string | null) ?? null,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    prUrl: (row.pr_url as string | null) ?? null,
    prompt: (row.prompt as string | null) ?? null,
    resultText: (row.result_text as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    sessionId: (row.session_id as string | null) ?? null,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    commits: row.commits === null ? null : Number(row.commits),
    retryOf: row.retry_of === null ? null : Number(row.retry_of),
    forgotten: Boolean(row.forgotten),
  };
}

export interface NewTask {
  agent: string;
  installationId: number;
  owner: string;
  repo: string;
  threadKind: ThreadKind;
  threadNumber: number;
  threadTitle: string;
  threadUrl: string;
  triggerKind: Task["triggerKind"];
  requestedBy: string;
  requestText: string;
  requestUrl: string;
  retryOf?: number | null;
}

export function createTask(input: NewTask): Task {
  const result = db
    .prepare(
      `INSERT INTO tasks (agent, installation_id, owner, repo, thread_kind, thread_number, thread_title, thread_url,
         trigger_kind, requested_by, request_text, request_url, status, created_at, retry_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      input.agent,
      input.installationId,
      input.owner,
      input.repo,
      input.threadKind,
      input.threadNumber,
      input.threadTitle,
      input.threadUrl,
      input.triggerKind,
      input.requestedBy,
      input.requestText,
      input.requestUrl,
      now(),
      input.retryOf ?? null,
    );
  return getTask(Number(result.lastInsertRowid))!;
}

export function getTask(id: number): Task | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
  return row ? toTask(row) : null;
}

const TASK_COLUMNS: Record<string, string> = {
  status: "status",
  startedAt: "started_at",
  finishedAt: "finished_at",
  progressCommentId: "progress_comment_id",
  branch: "branch",
  baseBranch: "base_branch",
  prNumber: "pr_number",
  prUrl: "pr_url",
  prompt: "prompt",
  resultText: "result_text",
  error: "error",
  exitCode: "exit_code",
  sessionId: "session_id",
  costUsd: "cost_usd",
  commits: "commits",
  threadTitle: "thread_title",
  threadUrl: "thread_url",
  requestText: "request_text",
  forgotten: "forgotten",
};

export function updateTask(id: number, patch: Partial<Task>): Task {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = TASK_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : ((value ?? null) as SQLInputValue));
  }
  if (sets.length) db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  return getTask(id)!;
}

export interface TaskFilter {
  status?: string;
  agent?: string;
  repo?: string;
  limit?: number;
  beforeId?: number;
}

export function listTasks(filter: TaskFilter = {}): Task[] {
  const where: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.status) {
    const statuses = filter.status.split(",");
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    values.push(...statuses);
  }
  if (filter.agent) {
    where.push("agent = ?");
    values.push(filter.agent);
  }
  if (filter.repo) {
    const [owner, repo] = filter.repo.split("/");
    where.push("owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE");
    values.push(owner ?? "", repo ?? "");
  }
  if (filter.beforeId) {
    where.push("id < ?");
    values.push(filter.beforeId);
  }
  const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  return (db.prepare(sql).all(...values, Math.min(filter.limit ?? 50, 500)) as Row[]).map(toTask);
}

export function queuedTasks(): Task[] {
  return (db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY id").all() as Row[]).map(toTask);
}

export function tasksWithStatus(status: TaskStatus): Task[] {
  return (db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY id").all(status) as Row[]).map(toTask);
}

/** Tasks of one agent on one thread, plus threads linked to it (issue <-> PR), oldest first. */
export function threadHistory(ref: ThreadRef, agent: string, excludeTaskId?: number): Task[] {
  const threads = [ref, ...linkedThreads(ref)];
  const clauses = threads.map(() => "(thread_kind = ? AND thread_number = ?)").join(" OR ");
  const values: SQLInputValue[] = [ref.owner, ref.repo, agent];
  for (const thread of threads) values.push(thread.kind, thread.number);
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND agent = ?
         AND (${clauses}) AND status IN ('succeeded', 'failed', 'cancelled') AND forgotten = 0 AND id != ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...values, excludeTaskId ?? -1, config.historyLimit) as Row[];
  return rows.map(toTask).reverse();
}

export function recentTaskForThread(ref: ThreadRef, agent: string, withinSeconds: number): Task | null {
  const since = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT * FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND thread_kind = ?
         AND thread_number = ? AND agent = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`,
    )
    .get(ref.owner, ref.repo, ref.kind, ref.number, agent, since) as Row | undefined;
  return row ? toTask(row) : null;
}

export function queuedTaskForThread(ref: ThreadRef, agent: string): Task | null {
  const row = db
    .prepare(
      `SELECT * FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND thread_kind = ?
         AND thread_number = ? AND agent = ? AND status = 'queued' LIMIT 1`,
    )
    .get(ref.owner, ref.repo, ref.kind, ref.number, agent) as Row | undefined;
  return row ? toTask(row) : null;
}

export function lastSessionId(ref: ThreadRef, agent: string): string | null {
  const row = db
    .prepare(
      `SELECT session_id FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND thread_kind = ?
         AND thread_number = ? AND agent = ? AND session_id IS NOT NULL AND forgotten = 0
         AND status IN ('succeeded', 'failed') ORDER BY id DESC LIMIT 1`,
    )
    .get(ref.owner, ref.repo, ref.kind, ref.number, agent) as Row | undefined;
  return row ? String(row.session_id) : null;
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

export function listThreads(limit = 100): ThreadSummary[] {
  const rows = db
    .prepare(
      `SELECT owner, repo, thread_kind, thread_number, MAX(thread_title) AS thread_title, MAX(thread_url) AS thread_url,
         GROUP_CONCAT(DISTINCT agent) AS agents, COUNT(*) AS task_count, MAX(created_at) AS last_activity
       FROM tasks GROUP BY owner, repo, thread_kind, thread_number ORDER BY last_activity DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map((row) => ({
    owner: String(row.owner),
    repo: String(row.repo),
    threadKind: String(row.thread_kind) as ThreadKind,
    threadNumber: Number(row.thread_number),
    threadTitle: String(row.thread_title),
    threadUrl: String(row.thread_url),
    agents: String(row.agents ?? "").split(",").filter(Boolean),
    taskCount: Number(row.task_count),
    lastActivity: String(row.last_activity),
  }));
}

export function tasksForThread(ref: ThreadRef): Task[] {
  return (
    db
      .prepare(
        `SELECT * FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND thread_kind = ?
           AND thread_number = ? ORDER BY id`,
      )
      .all(ref.owner, ref.repo, ref.kind, ref.number) as Row[]
  ).map(toTask);
}

export function setForgotten(ref: ThreadRef, agent: string | null, forgotten: boolean): void {
  db.prepare(
    `UPDATE tasks SET forgotten = ? WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND thread_kind = ?
       AND thread_number = ? AND (? IS NULL OR agent = ?)`,
  ).run(forgotten ? 1 : 0, ref.owner, ref.repo, ref.kind, ref.number, agent, agent);
}

export function taskStats(): Record<string, Record<TaskStatus, number>> {
  const rows = db.prepare("SELECT agent, status, COUNT(*) AS n FROM tasks GROUP BY agent, status").all() as Row[];
  const stats: Record<string, Record<TaskStatus, number>> = {};
  for (const row of rows) {
    const agent = String(row.agent);
    stats[agent] ??= { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    stats[agent][String(row.status) as TaskStatus] = Number(row.n);
  }
  return stats;
}

// ---------- events ----------

export function addEvent(taskId: number, kind: EventKind, message: string): TaskEvent {
  const ts = now();
  const result = db
    .prepare("INSERT INTO task_events (task_id, ts, kind, message) VALUES (?, ?, ?, ?)")
    .run(taskId, ts, kind, message.slice(0, 8000));
  return { id: Number(result.lastInsertRowid), taskId, ts, kind, message };
}

export function listEvents(taskId: number, afterId = 0, limit = 2000): TaskEvent[] {
  const rows = db
    .prepare("SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?")
    .all(taskId, afterId, limit) as Row[];
  return rows.map((row) => ({
    id: Number(row.id),
    taskId: Number(row.task_id),
    ts: String(row.ts),
    kind: String(row.kind) as EventKind,
    message: String(row.message),
  }));
}

// ---------- thread links ----------

export function linkThreads(owner: string, repo: string, a: { kind: ThreadKind; number: number }, b: { kind: ThreadKind; number: number }): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO thread_links (owner, repo, from_kind, from_number, to_kind, to_number) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(owner, repo, a.kind, a.number, b.kind, b.number);
  stmt.run(owner, repo, b.kind, b.number, a.kind, a.number);
}

export function linkedThreads(ref: ThreadRef): ThreadRef[] {
  const rows = db
    .prepare(
      `SELECT to_kind, to_number FROM thread_links WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE
         AND from_kind = ? AND from_number = ?`,
    )
    .all(ref.owner, ref.repo, ref.kind, ref.number) as Row[];
  return rows.map((row) => ({ owner: ref.owner, repo: ref.repo, kind: String(row.to_kind) as ThreadKind, number: Number(row.to_number) }));
}

// ---------- deliveries ----------

export function recordDelivery(entry: Omit<Delivery, "id" | "ts">): Delivery {
  const ts = now();
  const result = db
    .prepare(
      "INSERT INTO deliveries (delivery_id, event, action, repo, sender, decision, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(entry.deliveryId, entry.event, entry.action, entry.repo, entry.sender, entry.decision, entry.detail.slice(0, 2000), ts);
  db.prepare("DELETE FROM deliveries WHERE id <= ?").run(Number(result.lastInsertRowid) - 2000);
  return { ...entry, id: Number(result.lastInsertRowid), ts };
}

export function listDeliveries(limit = 200): Delivery[] {
  const rows = db.prepare("SELECT * FROM deliveries ORDER BY id DESC LIMIT ?").all(limit) as Row[];
  return rows.map((row) => ({
    id: Number(row.id),
    deliveryId: String(row.delivery_id),
    event: String(row.event),
    action: String(row.action),
    repo: String(row.repo),
    sender: String(row.sender),
    decision: String(row.decision) as Delivery["decision"],
    detail: String(row.detail),
    ts: String(row.ts),
  }));
}

// ---------- settings & sessions ----------

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  return row ? String(row.value) : null;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function createSession(id: string, login: string, ttlHours: number): void {
  const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  db.prepare("INSERT INTO sessions (id, login, expires_at) VALUES (?, ?, ?)").run(id, login, expires);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
}

export function getSession(id: string): { login: string } | null {
  const row = db.prepare("SELECT login FROM sessions WHERE id = ? AND expires_at > ?").get(id, now()) as Row | undefined;
  return row ? { login: String(row.login) } : null;
}

export function deleteSession(id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}
