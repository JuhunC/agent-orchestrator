import { bus } from "../bus.ts";
import { randomUUID } from "node:crypto";
import {
  activeBoardTasks,
  activeTaskCounts,
  addHandoff,
  boardItemCost,
  claimRound,
  createTask,
  getBoardItem,
  getTask,
  lastTaskIds,
  listVotes,
  saveBoardItem,
  tasksInRound,
  type BoardItemRow,
} from "../db.ts";
import { findInstallation, findOwnerInstallation, GitHubOctokit, installationClient, type GitHubClient } from "../github/app.ts";
import { getProjectItem, listProjectItems, resolveProject, setItemStatus, type ProjectInfo, type ProjectItem } from "../github/projects.ts";
import { postComment } from "../github/threads.ts";
import { errorMessage, log } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { scheduler } from "../runner/scheduler.ts";
import type { Profile } from "../profiles/types.ts";
import { loadBoards, type Board, type BoardColumn } from "./loader.ts";

/** Live state of each board, for the admin UI. */
export interface BoardStatus {
  project: { title: string; url: string; columns: string[] } | null;
  lastSyncAt: string | null;
  error: string | null;
}

const statuses = new Map<string, BoardStatus>();
const projects = new Map<string, { info: ProjectInfo; gh: GitHubClient; at: number }>();
const baselined = new Set<string>();

export function boardStatus(name: string): BoardStatus {
  return statuses.get(name) ?? { project: null, lastSyncAt: null, error: null };
}

function setStatus(name: string, patch: Partial<BoardStatus>): void {
  statuses.set(name, { ...boardStatus(name), ...patch });
  bus.publish({ type: "boards" });
}

/** The board's project, resolved through the installation on the project's owner (cached 10 minutes). */
async function project(board: Board): Promise<{ info: ProjectInfo; gh: GitHubClient }> {
  const key = `${board.owner}/${board.projectNumber}/${board.statusField}`;
  const cached = projects.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
  // A board can use its own token (e.g. a user-owned project, which GitHub Apps can't reach).
  const token = board.tokenEnv ? process.env[board.tokenEnv] : undefined;
  const gh = token ? (new GitHubOctokit({ auth: token }) as GitHubClient) : await installationClient(await findOwnerInstallation(board.owner));
  const info = await resolveProject(gh, board.owner, board.projectNumber, board.statusField);
  const entry = { info, gh, at: Date.now() };
  projects.set(key, entry);
  setStatus(board.name, { project: { title: info.title, url: info.url, columns: info.options.map((option) => option.name) }, error: null });
  for (const column of Object.keys(board.columns)) {
    if (!info.options.some((option) => option.name.toLowerCase() === column.toLowerCase())) {
      setStatus(board.name, { error: `The project has no "${column}" column` });
    }
  }
  return entry;
}

function rowFor(board: Board, item: ProjectItem, previous: BoardItemRow | null): Omit<BoardItemRow, "updatedAt"> {
  return {
    board: board.name,
    itemId: item.itemId,
    owner: item.owner,
    repo: item.repo,
    kind: item.kind ?? "issue",
    number: item.number,
    title: item.title,
    status: item.status,
    moves: previous?.moves ?? 0,
    entries: previous?.entries ?? {},
  };
}

/**
 * A card was seen in a column. If it moved, stop agents working on it in another column, and
 * start the agent of the column it's in now.
 */
export async function observe(board: Board, item: ProjectItem, options: { excludeTaskId?: number; trigger?: boolean } = {}): Promise<void> {
  if (!item.kind || !item.repo) return; // draft issues have nothing to work on
  const previous = getBoardItem(board.name, item.itemId);
  if (previous && previous.status === item.status) return;
  saveBoardItem(rowFor(board, item, previous));
  bus.publish({ type: "boards" });

  for (const task of activeBoardTasks(board.name, item.itemId)) {
    if (task.id === options.excludeTaskId || task.boardColumn === item.status) continue;
    const onStart = task.boardColumn ? board.columns[task.boardColumn]?.onStart : null;
    if (onStart && onStart === item.status) continue;
    log.info("Card moved away from the agent's column; stopping it", { task: task.id, to: item.status });
    scheduler.cancel(task.id, `The card was moved to "${item.status}" while the agent was working on it.`);
  }
  if (options.trigger !== false && item.status) await startColumnAgent(board, item.itemId);
}

