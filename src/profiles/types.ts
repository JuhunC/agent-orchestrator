/** An MCP server in the common `mcpServers` shape. Strings may contain ${VAR} references. */
export interface McpServer {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Always show this server's tools to the model instead of behind tool search. */
  alwaysLoad?: boolean;
}
export type McpServers = Record<string, McpServer>;

export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path of the skill's folder (holds SKILL.md). */
  dir: string;
  scope: "library" | "agent";
}

/** A subagent the main agent can delegate to (library/roles/<name>.md). */
export interface Role {
  name: string;
  description: string;
  prompt: string;
  tools: string[] | null;
  model: string | null;
  skills: string[];
  mcp: string[];
  file: string;
}

export interface GithubPermissions {
  comment: boolean;
  push: boolean;
  pullRequest: boolean;
  clone: boolean;
  /** Push and open the PR for the agent if it finished with work it didn't publish. */
  finalize: boolean;
}

/** One agent: profiles/agents/<name>/agent.md plus its own skills/ and mcp.json. */
export interface Profile {
  name: string;
  handle: string;
  description: string;
  model: string | null;
  /** The role prompt: the body of agent.md, added to Claude Code's system prompt. */
  prompt: string;
  /** Built-in Claude Code tools to offer; null means all of them. */
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
  env: Record<string, string>;
  /** As set in the file; the admin UI can switch an agent off on top of this. */
  enabledInFile: boolean;
  enabled: boolean;
  ownSkills: SkillInfo[];
  ownMcp: McpServers;
  dir: string;
  errors: string[];
}

export interface Library {
  skills: Record<string, SkillInfo>;
  roles: Record<string, Role>;
  mcp: McpServers;
  errors: string[];
}

export interface ProfileSet {
  root: string;
  agents: Profile[];
  library: Library;
  /** Problems that stop a file from loading at all. */
  errors: { file: string; message: string }[];
}
