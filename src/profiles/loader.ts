import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { RELATIONS, type Relation } from "../github/relations.ts";
import { normaliseMcpServers } from "./mcp.ts";
import { EFFORTS, type Effort, type Group, type Library, type Profile, type ProfileSet, type Role, type SkillInfo } from "./types.ts";

const HANDLE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const NAME = /^[a-z\d][a-z\d_-]{0,39}$/i;

/** Splits a markdown file into YAML frontmatter and body. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text.trim() };
  const data = (parse(match[1]!) ?? {}) as unknown;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("Frontmatter must be a YAML map");
  return { data: data as Record<string, unknown>, body: match[2]!.trim() };
}

function list(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  return value.map((item) => String(item));
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number`);
  return number;
}

function dirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((entry) => !entry.startsWith(".") && statSync(join(path, entry)).isDirectory())
    .sort();
}

function loadSkills(dir: string, scope: SkillInfo["scope"], errors: string[]): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const name of dirs(dir)) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) {
      errors.push(`${file}: missing SKILL.md`);
      continue;
    }
    try {
      const { data } = parseFrontmatter(readFileSync(file, "utf8"));
      if (!data.description) errors.push(`${file}: add a "description" so the agent knows when to use it`);
      skills.push({ name, description: String(data.description ?? ""), dir: join(dir, name), scope });
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`);
    }
  }
  return skills;
}

function loadRole(file: string): Role {
  const name = basename(file, ".md");
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  if (!NAME.test(name)) throw new Error(`Invalid role name "${name}"`);
  if (!data.description) throw new Error(`Role ${name} needs a "description" saying when to use it`);
  if (!body) throw new Error(`Role ${name} needs a prompt below the frontmatter`);
  return {
    name,
    description: String(data.description),
    prompt: body,
    tools: data.tools === undefined ? null : list(data.tools, "tools"),
    model: data.model ? String(data.model) : null,
    skills: list(data.skills, "skills"),
    mcp: list(data.mcp, "mcp"),
    file,
  };
}

function loadLibrary(root: string): Library {
  const errors: string[] = [];
  const library: Library = { skills: {}, roles: {}, mcp: {}, errors };
  for (const skill of loadSkills(join(root, "library", "skills"), "library", errors)) library.skills[skill.name] = skill;

  const rolesDir = join(root, "library", "roles");
  if (existsSync(rolesDir)) {
    for (const entry of readdirSync(rolesDir).filter((file) => file.endsWith(".md")).sort()) {
      try {
        const role = loadRole(join(rolesDir, entry));
        library.roles[role.name] = role;
      } catch (error) {
        errors.push(`library/roles/${entry}: ${(error as Error).message}`);
      }
    }
  }

  const mcpFile = join(root, "library", "mcp.json");
  if (existsSync(mcpFile)) {
    try {
      library.mcp = normaliseMcpServers(readFileSync(mcpFile, "utf8"), "library/mcp.json");
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return library;
}

/** Defaults for the `github:` block of agent.md (keys as written in the file). */
export const GITHUB_DEFAULTS = {
  comment: true,
  update_issue: true,
  review: true,
  push: true,
  pull_request: true,
  clone: true,
  finalize: true,
  wiki: "write",
  sub_issues: "none",
  relations: false,
  merge_into_parent: false,
  parent_branch: true,
  start_related: false,
} as const;

/** false | true (every relation) | a list of relations (start_related). */
function parseRelations(value: unknown, field: string, errors: string[]): Relation[] {
  if (value === undefined || value === null || value === false) return [];
  if (value === true) return [...RELATIONS];
  const relations: Relation[] = [];
  for (const item of Array.isArray(value) ? value.map(String) : [String(value)]) {
    if ((RELATIONS as readonly string[]).includes(item)) {
      if (!relations.includes(item as Relation)) relations.push(item as Relation);
    } else errors.push(`github.${field}: "${item}" isn't one of ${RELATIONS.join(", ")} (or use true or false)`);
  }
  return relations;
}

/** true | false | read | write | none (wiki, sub_issues) */
function parseAccess(value: unknown, field: string, errors: string[]): "none" | "read" | "write" {
  if (value === true || value === "write") return "write";
  if (value === false || value === "none" || value === null) return "none";
  if (value === "read") return "read";
  errors.push(`github.${field} must be write, read or none (got ${JSON.stringify(value)})`);
  return "none";
}