/** Starts the agent mapped to the card's current column, unless a guard says to escalate instead. */
/** Which agents may take a card in this column: enabled, valid, and routed by label in `label` mode. */
async function candidatesFor(board: Board, column: BoardColumn, row: BoardItemRow): Promise<Profile[]> {
  const profiles = loadProfiles().agents.filter((profile) => profile.enabled && !profile.errors.length);
  let names = column.agents;
  if (column.mode === "label") {
    const gh = await installationClient(await findInstallation(row.owner, row.repo));
    const { data } = await gh.rest.issues.get({ owner: row.owner, repo: row.repo, issue_number: row.number });
    const labels = data.labels.map((label) => (typeof label === "string" ? label : (label.name ?? "")).toLowerCase());
    names = column.routes.find((route) => labels.includes(route.label.toLowerCase()))?.agents ?? column.routeDefault;
  }
  return names.map((name) => profiles.find((profile) => profile.name === name)).filter((profile): profile is Profile => Boolean(profile));
}

/** The least busy agent (relative to its replicas), rotating on ties. */
function leastBusy(candidates: Profile[]): Profile {
  const active = activeTaskCounts();
  const last = lastTaskIds();
  return [...candidates].sort((a, b) => {
    const load = (profile: Profile) => (active[profile.name] ?? 0) / (profile.replicas ?? 1);
    return load(a) - load(b) || (last[a.name] ?? 0) - (last[b.name] ?? 0) || a.name.localeCompare(b.name);
  })[0]!;
}

/** Starts the column's agent(s) for the card, unless a guard says to escalate instead. */
async function startColumnAgent(board: Board, itemId: string): Promise<void> {
  const row = getBoardItem(board.name, itemId);
  const column = row?.status ? board.columns[row.status] : undefined;
  if (!row || !column?.agents.length || board.errors.length) return;
  if (activeBoardTasks(board.name, itemId).some((task) => task.boardColumn === column.name)) return;
  const candidates = await candidatesFor(board, column, row);
  if (!candidates.length) {
    log.info("No available agent for the card's column", { board: board.name, column: column.name });
    return;
  }

  const entries = (row.entries[column.name] ?? 0) + 1;
  const cost = boardItemCost(board.name, itemId);
  const guard =
    entries > board.limits.entriesPerColumn
      ? `it entered "${column.name}" ${entries} times`
      : board.limits.budgetUsdPerIssue !== null && cost >= board.limits.budgetUsdPerIssue
        ? `agents already spent $${cost.toFixed(2)} on it (limit $${board.limits.budgetUsdPerIssue})`
        : null;
  if (guard) {
    await escalate(board, row, `Stopped the agents on this card because ${guard}.`);
    return;
  }
  saveBoardItem({ ...row, entries: { ...row.entries, [column.name]: entries } });

  // "all": every agent works the card at once, then they vote where it goes. Otherwise one agent.
  const chosen = column.mode === "all" ? candidates : [leastBusy(candidates)];
  const round = column.mode === "all" ? `${board.name}:${itemId}:${column.name}:${randomUUID()}` : null;
  const installationId = await findInstallation(row.owner, row.repo);
  for (const profile of chosen) {
    const task = createTask({
      agent: profile.name,
      installationId,
      owner: row.owner,
      repo: row.repo,
      threadKind: row.kind,
      threadNumber: row.number,
      threadTitle: row.title,
      threadUrl: "",
      triggerKind: "board",
      requestedBy: "project board",
      requestText: `The card is in the "${column.name}" column of the ${board.name} board. Do this column's work (see your role below), then move the card on.`,
      requestUrl: "",
      board: board.name,
      boardColumn: column.name,
      boardItemId: itemId,
      boardRound: round,
    });
    bus.publish({ type: "task", task });
    log.info("Board started an agent", { board: board.name, column: column.name, agent: profile.name, task: task.id, mode: column.mode });
  }
  scheduler.kick();
}

