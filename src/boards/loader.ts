import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { config } from "../config.ts";
import { expandAgents, loadProfiles, parseEffort } from "../profiles/loader.ts";
import type { Effort, ProfileSet } from "../profiles/types.ts";
import { forbids, NO_RULES, parseBoardRules, type CardFieldSettings, type ColumnRules, type RelatedAgentSettings, type SubIssueSettings, type WorkType } from "./rules.ts";

/** What happens when a card lands in one column of a project board. */
export type ColumnMode = "pool" | "all" | "label";

export interface BoardColumn {
  name: string;
  /** The first agent, for simple single-agent columns. */
  agent: string | null;
  /** Agents (harnesses: tools, skills, MCP servers) that work cards here, with groups expanded. */
  agents: string[];
  /** As written in the file: agent names and `group:<name>` references. */
  agentRefs: string[];
  /** pool: one agent per card, least busy first. all: every agent works the card. label: route by issue labels. */
  mode: ColumnMode;
  /** For `label` mode: first matching label wins; `default` when none match. */
  routes: { label: string; agents: string[] }[];
  routeDefault: string[];
  /** What the agent does in this column: a library role name, or inline text. */
  roleName: string | null;
  role: string;
  model: string | null;
  effort: Effort | null;
  /** Column the card moves to when the agent starts (e.g. Ready → In progress). */
  onStart: string | null;
  /** Columns the agent may move the card to; "any" allows every column. */
  movesTo: string[] | "any";
  /** What an agent must show to move a card into this column (evidence, handoff fields). */
  rules: ColumnRules;
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
  /** Name of an environment variable holding a token for the project, when the App can't reach it. */
  tokenEnv: string | null;
  limits: { movesPerIssue: number; entriesPerColumn: number; budgetUsdPerIssue: number | null };
  columns: Record<string, BoardColumn>;
  /** Card types (by issue label) and the columns agents may not move them into. */
  workTypes: WorkType[];
  /** Where agents' new sub-issues land, and where a parent's agent may move its sub-issues. */
  subIssues: SubIssueSettings;
  /** Project fields tracked per card: start/end dates and estimate. */
  fields: CardFieldSettings;
  /** Columns whose agents an agent on a related issue may start. */
  relatedAgents: RelatedAgentSettings;
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
  const rules = parseBoardRules(data);
  errors.push(...rules.errors);

  for (const [columnName, raw] of Object.entries(rawColumns)) {
    const column = raw ?? {};
    const agentRefs = column.agents !== undefined ? list(column.agents) : column.agent ? [String(column.agent)] : [];
    const expanded = expandAgents(profiles, agentRefs);
    for (const error of expanded.errors) errors.push(`${columnName}: ${error}`);
    const mode = String(column.mode ?? "pool") as ColumnMode;
    if (!["pool", "all", "label"].includes(mode)) errors.push(`${columnName}: mode must be pool, all or label`);
    const routes: { label: string; agents: string[] }[] = [];
    let routeDefault: string[] = [];
    for (const [label, target] of Object.entries((column.routes ?? {}) as Record<string, unknown>)) {
      const resolved = expandAgents(profiles, list(target));
      for (const error of resolved.errors) errors.push(`${columnName}.routes.${label}: ${error}`);
      if (label === "default") routeDefault = resolved.agents;
      else routes.push({ label, agents: resolved.agents });
    }
    if (mode === "label" && !routes.length) errors.push(`${columnName}: label mode needs "routes" (label: agent)`);
    const allAgents = [...new Set([...expanded.agents, ...routes.flatMap((route) => route.agents), ...routeDefault])];
    const agent = allAgents[0] ?? null;
    const roleValue = column.role ? String(column.role) : null;
    const libraryRole = roleValue ? profiles.library.roles[roleValue] : undefined;
    const movesTo = column.moves_to === "any" ? "any" : list(column.moves_to);
    columns[columnName] = {
      name: columnName,
      agent,
      agents: mode === "label" ? allAgents : expanded.agents,
      agentRefs,
      mode,
      routes,
      routeDefault,
      roleName: libraryRole ? libraryRole.name : null,
      role: libraryRole ? libraryRole.prompt : (roleValue ?? ""),
      model: column.model ? String(column.model) : null,
      effort: parseEffort(column.effort, errors, `${columnName}.effort`),
      onStart: column.on_start ? String(column.on_start) : null,
      movesTo,
      rules: rules.columns[columnName] ?? NO_RULES,
    };
    if (agent && !roleValue) errors.push(`${columnName}: give the agent a "role" (a library role name or text)`);
  }
  if (data.token_env && !/^[A-Z_][A-Z0-9_]*$/i.test(String(data.token_env))) errors.push('"token_env" must be an environment variable name');
  else if (data.token_env && !process.env[String(data.token_env)]) errors.push(`token_env: the environment variable ${data.token_env} is not set`);
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
    tokenEnv: data.token_env ? String(data.token_env) : null,
    limits: {
      movesPerIssue: Number(limits.moves_per_issue ?? 10),
      entriesPerColumn: Number(limits.entries_per_column ?? 3),
      budgetUsdPerIssue: limits.budget_usd_per_issue === undefined ? null : Number(limits.budget_usd_per_issue),
    },
    columns,
    workTypes: rules.workTypes,
    subIssues: rules.subIssues,
    fields: rules.fields,
    relatedAgents: rules.relatedAgents,
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

/** Where an agent in `from` may move a card; a work type leaves out the columns it forbids. */
export function allowedMoves(board: Board, from: string, workType?: WorkType | null): string[] {
  const column = board.columns[from];
  if (!column) return [];
  const targets = (column.movesTo === "any" ? Object.keys(board.columns).filter((name) => name !== from) : column.movesTo).filter((name) => !forbids(workType, name));
  return [...new Set([...targets, ...(board.needsHuman ? [board.needsHuman] : [])])];
}
