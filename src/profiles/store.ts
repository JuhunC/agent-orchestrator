import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { loadProfiles, parseFrontmatter } from "./loader.ts";
import { normaliseMcpServers } from "./mcp.ts";

/** Files the admin UI may edit, relative to PROFILES_DIR. */
const EDITABLE = [
  /^agents\/[a-z\d][a-z\d_-]*\/agent\.md$/i,
  /^agents\/[a-z\d][a-z\d_-]*\/mcp\.json$/i,
  /^agents\/[a-z\d][a-z\d_-]*\/skills\/[a-z\d][a-z\d_-]*\/[\w.-]+(\/[\w.-]+)*$/i,
  /^library\/mcp\.json$/,
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