export function parseEffort(value: unknown, errors: string[], field = "effort"): Effort | null {
  if (value === undefined || value === null || value === "") return null;
  if (EFFORTS.includes(String(value) as Effort)) return String(value) as Effort;
  errors.push(`${field} must be one of ${EFFORTS.join(", ")}`);
  return null;
}

function loadGroups(root: string, library: Library): Group[] {
  const dir = join(root, "groups");
  if (!existsSync(dir)) return [];
  const groups: Group[] = [];
  for (const entry of readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const name = entry.replace(/\.ya?ml$/, "");
    const errors: string[] = [];
    let data: Record<string, any> = {};
    try {
      data = (parse(readFileSync(join(dir, entry), "utf8")) ?? {}) as Record<string, any>;
    } catch (error) {
      errors.push((error as Error).message);
    }
    const defaults = (data.defaults ?? {}) as Record<string, unknown>;
    const group: Group = {
      name,
      description: String(data.description ?? ""),
      members: list(data.members, "members"),
      defaults: {
        model: defaults.model ? String(defaults.model) : null,
        effort: parseEffort(defaults.effort, errors, "defaults.effort"),
        skills: list(defaults.skills, "defaults.skills"),
        mcp: list(defaults.mcp, "defaults.mcp"),
        subagents: list(defaults.subagents, "defaults.subagents"),
      },
      errors,
    };
    for (const skill of group.defaults.skills) if (!library.skills[skill]) errors.push(`Unknown skill "${skill}"`);
    for (const server of group.defaults.mcp) if (!library.mcp[server]) errors.push(`Unknown MCP server "${server}"`);
    for (const role of group.defaults.subagents) if (!library.roles[role]) errors.push(`Unknown subagent "${role}"`);
    groups.push(group);
  }
  return groups;
}

const union = (...lists: string[][]) => [...new Set(lists.flat())];

