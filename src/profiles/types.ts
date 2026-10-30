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

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface GithubPermissions {
  comment: boolean;
  /** update_issue: edit the issue's title, body and labels. */
  updateIssue: boolean;
  /** submit_review: approve, comment on or request changes to the PR. */
  review: boolean;
  push: boolean;
  pullRequest: boolean;
  clone: boolean;
  /** Push and open the PR for the agent if it finished with work it didn't publish. */
  finalize: boolean;
  /** GitHub wiki pages: read any wiki the app can see; write only the task repository's. */
  wiki: "none" | "read" | "write";
  /** Sub-issues of the issue it works on: read = list them and check their work is merged; write = also create them (and move their cards). */
  subIssues: "none" | "read" | "write";
  /** link_issue: add or remove blocked-by, blocking, parent and sub-issue links between issues. */
  relations: boolean;
  /** merge_into_parent: merge a sub-issue's work into its parent issue's branch (never the default branch). */
  mergeIntoParent: boolean;
  /** On a sub-issue, branch from and open the pull request against the parent issue's branch. */
  parentBranch: boolean;
  /** start_related_agent: the related issues whose agents it may start (empty = none). */
  startRelated: ("blocked_by" | "blocks" | "parent" | "sub_issue")[];
  /** Environment variable with a token for the GitHub account it acts as; null = the admin UI's, or the App. */
  accountTokenEnv: string | null;
  /** Mentioning or assigning its GitHub account starts it, like its handle. */
  accountMentions: boolean;
}

/** One agent: profiles/agents/<name>/agent.md plus its own skills/ and mcp.json. */
export interface Profile {
  name: string;
  handle: string;
  description: string;
  model: string | null;
  effort: Effort | null;
  /** Models to use when the model is overloaded or its usage limit is reached, in order (null: FALLBACK_MODEL). */
  fallbackModel: string | null;
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
  /** Groups this agent belongs to (their defaults are already merged in). */
  groups: string[];
  /** Where model and effort came from, for the UI. */
  modelFrom: "agent" | "group" | null;
  effortFrom: "agent" | "group" | null;
  /** Identical copies of this agent: how many cards it may work at once. Null means no limit. */
  replicas: number | null;
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

/** A named set of agents (profiles/groups/<name>.yaml) with shared defaults. */
export interface Group {
  name: string;
  description: string;
  members: string[];
  defaults: { model: string | null; effort: Effort | null; skills: string[]; mcp: string[]; subagents: string[] };
  errors: string[];
}

export interface ProfileSet {
  root: string;
  agents: Profile[];
  groups: Group[];
  library: Library;
  /** Problems that stop a file from loading at all. */
  errors: { file: string; message: string }[];
}
