import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";
import type { Delivery, EventKind, Task, TaskEvent, TaskStatus, TaskUsage, ThreadKind, ThreadRef } from "./types.ts";

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

function addColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((existing) => existing.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("tasks", "retry_at", "TEXT");
addColumn("tasks", "attempts", "INTEGER NOT NULL DEFAULT 0");
addColumn("tasks", "start_sha", "TEXT");
addColumn("tasks", "live", "INTEGER NOT NULL DEFAULT 0");
addColumn("tasks", "board", "TEXT");
addColumn("tasks", "board_column", "TEXT");
addColumn("tasks", "board_item_id", "TEXT");
addColumn("tasks", "board_round", "TEXT");
addColumn("tasks", "usage", "TEXT");
addColumn("tasks", "started_by_task", "INTEGER");
// Dry runs replay a task without changing anything on GitHub (see run-task.ts).
addColumn("tasks", "dry_run", "INTEGER NOT NULL DEFAULT 0");
addColumn("tasks", "restarts", "INTEGER NOT NULL DEFAULT 0");
db.exec("CREATE INDEX IF NOT EXISTS deliveries_delivery_id ON deliveries (delivery_id)");
// Time-range queries (spending, usage, outcomes) use exactly this expression, so it's indexed.
db.exec("CREATE INDEX IF NOT EXISTS tasks_ended ON tasks (COALESCE(finished_at, started_at, created_at))");
db.exec(`CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  task_id INTEGER,
  url TEXT,
  ts TEXT NOT NULL
)`);
db.exec(`
CREATE TABLE IF NOT EXISTS board_items (
  board TEXT NOT NULL,
  item_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT,
  moves INTEGER NOT NULL DEFAULT 0,
  entries TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board, item_id)
);
CREATE TABLE IF NOT EXISTS board_votes (
  round TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  to_column TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY (round, task_id)
);
CREATE TABLE IF NOT EXISTS board_rounds (
  round TEXT PRIMARY KEY,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS board_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT NOT NULL,
  item_id TEXT NOT NULL,
  task_id INTEGER,
  agent TEXT NOT NULL,
  from_column TEXT NOT NULL,
  to_column TEXT NOT NULL,
  note TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_handoffs_into ON board_handoffs (to_column, ts);
`);
addColumn("board_items", "fields", "TEXT NOT NULL DEFAULT '{}'");

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
    usage: json<TaskUsage | null>(row.usage, null),
    commits: row.commits === null ? null : Number(row.commits),
    retryOf: row.retry_of === null ? null : Number(row.retry_of),
    forgotten: Boolean(row.forgotten),
    retryAt: (row.retry_at as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
    startSha: (row.start_sha as string | null) ?? null,
    live: Boolean(row.live),
    board: (row.board as string | null) ?? null,
    boardColumn: (row.board_column as string | null) ?? null,
    boardItemId: (row.board_item_id as string | null) ?? null,
    boardRound: (row.board_round as string | null) ?? null,
    startedByTask: row.started_by_task === null || row.started_by_task === undefined ? null : Number(row.started_by_task),
    dryRun: Boolean(row.dry_run),
    restarts: Number(row.restarts ?? 0),
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
  board?: string | null;
  boardColumn?: string | null;
  boardItemId?: string | null;
  boardRound?: string | null;
  startedByTask?: number | null;
  dryRun?: boolean;
}

export function createTask(input: NewTask): Task {
  const result = db
    .prepare(
      `INSERT INTO tasks (agent, installation_id, owner, repo, thread_kind, thread_number, thread_title, thread_url,
         trigger_kind, requested_by, request_text, request_url, status, created_at, retry_of, board, board_column, board_item_id, board_round, started_by_task, dry_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.board ?? null,
      input.boardColumn ?? null,
      input.boardItemId ?? null,
      input.boardRound ?? null,
      input.startedByTask ?? null,
      input.dryRun ? 1 : 0,
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
  usage: "usage",
  commits: "commits",
  threadTitle: "thread_title",
  threadUrl: "thread_url",
  requestText: "request_text",
  forgotten: "forgotten",
  retryAt: "retry_at",
  attempts: "attempts",
  startSha: "start_sha",
  live: "live",
  board: "board",
  boardColumn: "board_column",
  boardItemId: "board_item_id",
  boardRound: "board_round",
  startedByTask: "started_by_task",
  restarts: "restarts",
};

export function updateTask(id: number, patch: Partial<Task>): Task {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = TASK_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value && typeof value === "object" ? JSON.stringify(value) : ((value ?? null) as SQLInputValue));
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
         AND (${clauses}) AND status IN ('succeeded', 'failed', 'cancelled') AND forgotten = 0 AND dry_run = 0 AND id != ?
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
         AND thread_number = ? AND agent = ? AND created_at >= ? AND dry_run = 0 ORDER BY id DESC LIMIT 1`,
    )
    .get(ref.owner, ref.repo, ref.kind, ref.number, agent, since) as Row | undefined;
  return row ? toTask(row) : null;
}

export function queuedTaskForThread(ref: ThreadRef, agent: string): Task | null {
  const row = db
    .prepare(
      `SELECT * FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND thread_kind = ?
         AND thread_number = ? AND agent = ? AND status = 'queued' AND dry_run = 0 LIMIT 1`,
    )
    .get(ref.owner, ref.repo, ref.kind, ref.number, agent) as Row | undefined;
  return row ? toTask(row) : null;
}

/** Running tasks on a thread, plus tasks whose pull request this is (an agent working an issue opened it). */
export function runningTasksForThread(ref: ThreadRef): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND status = 'running' AND dry_run = 0
         AND ((thread_kind = ? AND thread_number = ?) OR (? = 'pull' AND pr_number = ?)) ORDER BY id`,
    )
    .all(ref.owner, ref.repo, ref.kind, ref.number, ref.kind, ref.number) as Row[];
  return rows.map(toTask);
}

export function lastSessionId(ref: ThreadRef, agent: string): string | null {
  const row = db
    .prepare(
      `SELECT session_id FROM tasks WHERE owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE AND thread_kind = ?
         AND thread_number = ? AND agent = ? AND session_id IS NOT NULL AND forgotten = 0 AND dry_run = 0
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
       FROM (SELECT * FROM tasks ORDER BY id DESC LIMIT 5000) GROUP BY owner, repo, thread_kind, thread_number ORDER BY last_activity DESC LIMIT ?`,
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

/** Did an earlier delivery with this id start or reach an agent? (GitHub redeliveries keep the id.) */
export function deliveryActedOn(deliveryId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM deliveries WHERE delivery_id = ? AND decision IN ('triggered', 'forwarded') LIMIT 1").get(deliveryId));
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

export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
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

// ---------- boards ----------

export interface BoardItemRow {
  board: string;
  itemId: string;
  owner: string;
  repo: string;
  kind: ThreadKind;
  number: number;
  title: string;
  status: string | null;
  moves: number;
  entries: Record<string, number>;
  /** The card's project field values (start/end dates, estimate) as last seen; kept apart from saveBoardItem. */
  fields?: CardFieldValues;
  updatedAt: string;
}

/** A card's planning fields in the GitHub Project: dates as YYYY-MM-DD, null when empty. */
export interface CardFieldValues {
  start?: string | null;
  end?: string | null;
  estimate?: number | null;
}

function toBoardItem(row: Row): BoardItemRow {
  return {
    board: String(row.board),
    itemId: String(row.item_id),
    owner: String(row.owner),
    repo: String(row.repo),
    kind: String(row.kind) as ThreadKind,
    number: Number(row.number),
    title: String(row.title),
    status: (row.status as string | null) ?? null,
    moves: Number(row.moves),
    entries: json(row.entries, {}),
    fields: json(row.fields, {}),
    updatedAt: String(row.updated_at),
  };
}

export function getBoardItem(board: string, itemId: string): BoardItemRow | null {
  const row = db.prepare("SELECT * FROM board_items WHERE board = ? AND item_id = ?").get(board, itemId) as Row | undefined;
  return row ? toBoardItem(row) : null;
}

export function listBoardItems(board: string): BoardItemRow[] {
  return (db.prepare("SELECT * FROM board_items WHERE board = ? ORDER BY updated_at DESC").all(board) as Row[]).map(toBoardItem);
}

/** Records a card's project field values (merged into what's known). */
export function saveBoardItemFields(board: string, itemId: string, fields: CardFieldValues): void {
  const current = getBoardItem(board, itemId);
  if (!current) return;
  db.prepare("UPDATE board_items SET fields = ? WHERE board = ? AND item_id = ?").run(JSON.stringify({ ...current.fields, ...fields }), board, itemId);
}

export function saveBoardItem(item: Omit<BoardItemRow, "updatedAt">): void {
  db.prepare(
    `INSERT INTO board_items (board, item_id, owner, repo, kind, number, title, status, moves, entries, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(board, item_id) DO UPDATE SET owner = excluded.owner, repo = excluded.repo, kind = excluded.kind,
       number = excluded.number, title = excluded.title, status = excluded.status, moves = excluded.moves,
       entries = excluded.entries, updated_at = excluded.updated_at`,
  ).run(item.board, item.itemId, item.owner, item.repo, item.kind, item.number, item.title, item.status, item.moves, JSON.stringify(item.entries), now());
}

export interface Handoff {
  id: number;
  taskId: number | null;
  agent: string;
  fromColumn: string;
  toColumn: string;
  note: string;
  ts: string;
}

export function addHandoff(board: string, itemId: string, handoff: Omit<Handoff, "id" | "ts">): void {
  db.prepare("INSERT INTO board_handoffs (board, item_id, task_id, agent, from_column, to_column, note, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    board,
    itemId,
    handoff.taskId,
    handoff.agent,
    handoff.fromColumn,
    handoff.toColumn,
    handoff.note.slice(0, 8000),
    now(),
  );
}

export function listHandoffs(board: string, itemId: string): Handoff[] {
  const rows = db.prepare("SELECT * FROM board_handoffs WHERE board = ? AND item_id = ? ORDER BY id").all(board, itemId) as Row[];
  return rows.map((row) => ({
    id: Number(row.id),
    taskId: row.task_id === null ? null : Number(row.task_id),
    agent: String(row.agent),
    fromColumn: String(row.from_column),
    toColumn: String(row.to_column),
    note: String(row.note),
    ts: String(row.ts),
  }));
}

/** One task's spend, for usage reports. */
export interface UsageRow {
  id: number;
  agent: string;
  owner: string;
  repo: string;
  threadKind: ThreadKind;
  threadNumber: number;
  threadTitle: string;
  status: TaskStatus;
  /** When it ran (finished, or started if it hasn't finished). */
  at: string;
  costUsd: number;
  usage: TaskUsage | null;
}

// ---------- outcomes: what became of agents' pull requests ----------

db.exec(`CREATE TABLE IF NOT EXISTS pull_outcomes (
  owner TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  agent TEXT NOT NULL,
  state TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  checked_at TEXT,
  PRIMARY KEY (owner, repo, number)
)`);
db.exec("CREATE INDEX IF NOT EXISTS pull_outcomes_opened ON pull_outcomes (opened_at)");

export interface PullOutcome {
  owner: string;
  repo: string;
  number: number;
  agent: string;
  state: "open" | "merged" | "closed";
  openedAt: string;
  closedAt: string | null;
  checkedAt: string | null;
}

const toOutcome = (row: Row): PullOutcome => ({
  owner: String(row.owner),
  repo: String(row.repo),
  number: Number(row.number),
  agent: String(row.agent),
  state: String(row.state) as PullOutcome["state"],
  openedAt: String(row.opened_at),
  closedAt: (row.closed_at as string | null) ?? null,
  checkedAt: (row.checked_at as string | null) ?? null,
});

/** An agent opened a pull request. */
export function recordPullOpened(owner: string, repo: string, number: number, agent: string, at = now()): void {
  db.prepare("INSERT OR IGNORE INTO pull_outcomes (owner, repo, number, agent, state, opened_at) VALUES (?, ?, ?, ?, 'open', ?)").run(owner, repo, number, agent, at);
}

/** A pull request agents opened was merged, closed or reopened. False when it isn't one of theirs. */
export function setPullState(owner: string, repo: string, number: number, state: PullOutcome["state"], at = now()): boolean {
  const result = db.prepare("UPDATE pull_outcomes SET state = ?, closed_at = ?, checked_at = ? WHERE owner = ? AND repo = ? AND number = ?").run(state, state === "open" ? null : at, now(), owner, repo, number);
  return Number(result.changes) > 0;
}

export function markPullChecked(owner: string, repo: string, number: number): void {
  db.prepare("UPDATE pull_outcomes SET checked_at = ? WHERE owner = ? AND repo = ? AND number = ?").run(now(), owner, repo, number);
}

/** Open ones not checked with GitHub since `before`, oldest check first. */
export function pullsToCheck(before: string, limit = 50): PullOutcome[] {
  return (db.prepare("SELECT * FROM pull_outcomes WHERE state = 'open' AND (checked_at IS NULL OR checked_at < ?) ORDER BY COALESCE(checked_at, '') LIMIT ?").all(before, limit) as Row[]).map(toOutcome);
}

/** Pull requests agents opened since `since`, for one agent or all. */
export function pullOutcomes(since: string, agent?: string): PullOutcome[] {
  return (db.prepare(`SELECT * FROM pull_outcomes WHERE opened_at >= ? ${agent ? "AND agent = ?" : ""}`).all(...(agent ? [since, agent] : [since])) as Row[]).map(toOutcome);
}

/** Agents' pull requests open in a repository. */
export function openAgentPullCount(owner: string, repo: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM pull_outcomes WHERE owner = ? AND repo = ? AND state = 'open'").get(owner, repo) as Row).count);
}

/** Does this thread already have an open pull request from an agent (so new work there updates it)? */
export function threadHasOpenAgentPull(ref: ThreadRef): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM pull_outcomes p JOIN tasks t ON t.owner = p.owner AND t.repo = p.repo AND t.pr_number = p.number
         WHERE t.owner = ? COLLATE NOCASE AND t.repo = ? COLLATE NOCASE AND t.thread_kind = ? AND t.thread_number = ? AND p.state = 'open' LIMIT 1`,
      )
      .get(ref.owner, ref.repo, ref.kind, ref.number),
  );
}

