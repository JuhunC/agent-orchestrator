import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { expandMcpServers, expandVars } from "../profiles/mcp.ts";
import type { Effort, Library, McpServers, Profile } from "../profiles/types.ts";
import type { Task } from "../types.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Everything the agent process may see. The SDK replaces the environment entirely, so
 * orchestrator secrets (GitHub App key, webhook secret, admin token) are never passed on.
 */
export function agentEnv(profile: Profile, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: config.agentHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    CI: "true",
    DISABLE_AUTOUPDATER: "1",
  };
  if (!config.allowNonessentialTraffic) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  for (const name of config.agentEnvPassthrough) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  for (const [key, value] of Object.entries(profile.env)) {
    const expanded = expandVars(value, process.env);
    // An empty value (e.g. `${UNSET}`) doesn't override a variable that's already there.
    if (expanded || !env[key]) env[key] = expanded;
  }
  return { ...env, ...extra };
}

export function profileMcpServers(profile: Profile, library: Library): McpServers {
  const shared = Object.fromEntries(profile.mcp.filter((name) => library.mcp[name]).map((name) => [name, library.mcp[name]!]));
  return expandMcpServers({ ...shared, ...profile.ownMcp }, process.env);
}

function toSdkMcp(servers: McpServers): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.url
        ? ({ type: server.type === "sse" ? "sse" : "http", url: server.url, headers: server.headers, ...(server.alwaysLoad ? { alwaysLoad: true } : {}) } as McpServerConfig)
        : ({ type: "stdio", command: server.command!, args: server.args, env: server.env, ...(server.alwaysLoad ? { alwaysLoad: true } : {}) } as McpServerConfig),
    ]),
  );
}

/**
 * Packages the agent's skills (library skills it lists, plus its own) as a local plugin outside
 * the repository, so they're available to the agent but never end up in a commit.
 */
export function buildSkillsPlugin(profile: Profile, library: Library, dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: `ao-${profile.name}`, version: "1.0.0", description: `Skills for the ${profile.name} agent` }, null, 2),
  );
  // The agent's skills, plus library skills its subagents use.
  const roleSkills = profile.subagents.flatMap((name) => library.roles[name]?.skills ?? []);
  const names = [...new Set([...profile.skills, ...roleSkills])];
  const skills = [...names.map((name) => library.skills[name]).filter((skill) => skill !== undefined), ...profile.ownSkills];
  for (const skill of skills) cpSync(skill.dir, join(dir, "skills", skill.name), { recursive: true });
  return dir;
}

function subagents(profile: Profile, library: Library, mcpNames: string[]): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  for (const name of profile.subagents) {
    const role = library.roles[name];
    if (!role) continue;
    agents[name] = {
      description: role.description,
      prompt: role.prompt,
      ...(role.tools ? { tools: role.tools } : {}),
      ...(role.model ? { model: role.model } : {}),
      ...(role.skills.length ? { skills: role.skills } : {}),
      // Subagents may use MCP servers the main agent has, by name.
      ...(role.mcp.length ? { mcpServers: role.mcp.filter((server) => mcpNames.includes(server)) } : {}),
    };
  }
  return agents;
}

export interface SessionSetup {
  profile: Profile;
  library: Library;
  workspace: Workspace;
  env: Record<string, string>;
  github: McpServerConfig;
  resume: string | null;
  /** Where this session keeps generated files (the skills plugin). */
  stateDir: string;
  /** Per-run model and effort, e.g. from a board column; falls back to the profile. */
  model?: string | null;
  effort?: Effort | null;
}

const ORCHESTRATOR_NOTES = `
## Working in the agent orchestrator
- You are run by an orchestrator in response to a GitHub request. There is no human at the terminal: work autonomously, and ask questions with the github post_comment tool only when you're truly blocked.
- Your working directory is a git checkout on the branch for this task. Don't switch branches.
- You can't use \`git push\` or \`gh\` to change GitHub. Publish with the github MCP tools: commit_and_push, then open_pull_request.
- End with a concise summary for the people on GitHub; it's posted as a comment.`;

export function buildOptions(setup: SessionSetup): Options {
  const { profile, library, workspace, env, github, resume, stateDir } = setup;
  const model = setup.model ?? profile.model ?? env.ANTHROPIC_MODEL;
  const effort = setup.effort ?? profile.effort;
  const mcp = toSdkMcp(profileMcpServers(profile, library));
  const plugin = buildSkillsPlugin(profile, library, join(stateDir, "plugin"));
  const options: Options = {
    cwd: workspace.dir,
    env,
    systemPrompt: { type: "preset", preset: "claude_code", append: `${profile.prompt}\n${ORCHESTRATOR_NOTES}` },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Load the repository's own CLAUDE.md and .claude/ settings, nothing from the server's home.
    settingSources: ["project"],
    plugins: [{ type: "local", path: plugin }],
    skills: "all",
    mcpServers: { ...mcp, github },
    agents: subagents(profile, library, Object.keys(mcp)),
    disallowedTools: profile.toolsDeny,
    additionalDirectories: [],
  };
  if (profile.toolsAllow) options.tools = profile.toolsAllow;
  if (model) options.model = model;
  if (effort) options.effort = effort;
  if (profile.maxTurns) options.maxTurns = profile.maxTurns;
  if (profile.maxBudgetUsd) options.maxBudgetUsd = profile.maxBudgetUsd;
  if (resume) options.resume = resume;
  return options;
}

/** Per-task values that must not force a new live session when they change. */
export const PER_TASK_ENV = new Set(["AO_TASK_ID", "AO_REQUESTED_BY", "AO_ATTEMPT"]);

export function taskEnv(task: Task, workspace: Workspace): Record<string, string> {
  return {
    AO_TASK_ID: String(task.id),
    AO_AGENT: task.agent,
    AO_REPO: `${task.owner}/${task.repo}`,
    AO_THREAD_KIND: task.threadKind,
    AO_THREAD_NUMBER: String(task.threadNumber),
    AO_BRANCH: workspace.branch,
    AO_REQUESTED_BY: task.requestedBy,
    AO_ATTEMPT: String(task.attempts + 1),
  };
}