/**
 * Called when any board task ends. For "all" columns, once every agent in the round is done,
 * the votes decide where the card goes: needs-human wins, then sending it back (the earliest
 * column), then the most common choice. If an agent failed or didn't vote, the card stays.
 */
export async function boardTaskSettled(taskId: number): Promise<void> {
  const task = getTask(taskId);
  if (!task?.board || !task.boardRound || !task.boardItemId) return;
  const tasks = tasksInRound(task.boardRound);
  if (tasks.some((member) => member.status === "queued" || member.status === "running")) return;
  if (!claimRound(task.boardRound)) return;
  const board = loadBoards().boards.find((candidate) => candidate.name === task.board);
  const row = getBoardItem(task.board, task.boardItemId);
  if (!board || !row || row.status !== task.boardColumn) return;
  const votes = listVotes(task.boardRound);
  const missing = tasks.filter((member) => member.status !== "succeeded" || !votes.some((vote) => vote.taskId === member.id));
  const gh = await installationClient(task.installationId);
  const target = { owner: row.owner, repo: row.repo, kind: row.kind, number: row.number };
  if (missing.length || !votes.length) {
    const who = missing.map((member) => `${member.agent} (${member.status === "succeeded" ? "didn't move the card" : member.status})`).join(", ");
    await postComment(gh, target, `The agents in **${task.boardColumn}** didn't all finish: ${who}. The card stays here for a person to decide.`).catch(() => undefined);
    return;
  }
  const order = Object.keys(board.columns);
  const position = (name: string) => (order.indexOf(name) === -1 ? Number.MAX_SAFE_INTEGER : order.indexOf(name));
  const current = position(task.boardColumn!);
  let to: string;
  if (board.needsHuman && votes.some((vote) => vote.to === board.needsHuman)) to = board.needsHuman;
  else if (votes.some((vote) => position(vote.to) < current)) to = votes.filter((vote) => position(vote.to) < current).sort((a, b) => position(a.to) - position(b.to))[0]!.to;
  else {
    const counts = new Map<string, number>();
    for (const vote of votes) counts.set(vote.to, (counts.get(vote.to) ?? 0) + 1);
    to = [...counts.entries()].sort((a, b) => b[1] - a[1] || position(a[0]) - position(b[0]))[0]![0];
  }
  for (const vote of votes) addHandoff(board.name, row.itemId, { taskId: vote.taskId, agent: vote.agent, fromColumn: task.boardColumn!, toColumn: vote.to, note: vote.note });
  const summary = votes.map((vote) => `- **${vote.agent}** → ${vote.to}`).join("\n");
  await postComment(gh, target, `All agents in **${task.boardColumn}** finished. Moving the card to **${to}**.\n\n${summary}`).catch(() => undefined);
  await moveCard(board, row.itemId, to, { agentMove: true }).catch((error) => log.warn("Could not move the card", { error: errorMessage(error) }));
}

/** Moves a card for an agent (or a guard), then reacts to the new column like any other move. */
export async function moveCard(board: Board, itemId: string, to: string, options: { excludeTaskId?: number; agentMove: boolean; trigger?: boolean }): Promise<string> {
  const row = getBoardItem(board.name, itemId);
  if (!row) throw new Error("This card isn't known to the board");
  let target = to;
  if (options.agentMove && row.moves + 1 > board.limits.movesPerIssue) {
    if (!board.needsHuman) throw new Error(`Agents have moved this card ${row.moves} times, the board's limit`);
    target = board.needsHuman;
  }
  const { info, gh } = await project(board);
  // Record first, so the webhook GitHub sends for our own move is recognised as already handled.
  saveBoardItem({ ...row, status: target, moves: row.moves + (options.agentMove ? 1 : 0) });
  try {
    await setItemStatus(gh, info, itemId, target);
  } catch (error) {
    saveBoardItem(row);
    throw error;
  }
  bus.publish({ type: "boards" });
  if (target !== to) {
    await postComment(gh, { owner: row.owner, repo: row.repo, kind: row.kind, number: row.number }, `Moved to **${target}** instead of ${to}: agents have moved this card ${row.moves + 1} times, the limit for the ${board.name} board.`).catch(() => undefined);
  }
  const moved = getBoardItem(board.name, itemId)!;
  if (options.trigger !== false) {
    // Our own move: stop agents left in other columns, then start the next column's agent.
    for (const task of activeBoardTasks(board.name, itemId)) {
      if (task.id !== options.excludeTaskId && task.boardColumn !== target) scheduler.cancel(task.id, `The card moved to "${target}".`);
    }
    await startColumnAgent(board, moved.itemId);
  }
  return target;
}

