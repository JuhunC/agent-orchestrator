import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { parse, parseDocument } from "yaml";
import { loadProfiles, parseFrontmatter } from "./loader.ts";
import { EFFORTS } from "./types.ts";
import { normaliseMcpServers } from "./mcp.ts";

/** Files the admin UI may edit, relative to PROFILES_DIR. */
const EDITABLE = [
  /^agents\/[a-z\d][a-z\d_-]*\/agent\.md$/i,
  /^agents\/[a-z\d][a-z\d_-]*\/mcp\.json$/i,
  /^agents\/[a-z\d][a-z\d_-]*\/skills\/[a-z\d][a-z\d_-]*\/[\w.-]+(\/[\w.-]+)*$/i,
  /^library\/mcp\.json$/,
  /^boards\/[a-z\d][a-z\d_-]*\.ya?ml$/i,
  /^groups\/[a-z\d][a-z\d_-]*\.ya?ml$/i,
  /^library\/roles\/[a-z\d][a-z\d_-]*\.md$/i,
  /^library\/skills\/[a-z\d][a-z\d_-]*\/[\w.-]+(\/[\w.-]+)*$/i,
];

export class ProfileFileError extends Error {}

function safePath(path: string): { absolute: string; relative: string } {
  const clean = path.replace(/^\/+/, "");
  const absolute = resolve(config.profilesDir, clean);
  const rel = relative(config.profilesDir, absolute).split(sep).join("/");
  if (rel.startsWith("..") || !EDITABLE.some((pattern) => pattern.test(rel)) || rel.split("/").some((part) => part.startsWith("."))) {
    throw new ProfileFileError(`${path} is not an editable profile file`);
  }
  return { absolute, relative: rel };
}

/** Checks a file's content before it's saved, so a typo can't break an agent. */
function validate(rel: string, content: string): void {
  if (/^groups\/.+\.ya?ml$/.test(rel)) {
    const data = parse(content) as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || !Array.isArray(data.members)) throw new ProfileFileError('A group needs a "members" list');
    return;
  }
  if (/^boards\/.+\.ya?ml$/.test(rel)) {
    const data = parse(content) as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || !/^[\w.-]+\/\d+$/.test(String(data.project ?? ""))) throw new ProfileFileError('A board needs "project: owner/number"');
    if (!data.columns || typeof data.columns !== "object") throw new ProfileFileError('A board needs a "columns" map');
    return;
  }
  if (rel.endsWith(".json")) {
    normaliseMcpServers(content, rel);
    return;
  }
  if (rel.endsWith("agent.md") || rel.startsWith("library/roles/") || rel.endsWith("/SKILL.md")) {
    const { data } = parseFrontmatter(content);
    if (rel.endsWith("agent.md") && !data.handle) throw new ProfileFileError("agent.md needs a handle in its frontmatter");
    if ((rel.startsWith("library/roles/") || rel.endsWith("/SKILL.md")) && !data.description) {
      throw new ProfileFileError("Add a description to the frontmatter");
    }
  }
}

function gitCommit(message: string, author: string): void {
  if (!existsSync(join(config.profilesDir, ".git"))) return;
  const env = { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "admin@agent-orchestrator", GIT_COMMITTER_NAME: "agent-orchestrator", GIT_COMMITTER_EMAIL: "admin@agent-orchestrator" };
  execFile("git", ["add", "-A"], { cwd: config.profilesDir, env }, (error) => {
    if (error) return log.warn("Could not stage profile change", { error: error.message });
    execFile("git", ["commit", "-q", "-m", message], { cwd: config.profilesDir, env }, (commitError) => {
      if (commitError && !/nothing to commit/.test(commitError.message)) log.warn("Could not commit profile change", { error: commitError.message });
    });
  });
}

export function readProfileFile(path: string): string {
  const { absolute } = safePath(path);
  if (!existsSync(absolute)) throw new ProfileFileError(`${path} does not exist`);
  return readFileSync(absolute, "utf8");
}

export function writeProfileFile(path: string, content: string, author: string): void {
  const { absolute, relative: rel } = safePath(path);
  try {
    validate(rel, content);
  } catch (error) {
    throw new ProfileFileError((error as Error).message);
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content.endsWith("\n") ? content : `${content}\n`);
  gitCommit(`Edit ${rel}`, author);
}

/** Deletes a file; deleting an agent.md or SKILL.md removes its whole folder. */
export function deleteProfileFile(path: string, author: string): void {
  const { absolute, relative: rel } = safePath(path);
  const target = rel.endsWith("/agent.md") || rel.endsWith("/SKILL.md") ? dirname(absolute) : absolute;
  rmSync(target, { recursive: true, force: true });
  gitCommit(`Delete ${relative(config.profilesDir, target)}`, author);
}

/** Every file in the profiles folder, for the editor's file list. */
export function listProfileFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(config.profilesDir, path).split(sep).join("/"));
    }
  };
  walk(config.profilesDir);
  return files.sort();
}

const AGENT_TEMPLATE = (name: string, handle: string) => `---
handle: ${handle}
description: What this agent is for
# model: sonnet            # defaults to ANTHROPIC_MODEL
skills: []                 # names from library/skills (its own skills/ folder is always included)
mcp: []                    # names from library/mcp.json (its own mcp.json is always included)
subagents: []              # names from library/roles
github:
  push: true
  pull_request: true
max_turns: 200
live: true
---
You are ${name}, an engineer on this team. Describe how this agent should work here.
`;