/** For /metrics: agents' pull requests by agent and state. */
export function pullStateCounts(): { agent: string; state: string; count: number }[] {
  return (db.prepare("SELECT agent, state, COUNT(*) AS count FROM pull_outcomes GROUP BY agent, state").all() as Row[]).map((row) => ({ agent: String(row.agent), state: String(row.state), count: Number(row.count) }));
}

/** Pull requests from tasks before outcomes were tracked: the first task that recorded each. */
export function backfillPullOutcomes(): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO pull_outcomes (owner, repo, number, agent, state, opened_at)
       SELECT owner, repo, pr_number, agent, 'open', MIN(COALESCE(finished_at, started_at, created_at)) FROM tasks
       WHERE pr_number IS NOT NULL GROUP BY owner, repo, pr_number`,
    )
    .run();
  return Number(result.changes);
}

/** Board handoffs into a column since `since`, per agent (e.g. how often each sent cards to needs-human). */
export function handoffsInto(column: string, since: string): Record<string, number> {
  const rows = db.prepare("SELECT agent, COUNT(*) AS count FROM board_handoffs WHERE to_column = ? AND ts >= ? GROUP BY agent").all(column, since) as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.agent), Number(row.count)]));
}

/** Tasks per agent and status since `since`, with how long they ran. */
export function taskOutcomes(since: string, agent?: string): { agent: string; status: string; count: number; minutes: number }[] {
  const rows = db
    .prepare(
      `SELECT agent, status, COUNT(*) AS count, COALESCE(SUM((julianday(finished_at) - julianday(started_at)) * 1440), 0) AS minutes
       FROM tasks WHERE COALESCE(finished_at, started_at, created_at) >= ? AND status IN ('succeeded', 'failed', 'cancelled') AND dry_run = 0 ${agent ? "AND agent = ?" : ""} GROUP BY agent, status`,
    )
    .all(...(agent ? [since, agent] : [since])) as Row[];
  return rows.map((row) => ({ agent: String(row.agent), status: String(row.status), count: Number(row.count), minutes: Number(row.minutes) }));
}

// ---------- audit log ----------

db.exec(`CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  status INTEGER NOT NULL,
  ts TEXT NOT NULL
)`);

export interface AuditRow {
  id: number;
  login: string;
  role: string;
  action: string;
  detail: string;
  status: number;
  ts: string;
}

export function addAudit(entry: Omit<AuditRow, "id" | "ts">): void {
  const result = db.prepare("INSERT INTO audit (login, role, action, detail, status, ts) VALUES (?, ?, ?, ?, ?, ?)").run(entry.login, entry.role, entry.action, entry.detail.slice(0, 2000), entry.status, now());
  db.prepare("DELETE FROM audit WHERE id <= ?").run(Number(result.lastInsertRowid) - 5000);
}

export function listAudit(limit = 100): AuditRow[] {
  return (db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((row) => ({
    id: Number(row.id),
    login: String(row.login),
    role: String(row.role),
    action: String(row.action),
    detail: String(row.detail),
    status: Number(row.status),
    ts: String(row.ts),
  }));
}

// ---------- incidents ----------

export interface IncidentRow {
  id: number;
  kind: string;
  severity: "info" | "warning" | "critical";
  message: string;
  taskId: number | null;
  url: string | null;
  ts: string;
}

const toIncident = (row: Row): IncidentRow => ({
  id: Number(row.id),
  kind: String(row.kind),
  severity: String(row.severity) as IncidentRow["severity"],
  message: String(row.message),
  taskId: row.task_id === null ? null : Number(row.task_id),
  url: (row.url as string | null) ?? null,
  ts: String(row.ts),
});

export function addIncident(entry: Omit<IncidentRow, "id" | "ts">): IncidentRow {
  const ts = now();
  const result = db.prepare("INSERT INTO incidents (kind, severity, message, task_id, url, ts) VALUES (?, ?, ?, ?, ?, ?)").run(entry.kind, entry.severity, entry.message.slice(0, 2000), entry.taskId, entry.url, ts);
  db.prepare("DELETE FROM incidents WHERE id <= ?").run(Number(result.lastInsertRowid) - 1000);
  return { ...entry, id: Number(result.lastInsertRowid), ts };
}

export function listIncidents(limit = 100, kind?: string): IncidentRow[] {
  const rows = (kind ? db.prepare("SELECT * FROM incidents WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit) : db.prepare("SELECT * FROM incidents ORDER BY id DESC LIMIT ?").all(limit)) as Row[];
  return rows.map(toIncident);
}

export function incidentCounts(): Record<string, number> {
  const rows = db.prepare("SELECT kind, COUNT(*) AS count FROM incidents GROUP BY kind").all() as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.kind), Number(row.count)]));
}

/** For /metrics: tasks by agent and status, with their cost and tokens. */
export function taskTotals(): { agent: string; status: string; count: number; costUsd: number }[] {
  const rows = db.prepare("SELECT agent, status, COUNT(*) AS count, COALESCE(SUM(cost_usd), 0) AS cost FROM tasks GROUP BY agent, status").all() as Row[];
  return rows.map((row) => ({ agent: String(row.agent), status: String(row.status), count: Number(row.count), costUsd: Number(row.cost) }));
}

/** For /metrics: tokens by agent. */
export function tokenTotals(): { agent: string; input: number; output: number; cacheRead: number; cacheWrite: number }[] {
  const rows = db
    .prepare(
      `SELECT agent, COALESCE(SUM(json_extract(usage, '$.inputTokens')), 0) AS input, COALESCE(SUM(json_extract(usage, '$.outputTokens')), 0) AS output,
         COALESCE(SUM(json_extract(usage, '$.cacheReadTokens')), 0) AS cache_read, COALESCE(SUM(json_extract(usage, '$.cacheWriteTokens')), 0) AS cache_write
       FROM tasks WHERE usage IS NOT NULL GROUP BY agent`,
    )
    .all() as Row[];
  return rows.map((row) => ({ agent: String(row.agent), input: Number(row.input), output: Number(row.output), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write) }));
}

/** For /metrics: webhook deliveries by decision (the last 2000 are kept). */
export function deliveryCounts(): Record<string, number> {
  const rows = db.prepare("SELECT decision, COUNT(*) AS count FROM deliveries GROUP BY decision").all() as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.decision), Number(row.count)]));
}

/** Tasks this one started (start_related_agent, or a card move that started a board stage). */
export function tasksStartedBy(id: number): Task[] {
  return (db.prepare("SELECT * FROM tasks WHERE started_by_task = ? ORDER BY id").all(id) as Row[]).map(toTask);
}

/**
 * Drops the bulky detail of tasks that finished before `before`: the prompt and the step-by-step
 * log. The task itself (request, reply, cost, tokens, branch, pull request) stays. Returns counts.
 */
export function pruneTaskDetail(before: string): { tasks: number; events: number } {
  const old = "SELECT id FROM tasks WHERE status IN ('succeeded', 'failed', 'cancelled') AND COALESCE(finished_at, started_at, created_at) < ?";
  const events = db.prepare(`DELETE FROM task_events WHERE task_id IN (${old})`).run(before);
  const tasks = db.prepare(`UPDATE tasks SET prompt = NULL WHERE prompt IS NOT NULL AND id IN (${old})`).run(before);
  return { tasks: Number(tasks.changes), events: Number(events.changes) };
}

/** Database size: pages in use and free (after deletes), in KB. */
export function databaseSize(): { kb: number; freeKb: number } {
  const page = Number((db.prepare("PRAGMA page_size").get() as Row).page_size);
  const pages = Number((db.prepare("PRAGMA page_count").get() as Row).page_count);
  const free = Number((db.prepare("PRAGMA freelist_count").get() as Row).freelist_count);
  return { kb: Math.round((page * pages) / 1024), freeKb: Math.round((page * free) / 1024) };
}

/** What each agent's tasks cost since `since`. */
export function spendByAgentSince(since: string): Record<string, number> {
  const rows = db.prepare("SELECT agent, COALESCE(SUM(cost_usd), 0) AS total FROM tasks WHERE COALESCE(finished_at, started_at, created_at) >= ? GROUP BY agent").all(since) as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.agent), Number(row.total)]));
}

/** What tasks cost since `since` (ISO time), by when they finished (or started). */
export function spendSince(since: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks WHERE COALESCE(finished_at, started_at, created_at) >= ?").get(since) as Row;
  return Number(row.total ?? 0);
}

/** Tasks that ran since `since` (ISO time), for one agent or all. */
export function usageRows(since: string, agent?: string): UsageRow[] {
  const rows = db
    .prepare(
      `SELECT id, agent, owner, repo, thread_kind, thread_number, thread_title, status, COALESCE(finished_at, started_at, created_at) AS at, cost_usd, usage
       FROM tasks WHERE COALESCE(finished_at, started_at, created_at) >= ? ${agent ? "AND agent = ?" : ""} AND (cost_usd IS NOT NULL OR usage IS NOT NULL)
       ORDER BY at`,
    )
    .all(...(agent ? [since, agent] : [since])) as Row[];
  return rows.map((row) => ({
    id: Number(row.id),
    agent: String(row.agent),
    owner: String(row.owner),
    repo: String(row.repo),
    threadKind: String(row.thread_kind) as ThreadKind,
    threadNumber: Number(row.thread_number),
    threadTitle: String(row.thread_title),
    status: String(row.status) as TaskStatus,
    at: String(row.at),
    costUsd: row.cost_usd === null ? 0 : Number(row.cost_usd),
    usage: json<TaskUsage | null>(row.usage, null),
  }));
}

/** Money spent by agents on one board card. */
export function boardItemCost(board: string, itemId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks WHERE board = ? AND board_item_id = ? AND dry_run = 0").get(board, itemId) as Row;
  return Number(row.total);
}

export function activeBoardTasks(board: string, itemId: string): Task[] {
  return (db.prepare("SELECT * FROM tasks WHERE board = ? AND board_item_id = ? AND status IN ('queued', 'running') AND dry_run = 0 ORDER BY id").all(board, itemId) as Row[]).map(toTask);
}

// ---------- "all" columns: several agents work one card, then vote where it goes ----------

export function tasksInRound(round: string): Task[] {
  return (db.prepare("SELECT * FROM tasks WHERE board_round = ? ORDER BY id").all(round) as Row[]).map(toTask);
}

export function addVote(round: string, vote: { taskId: number; agent: string; to: string; note: string }): void {
  db.prepare("INSERT OR REPLACE INTO board_votes (round, task_id, agent, to_column, note) VALUES (?, ?, ?, ?, ?)").run(round, vote.taskId, vote.agent, vote.to, vote.note.slice(0, 8000));
}

export function listVotes(round: string): { taskId: number; agent: string; to: string; note: string }[] {
  return (db.prepare("SELECT * FROM board_votes WHERE round = ? ORDER BY task_id").all(round) as Row[]).map((row) => ({
    taskId: Number(row.task_id),
    agent: String(row.agent),
    to: String(row.to_column),
    note: String(row.note),
  }));
}

/** Marks a round resolved; true only for the first caller, so a card moves once. */
export function claimRound(round: string): boolean {
  const result = db.prepare("INSERT OR IGNORE INTO board_rounds (round, resolved_at) VALUES (?, ?)").run(round, now());
  return Number(result.changes) > 0;
}

/** Active tasks per agent, to pick the least busy agent in a pool. */
export function activeTaskCounts(): Record<string, number> {
  const rows = db.prepare("SELECT agent, COUNT(*) AS n FROM tasks WHERE status IN ('queued', 'running') GROUP BY agent").all() as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.agent), Number(row.n)]));
}

/** Most recent task id per agent, to rotate ties fairly. */
export function lastTaskIds(): Record<string, number> {
  const rows = db.prepare("SELECT agent, MAX(id) AS id FROM tasks GROUP BY agent").all() as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.agent), Number(row.id)]));
}
