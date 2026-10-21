import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { config } from "../config.ts";
import { loadProfiles, parseEffort } from "../profiles/loader.ts";
import type { Effort, ProfileSet } from "../profiles/types.ts";

/** What happens when a card lands in one column of a project board. */
export interface BoardColumn {
  name: string;
  /** The agent profile that works cards here (its harness: tools, skills, MCP servers). */
  agent: string | null;
  /** What the agent does in this column: a library role name, or inline text. */
  roleName: string | null;
  role: string;
  model: string | null;
  effort: Effort | null;
  /** Column the card moves to when the agent starts (e.g. Ready → In progress). */
  onStart: string | null;
  /** Columns the agent may move the card to; "any" allows every column. */
  movesTo: string[] | "any";
}

export interface Board {
  name: string;
  file: string;
  owner: string;
  projectNumber: number;
  statusField: string;
  /** Where cards go when a loop guard trips. */
  needsHuman: string | null;
  pollSeconds: number;
  limits: { movesPerIssue: number; entriesPerColumn: number; budgetUsdPerIssue: number | null };
  columns: Record<string, BoardColumn>;
  errors: string[];
}

function list(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function loadBoard(file: string, profiles: ProfileSet): Board {
  const name = basename(file).replace(/\.ya?ml$/, "");
  const errors: string[] = [];
  const data = (parse(readFileSync(file, "utf8")) ?? {}) as Record<string, any>;
  const project = String(data.project ?? "");
  const match = project.match(/^([\w.-]+)\/(\d+)$/);
  if (!match) errors.push(`"project" must look like owner/number (got "${project}")`);
  const columns: Record<string, BoardColumn> = {};
  const rawColumns = (data.columns ?? {}) as Record<string, Record<string, unknown> | null>;
  if (!Object.keys(rawColumns).length) errors.push("Add at least one column under \"columns\"");

  for (const [columnName, raw] of Object.entries(rawColumns)) {
    const column = raw ?? {};
    const agent = column.agent ? String(column.agent) : null;
    if (agent && !profiles.agents.some((profile) => profile.name === agent)) errors.push(`${columnName}: unknown agent "${agent}"`);
    const roleValue = column.role ? String(column.role) : null;
    const libraryRole = roleValue ? profiles.library.roles[roleValue] : undefined;
    const movesTo = column.moves_to === "any" ? "any" : list(column.moves_to);
    columns[columnName] = {
      name: columnName,
      agent,
      roleName: libraryRole ? libraryRole.name : null,
      role: libraryRole ? libraryRole.prompt : (roleValue ?? ""),
      model: column.model ? String(column.model) : null,
      effort: parseEffort(column.effort, errors, `${columnName}.effort`),
      onStart: column.on_start ? String(column.on_start) : null,
      movesTo,
    };
    if (agent && !roleValue) errors.push(`${columnName}: give the agent a "role" (a library role name or text)`);
  }
  const needsHuman = data.needs_human === undefined ? "Needs human" : data.needs_human ? String(data.needs_human) : null;
  for (const column of Object.values(columns)) {
    const targets = [...(column.movesTo === "any" ? [] : column.movesTo), ...(column.onStart ? [column.onStart] : [])];
    for (const target of targets) {
      if (!columns[target] && target !== needsHuman) errors.push(`${column.name}: moves to "${target}", which isn't listed under columns`);
    }
  }
  const limits = (data.limits ?? {}) as Record<string, unknown>;
  return {
    name,
    file,
    owner: match?.[1] ?? "",
    projectNumber: Number(match?.[2] ?? 0),
    statusField: String(data.status_field ?? "Status"),
    needsHuman,
    pollSeconds: data.poll_seconds === undefined ? 60 : Number(data.poll_seconds),
    limits: {
      movesPerIssue: Number(limits.moves_per_issue ?? 10),
      entriesPerColumn: Number(limits.entries_per_column ?? 3),
      budgetUsdPerIssue: limits.budget_usd_per_issue === undefined ? null : Number(limits.budget_usd_per_issue),
    },
    columns,
    errors,
  };
}

/** Reads profiles/boards/*.yaml: which agent works each column of a GitHub Project. */
export function loadBoards(profiles = loadProfiles()): { boards: Board[]; errors: { file: string; message: string }[] } {
  const dir = join(config.profilesDir, "boards");
  const result = { boards: [] as Board[], errors: [] as { file: string; message: string }[] };
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    try {
      result.boards.push(loadBoard(join(dir, entry), profiles));
    } catch (error) {
      result.errors.push({ file: `boards/${entry}`, message: (error as Error).message });
    }
  }
  return result;
}

export function getBoard(name: string): Board | null {
  return loadBoards().boards.find((board) => board.name === name) ?? null;
}

/** May an agent in `from` move a card to `to`? */
export function canMove(board: Board, from: string, to: string): boolean {
  const column = board.columns[from];
  if (!column) return false;
  if (to === board.needsHuman) return true;
  return column.movesTo === "any" ? Boolean(board.columns[to]) : column.movesTo.includes(to);
}

export function allowedMoves(board: Board, from: string): string[] {
  const column = board.columns[from];
  if (!column) return [];
  const targets = column.movesTo === "any" ? Object.keys(board.columns).filter((name) => name !== from) : column.movesTo;
  return [...new Set([...targets, ...(board.needsHuman ? [board.needsHuman] : [])])];
}