export function createAgent(name: string, handle: string, author: string): void {
  if (!/^[a-z\d][a-z\d_-]{0,39}$/i.test(name)) throw new ProfileFileError("Use letters, digits, - and _ for the name");
  if (existsSync(join(config.profilesDir, "agents", name))) throw new ProfileFileError(`An agent called ${name} already exists`);
  if (loadProfiles().agents.some((agent) => agent.handle.toLowerCase() === handle.toLowerCase())) throw new ProfileFileError(`@${handle} is already used`);
  writeProfileFile(`agents/${name}/agent.md`, AGENT_TEMPLATE(name, handle.replace(/^@/, "")), author);
}

/**
 * Sets frontmatter fields of a profile file (agent.md) from the admin UI, keeping the rest of
 * the file, comments included. `null` removes a field.
 */
export function setFrontmatterFields(path: string, fields: Record<string, string | number | null>, author: string): void {
  const text = readProfileFile(path);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const doc = parseDocument(match ? match[1]! : "");
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === "") doc.delete(key);
    else doc.set(key, value);
  }
  const front = doc.toString().trimEnd();
  writeProfileFile(path, `---\n${front}\n---\n${match ? match[2]! : text}`, author);
}

export function setAgentModel(name: string, model: string | null, effort: string | null, author: string): void {
  if (effort && !EFFORTS.includes(effort as never)) throw new ProfileFileError(`effort must be one of ${EFFORTS.join(", ")}`);
  if (model && !/^[\w.:/@[\]-]{1,120}$/.test(model)) throw new ProfileFileError("That doesn't look like a model name");
  setFrontmatterFields(`agents/${name}/agent.md`, { model, effort }, author);
}

const AGENT_NAME = /^[a-z\d][a-z\d_-]{0,39}$/i;
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** Next free "<base>-<n>" name among existing agents (and handles). */
function nextFree(base: string, taken: Set<string>): string {
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`;
}

/**
 * Copies an agent (its agent.md, own skills and MCP servers) under new names. With `count`,
 * makes that many copies named <name>-2, <name>-3, … with matching handles; optionally adds
 * them to a group.
 */
export function duplicateAgent(source: string, options: { name?: string; handle?: string; count?: number; group?: string }, author: string): string[] {
  const set = loadProfiles();
  const original = set.agents.find((agent) => agent.name === source);
  if (!original) throw new ProfileFileError(`No agent called ${source}`);
  const count = Math.max(1, Math.min(20, Math.floor(options.count ?? 1)));
  if (count > 1 && (options.name || options.handle)) throw new ProfileFileError("Give either a name and handle for one copy, or a count for several");
  const names = new Set(set.agents.map((agent) => agent.name.toLowerCase()));
  const handles = new Set(set.agents.map((agent) => agent.handle.toLowerCase()));
  const base = source.replace(/-\d+$/, "");
  const baseHandle = original.handle.replace(/-\d+$/, "");
  const created: string[] = [];
  for (let index = 0; index < count; index++) {
    const name = options.name?.trim() || nextFree(base, names);
    const handle = (options.handle?.trim().replace(/^@/, "") || nextFree(baseHandle, handles)).slice(0, 39);
    if (!AGENT_NAME.test(name)) throw new ProfileFileError(`Invalid agent name "${name}"`);
    if (!LOGIN.test(handle)) throw new ProfileFileError(`Invalid handle "${handle}"`);
    if (names.has(name.toLowerCase())) throw new ProfileFileError(`An agent called ${name} already exists`);
    if (handles.has(handle.toLowerCase())) throw new ProfileFileError(`@${handle} is already used`);
    const target = join(config.profilesDir, "agents", name);
    cpSync(original.dir, target, { recursive: true });
    names.add(name.toLowerCase());
    handles.add(handle.toLowerCase());
    setFrontmatterFields(`agents/${name}/agent.md`, { handle }, author);
    created.push(name);
  }
  if (options.group) addToGroup(options.group, created, author);
  return created;
}

/** Adds agents to a group file, creating the group if needed. */
export function addToGroup(group: string, agents: string[], author: string): void {
  if (!AGENT_NAME.test(group)) throw new ProfileFileError(`Invalid group name "${group}"`);
  const path = `groups/${group}.yaml`;
  const file = join(config.profilesDir, path);
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : `description: ""\nmembers: []\n`);
  const members = ((doc.toJS() as { members?: string[] } | null)?.members ?? []).map(String);
  doc.set("members", [...new Set([...members, ...agents])]);
  writeProfileFile(path, doc.toString(), author);
}

/** Applies model, effort or on/off to every member of a group at once. */
export function applyToGroup(group: string, changes: { model?: string | null; effort?: string | null }, author: string): string[] {
  const set = loadProfiles();
  const found = set.groups.find((candidate) => candidate.name === group);
  if (!found) throw new ProfileFileError(`No group called ${group}`);
  const members = found.members.filter((member) => set.agents.some((agent) => agent.name === member));
  for (const member of members) {
    const fields: Record<string, string | null> = {};
    if (changes.model !== undefined) fields.model = changes.model || null;
    if (changes.effort !== undefined) {
      if (changes.effort && !EFFORTS.includes(changes.effort as never)) throw new ProfileFileError(`effort must be one of ${EFFORTS.join(", ")}`);
      fields.effort = changes.effort || null;
    }
    if (Object.keys(fields).length) setFrontmatterFields(`agents/${member}/agent.md`, fields, author);
  }
  return members;
}