function loadProfile(root: string, name: string, library: Library, groups: Group[]): Profile {
  const dir = join(root, "agents", name);
  const errors: string[] = [];
  const { data, body } = parseFrontmatter(readFileSync(join(dir, "agent.md"), "utf8"));
  // Groups this agent is in: their defaults apply, and the agent's own settings win.
  const memberOf = groups.filter((group) => group.members.includes(name));
  const groupModel = memberOf.map((group) => group.defaults.model).find(Boolean) ?? null;
  const groupEffort = memberOf.map((group) => group.defaults.effort).find(Boolean) ?? null;

  if (!NAME.test(name)) errors.push(`Folder name "${name}" may only use letters, digits, - and _`);
  const handle = String(data.handle ?? "").replace(/^@/, "");
  if (!HANDLE.test(handle)) errors.push(`"handle" must be a valid GitHub login (got "${handle}")`);
  if (!body) errors.push("Write the agent's role below the frontmatter");

  const tools = (data.tools ?? {}) as { allow?: unknown; deny?: unknown };
  const github: Record<string, unknown> = { ...GITHUB_DEFAULTS, ...((data.github ?? {}) as Record<string, unknown>) };
  const skills = union(...memberOf.map((group) => group.defaults.skills), list(data.skills, "skills"));
  const mcp = union(...memberOf.map((group) => group.defaults.mcp), list(data.mcp, "mcp"));
  const subagents = union(...memberOf.map((group) => group.defaults.subagents), list(data.subagents, "subagents"));
  for (const skill of skills) if (!library.skills[skill]) errors.push(`Unknown skill "${skill}" (not in library/skills)`);
  for (const server of mcp) if (!library.mcp[server]) errors.push(`Unknown MCP server "${server}" (not in library/mcp.json)`);
  for (const role of subagents) if (!library.roles[role]) errors.push(`Unknown subagent "${role}" (not in library/roles)`);

  const ownSkills = loadSkills(join(dir, "skills"), "agent", errors);
  let ownMcp = {};
  if (existsSync(join(dir, "mcp.json"))) {
    try {
      ownMcp = normaliseMcpServers(readFileSync(join(dir, "mcp.json"), "utf8"), `agents/${name}/mcp.json`);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }

  const number = (field: string) => {
    try {
      return optionalNumber(data[field], field);
    } catch (error) {
      errors.push((error as Error).message);
      return null;
    }
  };
  const enabledInFile = data.enabled !== false;
  const override = getSetting(`agent_enabled:${name}`);
  return {
    name,
    handle,
    description: String(data.description ?? ""),
    model: data.model ? String(data.model) : groupModel,
    effort: parseEffort(data.effort, errors) ?? groupEffort,
    modelFrom: data.model ? "agent" : groupModel ? "group" : null,
    effortFrom: data.effort ? "agent" : groupEffort ? "group" : null,
    groups: memberOf.map((group) => group.name),
    replicas: number("replicas"),
    prompt: body,
    toolsAllow: tools.allow === undefined ? null : list(tools.allow, "tools.allow"),
    toolsDeny: list(tools.deny, "tools.deny"),
    skills,
    mcp,
    subagents,
    github: {
      comment: github.comment !== false,
      updateIssue: github.update_issue !== false,
      review: github.review !== false,
      push: github.push !== false,
      pullRequest: github.pull_request !== false,
      clone: github.clone !== false,
      finalize: github.finalize !== false,
      wiki: parseAccess(github.wiki, "wiki", errors),
      subIssues: parseAccess(github.sub_issues, "sub_issues", errors),
      relations: github.relations === true,
      mergeIntoParent: github.merge_into_parent === true,
      parentBranch: github.parent_branch !== false,
      startRelated: parseRelations(github.start_related, "start_related", errors),
    },
    maxTurns: number("max_turns"),
    maxBudgetUsd: number("max_budget_usd"),
    timeoutMinutes: number("timeout_minutes"),
    live: data.live !== false,
    env: Object.fromEntries(Object.entries((data.env ?? {}) as Record<string, unknown>).map(([key, value]) => [key, String(value)])),
    enabledInFile,
    enabled: enabledInFile && override !== "false",
    ownSkills,
    ownMcp,
    dir,
    errors,
  };
}

/** Reads every agent profile and the shared library from PROFILES_DIR. Cheap; called per use. */
export function loadProfiles(root = config.profilesDir): ProfileSet {
  const library = loadLibrary(root);
  const set: ProfileSet = { root, agents: [], groups: loadGroups(root, library), library, errors: [] };
  const handles = new Map<string, string>();
  for (const name of dirs(join(root, "agents"))) {
    if (!existsSync(join(root, "agents", name, "agent.md"))) continue;
    try {
      const profile = loadProfile(root, name, set.library, set.groups);
      const other = handles.get(profile.handle.toLowerCase());
      if (other) profile.errors.push(`Handle @${profile.handle} is also used by ${other}`);
      handles.set(profile.handle.toLowerCase(), name);
      set.agents.push(profile);
    } catch (error) {
      set.errors.push({ file: `agents/${name}/agent.md`, message: (error as Error).message });
    }
  }
  for (const group of set.groups) {
    for (const member of group.members) if (!set.agents.some((agent) => agent.name === member)) group.errors.push(`Unknown member "${member}"`);
  }
  return set;
}

/** Agent names for a list of agents and `group:<name>` references. */
export function expandAgents(set: ProfileSet, refs: string[]): { agents: string[]; errors: string[] } {
  const agents: string[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("group:")) {
      const group = set.groups.find((candidate) => candidate.name === ref.slice(6));
      if (!group) errors.push(`unknown group "${ref.slice(6)}"`);
      else agents.push(...group.members);
    } else if (set.agents.some((agent) => agent.name === ref)) {
      agents.push(ref);
    } else {
      errors.push(`unknown agent "${ref}"`);
    }
  }
  return { agents: [...new Set(agents)], errors };
}

export function getProfile(name: string): Profile | null {
  return loadProfiles().agents.find((profile) => profile.name === name) ?? null;
}

/** The agent a GitHub login refers to, if it's a usable one. */
export function profileByHandle(handle: string): Profile | null {
  return loadProfiles().agents.find((profile) => profile.handle.toLowerCase() === handle.toLowerCase() && !profile.errors.length) ?? null;
}

export function setProfileEnabled(name: string, enabled: boolean): void {
  setSetting(`agent_enabled:${name}`, String(enabled));
}