async function escalate(board: Board, row: BoardItemRow, reason: string): Promise<void> {
  log.warn("Board loop guard tripped", { board: board.name, item: row.itemId, reason });
  try {
    const { gh } = await project(board);
    if (board.needsHuman && row.status !== board.needsHuman) await moveCard(board, row.itemId, board.needsHuman, { agentMove: false, trigger: false });
    await postComment(gh, { owner: row.owner, repo: row.repo, kind: row.kind, number: row.number }, `${reason}${board.needsHuman ? ` Moved it to **${board.needsHuman}** for a person to look at.` : ""}`);
  } catch (error) {
    log.warn("Could not escalate the card", { error: errorMessage(error) });
  }
}

// ---------- webhooks and polling ----------

/** `projects_v2_item` webhooks (organization projects only). */
export async function handleProjectItemWebhook(payload: Record<string, any>): Promise<string> {
  const item = payload.projects_v2_item;
  if (!item?.node_id) return "No project item in payload";
  if (payload.action !== "edited" && payload.action !== "created" && payload.action !== "restored") return `Ignored ${payload.action}`;
  const boards = loadBoards().boards;
  const results: string[] = [];
  for (const board of boards) {
    try {
      const { info, gh } = await project(board);
      if (info.id !== item.project_node_id) continue;
      const fieldId = payload.changes?.field_value?.field_node_id;
      if (payload.action === "edited" && fieldId && fieldId !== info.fieldId) {
        results.push(`${board.name}: another field changed`);
        continue;
      }
      const current = await getProjectItem(gh, item.node_id, board.statusField);
      if (!current) continue;
      await observe(board, current);
      results.push(`${board.name}: card in ${current.status ?? "no column"}`);
    } catch (error) {
      setStatus(board.name, { error: errorMessage(error) });
      results.push(`${board.name}: ${errorMessage(error)}`);
    }
  }
  return results.join("; ") || "No board watches this project";
}

/** Reads every card on the board. The first pass only records where cards are. */
export async function syncBoard(board: Board): Promise<void> {
  try {
    const { info, gh } = await project(board);
    const items = await listProjectItems(gh, info.id, board.statusField);
    const firstPass = !baselined.has(board.name);
    for (const item of items) {
      const known = getBoardItem(board.name, item.itemId);
      if (firstPass && !known) {
        if (item.kind && item.repo) saveBoardItem(rowFor(board, item, null));
        continue;
      }
      await observe(board, item);
    }
    baselined.add(board.name);
    setStatus(board.name, { lastSyncAt: new Date().toISOString() });
  } catch (error) {
    setStatus(board.name, { error: errorMessage(error) });
    log.warn("Board sync failed", { board: board.name, error: errorMessage(error) });
  }
}

let timer: NodeJS.Timeout | null = null;
const lastPoll = new Map<string, number>();

/** Polls each board every `poll_seconds` (webhooks only exist for organization projects). */
export function startBoards(): void {
  if (timer) return;
  const tick = async () => {
    for (const board of loadBoards().boards) {
      if (board.errors.length || board.pollSeconds <= 0) continue;
      if (Date.now() - (lastPoll.get(board.name) ?? 0) < board.pollSeconds * 1000) continue;
      lastPoll.set(board.name, Date.now());
      await syncBoard(board);
    }
  };
  timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
}

export function forgetProjectCache(): void {
  projects.clear();
}
