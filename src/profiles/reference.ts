import { EVIDENCE, EVIDENCE_TEXT, HANDOFF_FIELDS } from "../boards/rules.ts";
import { RELATIONS } from "../github/relations.ts";
import { GITHUB_DEFAULTS } from "./loader.ts";
import { EFFORTS, type ProfileSet } from "./types.ts";

/**
 * What can go in each kind of profile file, for the admin UI's editor: every option with its
 * type, default, allowed values and meaning. Keep it in step with the loaders (the unit tests
 * check the lists that live in code: GitHub permissions, evidence, handoff fields, efforts).
 */

/** Where an option's available values come from, filled in from the current profiles. */
export type ValueSource = "skills" | "mcp" | "roles" | "agents" | "groups" | "agentRefs";

export interface OptionDoc {
  /** Dotted path; `<name>` stands for a key you choose (a column, a server, a label). */
  key: string;
  type: string;
  default?: string;
  /** The only values allowed. */
  values?: readonly string[];
  /** Values that exist right now (skills in the library, agents, …). */
  source?: ValueSource;
  required?: boolean;
  description: string;
  example?: string;
}

export interface FileDoc {
  id: string;
  title: string;
  /** Profile-relative paths this applies to (a regular expression). */
  pattern: string;
  format: "markdown" | "yaml" | "json";
  summary: string;
  /** For markdown files: what goes below the frontmatter. */
  body?: string;
  options: OptionDoc[];
}

const bool = (value: boolean) => (value ? "true" : "false");
const ACCESS = ["none", "read", "write"] as const;

const AGENT: FileDoc = {
  id: "agent",
  title: "Agent (agent.md)",
  pattern: "^agents/[^/]+/agent\\.md$",
  format: "markdown",
  summary: "YAML frontmatter between --- lines sets up the agent; its own skills/ folder and mcp.json are added to what it lists here.",
  body: "The role prompt: how this agent works. It's added to Claude Code's system prompt.",
  options: [
    { key: "handle", type: "string", required: true, description: "GitHub login people @mention to call this agent. Must be unique.", example: "handle: acme-coder" },
    { key: "description", type: "string", description: "What the agent is for, shown in the admin UI.", example: "description: Implements issues and opens pull requests" },
    { key: "model", type: "string", default: "ANTHROPIC_MODEL (or its group's)", description: "Model id or alias, e.g. claude-opus-5-5, sonnet.", example: "model: claude-opus-5-5" },
    { key: "effort", type: "string", values: EFFORTS, default: "the model's default (or its group's)", description: "How much the model thinks.", example: "effort: high" },
    { key: "skills", type: "list", source: "skills", default: "[]", description: "Skills from library/skills. Its own skills/ folder is always included.", example: "skills: [shipping-changes]" },
    { key: "mcp", type: "list", source: "mcp", default: "[]", description: "MCP servers from library/mcp.json. Its own mcp.json is always included.", example: "mcp: [docs]" },
    { key: "subagents", type: "list", source: "roles", default: "[]", description: "Roles from library/roles the agent can delegate to.", example: "subagents: [code-reviewer]" },
    { key: "tools.allow", type: "list", default: "every Claude Code tool", description: "Only these built-in Claude Code tools (Bash, Read, Edit, Write, Grep, Glob, WebFetch, …).", example: "tools:\n  allow: [Read, Grep, Glob, Bash]" },
    { key: "tools.deny", type: "list", default: "[]", description: "Built-in tools to take away, e.g. WebFetch.", example: "tools:\n  deny: [WebFetch]" },
    { key: "github.comment", type: "boolean", default: bool(GITHUB_DEFAULTS.comment), description: "post_comment: comment on the thread while working.", example: "github:\n  comment: true" },
    { key: "github.update_issue", type: "boolean", default: bool(GITHUB_DEFAULTS.update_issue), description: "update_issue: edit the issue's title, description and labels (missing labels are created), and close or reopen it (state, when the task finishes). On boards that track fields, also set_card_fields: the card's start date, end date and estimate.", example: "github:\n  update_issue: false" },
    { key: "github.review", type: "boolean", default: bool(GITHUB_DEFAULTS.review), description: "submit_review: approve, comment on or request changes to pull requests.", example: "github:\n  review: true" },
    { key: "github.push", type: "boolean", default: bool(GITHUB_DEFAULTS.push), description: "commit_and_push: push its branch.", example: "github:\n  push: false" },
    { key: "github.pull_request", type: "boolean", default: bool(GITHUB_DEFAULTS.pull_request), description: "open_pull_request: open or update the pull request for its branch.", example: "github:\n  pull_request: false" },
    { key: "github.clone", type: "boolean", default: bool(GITHUB_DEFAULTS.clone), description: "clone_repository: clone other repositories read-only, for reference.", example: "github:\n  clone: false" },
    { key: "github.finalize", type: "boolean", default: bool(GITHUB_DEFAULTS.finalize), description: "When it finishes with work it didn't publish, push it and open the pull request for it.", example: "github:\n  finalize: false" },
    { key: "github.wiki", type: "string", values: ACCESS, default: GITHUB_DEFAULTS.wiki, description: "GitHub wiki pages: read any wiki the app can see; write only the task repository's.", example: "github:\n  wiki: read" },
    {
      key: "github.sub_issues",
      type: "string",
      values: ACCESS,
      default: GITHUB_DEFAULTS.sub_issues,
      description: "Sub-issues of the issue it works on. read: list_sub_issues lists them and checks each one's branch head is an ancestor of (merged into) this issue's branch. write: also create_sub_issue (with labels, created if missing, and blocked_by relations), and move_sub_issue on boards that allow it.",
      example: "github:\n  sub_issues: write",
    },
    { key: "github.relations", type: "boolean", default: bool(GITHUB_DEFAULTS.relations), description: `link_issue: add or remove relations between issues (${RELATIONS.join(", ")}).`, example: "github:\n  relations: true" },
    {
      key: "github.merge_into_parent",
      type: "boolean",
      default: bool(GITHUB_DEFAULTS.merge_into_parent),
      description: "merge_into_parent: on a sub-issue, merge its pushed work into the parent issue's branch with a merge commit (and close the sub-issue). Never merges into the default branch.",
      example: "github:\n  merge_into_parent: true",
    },
    {
      key: "github.parent_branch",
      type: "boolean",
      default: bool(GITHUB_DEFAULTS.parent_branch),
      description: "On a sub-issue, branch from the parent issue's branch (ao/issue-<parent>) and open the pull request against it. Issues with a parent or sub-issues use the shared branch ao/issue-<n>. Off: every issue branches from and merges into the default branch.",
      example: "github:\n  parent_branch: false",
    },
    {
      key: "github.start_related",
      type: "boolean or list",
      default: bool(GITHUB_DEFAULTS.start_related),
      description: `start_related_agent: when its task finishes, start the agent responsible for a related issue, with a message. true allows every relation; a list allows some of ${RELATIONS.join(", ")} (parent: its parent issue; sub_issue: its sub-issues; blocked_by: issues blocking it; blocks: issues it blocks). On a board card the card's column's agent starts (the board's related_agents and loop guards apply); otherwise the agent named, or the one that last worked on that issue. MAX_AGENT_CHAIN limits how many agents may start each other in a row.`,
      example: "github:\n  start_related: [parent]",
    },
    {
      key: "github.account_token_env",
      type: "string",
      default: "none (the GitHub App, or the account registered on the agent's page)",
      description: "Act on GitHub as a GitHub account instead of the GitHub App: the name of the environment variable holding that account's personal access token. Its comments, pull requests, reviews, issue changes, git pushes and commits are made as the account. Takes precedence over an account registered on the agent's page. Use an account made for the agent: what it does on GitHub doesn't start agents.",
      example: "github:\n  account_token_env: CODER_GITHUB_TOKEN",
    },
    { key: "max_turns", type: "number", default: "no limit", description: "Most model turns per task.", example: "max_turns: 200" },
    { key: "max_budget_usd", type: "number", default: "no limit", description: "Most it may spend per task, in US dollars.", example: "max_budget_usd: 5" },
    { key: "timeout_minutes", type: "number", default: "DEFAULT_TIMEOUT_MINUTES", description: "Stop a task after this long.", example: "timeout_minutes: 45" },
    { key: "live", type: "boolean", default: "true", description: "Keep its session open between tasks on the same thread (faster follow-ups). false starts a new process per task.", example: "live: false" },
    { key: "replicas", type: "number", default: "no limit", description: "How many cards it may work at once on boards (pool columns pick the least busy agent).", example: "replicas: 2" },
    { key: "env", type: "map", default: "{}", description: "Extra environment variables for its tools and MCP servers.", example: "env:\n  NODE_ENV: test" },
    { key: "enabled", type: "boolean", default: "true", description: "false turns the agent off (the admin UI can also turn it off).", example: "enabled: false" },
  ],
};

const MCP_OPTIONS: OptionDoc[] = [
  { key: "mcpServers.<name>.command", type: "string", description: "Local (stdio) server: the program to run. Use command or url.", example: '"command": "npx"' },
  { key: "mcpServers.<name>.args", type: "list", default: "[]", description: "Arguments for the command.", example: '"args": ["-y", "some-mcp-server"]' },
  { key: "mcpServers.<name>.env", type: "map", description: "Environment for the command. ${NAME} is replaced with the orchestrator's environment variable, so secrets stay out of the file.", example: '"env": { "API_TOKEN": "${SOME_TOKEN}" }' },
  { key: "mcpServers.<name>.url", type: "string", description: "Remote server: its URL (httpUrl also works).", example: '"url": "https://mcp.example.com/mcp"' },
  { key: "mcpServers.<name>.type", type: "string", values: ["http", "sse"], default: "http (remote), stdio (command)", description: "Transport for a remote server.", example: '"type": "sse"' },
  { key: "mcpServers.<name>.headers", type: "map", description: "HTTP headers for a remote server; ${NAME} is replaced like in env.", example: '"headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }' },
  { key: "mcpServers.<name>.alwaysLoad", type: "boolean", default: "false", description: "Show the server's tools to the model up front instead of behind tool search.", example: '"alwaysLoad": true' },
];

const LIBRARY_MCP: FileDoc = {
  id: "library-mcp",
  title: "Shared MCP servers (library/mcp.json)",
  pattern: "^library/mcp\\.json$",
  format: "json",
  summary: 'JSON: { "mcpServers": { "<name>": { … } } }. Agents use a server by listing its name under mcp in agent.md. "github" is reserved.',
  options: MCP_OPTIONS,
};

const AGENT_MCP: FileDoc = {
  id: "agent-mcp",
  title: "Agent's own MCP servers (mcp.json)",
  pattern: "^agents/[^/]+/mcp\\.json$",
  format: "json",
  summary: 'JSON: { "mcpServers": { "<name>": { … } } }. Only this agent gets these, on top of the library servers it lists. "github" is reserved.',
  options: MCP_OPTIONS,
};

const SKILL: FileDoc = {
  id: "skill",
  title: "Skill (SKILL.md)",
  pattern: "^(library/skills|agents/[^/]+/skills)/[^/]+/SKILL\\.md$",
  format: "markdown",
  summary: "A skill folder holds SKILL.md and any files it refers to. Claude Code loads the skill when its description fits the task.",
  body: "Step-by-step instructions for the agent.",
  options: [
    { key: "name", type: "string", default: "the folder name", description: "The skill's name.", example: "name: shipping-changes" },
    { key: "description", type: "string", required: true, description: "When the agent should use this skill.", example: "description: How to ship a change in this repository" },
  ],
};

const ROLE: FileDoc = {
  id: "role",
  title: "Role (library/roles/<name>.md)",
  pattern: "^library/roles/[^/]+\\.md$",
  format: "markdown",
  summary: "A role is a subagent an agent can delegate to (subagents in agent.md), and a job for a board column (role in a board file).",
  body: "The role's prompt: what to do.",
  options: [
    { key: "description", type: "string", required: true, description: "When to use this role.", example: "description: Reviews a change for bugs" },
    { key: "tools", type: "list", default: "every tool the agent has", description: "As a subagent: only these tools.", example: "tools: [Read, Grep, Glob]" },
    { key: "model", type: "string", default: "the agent's model", description: "As a subagent: the model to use.", example: "model: sonnet" },
    { key: "skills", type: "list", source: "skills", default: "[]", description: "As a subagent: library skills it gets.", example: "skills: [shipping-changes]" },
    { key: "mcp", type: "list", source: "mcp", default: "[]", description: "As a subagent: library MCP servers it gets.", example: "mcp: [docs]" },
  ],
};

const GROUP: FileDoc = {
  id: "group",
  title: "Group (groups/<name>.yaml)",
  pattern: "^groups/[^/]+\\.ya?ml$",
  format: "yaml",
  summary: "A named set of agents with shared defaults; an agent's own settings win. Use it in a board column as group:<name>.",
  options: [
    { key: "description", type: "string", description: "What the group is for.", example: "description: Developers who implement issues" },
    { key: "members", type: "list", source: "agents", required: true, description: "Agents in the group.", example: "members: [coder, coder-2]" },
    { key: "defaults.model", type: "string", description: "Model for members that don't set one.", example: "defaults:\n  model: sonnet" },
    { key: "defaults.effort", type: "string", values: EFFORTS, description: "Effort for members that don't set one.", example: "defaults:\n  effort: high" },
    { key: "defaults.skills", type: "list", source: "skills", description: "Library skills every member gets.", example: "defaults:\n  skills: [shipping-changes]" },
    { key: "defaults.mcp", type: "list", source: "mcp", description: "Library MCP servers every member gets.", example: "defaults:\n  mcp: [docs]" },
    { key: "defaults.subagents", type: "list", source: "roles", description: "Roles every member can delegate to.", example: "defaults:\n  subagents: [code-reviewer]" },
  ],
};

const BOARD: FileDoc = {
  id: "board",
  title: "Board (boards/<name>.yaml)",
  pattern: "^boards/[^/]+\\.ya?ml$",
  format: "yaml",
  summary: "Which agent works each column of a GitHub Project. When a card lands in a column, its agent does that stage and moves the card on. People can always move cards anywhere.",
  options: [
    { key: "project", type: "string", required: true, description: "owner/number from the project's URL. Organization projects send webhooks; others are polled.", example: "project: your-org/3" },
    { key: "status_field", type: "string", default: "Status", description: "The single-select field the board's columns come from.", example: "status_field: Status" },
    { key: "needs_human", type: "string", default: "Needs human", description: "Where loop guards send cards, and where agents can always move a card they're stuck on. Empty to have none (the card stays).", example: "needs_human: Needs human" },
    { key: "poll_seconds", type: "number", default: "60", description: "Also read the board this often, in case a webhook is missed. 0 turns polling off.", example: "poll_seconds: 60" },
    { key: "token_env", type: "string", description: "Only when the GitHub App can't reach the project (e.g. a user-owned one): the environment variable holding a token with project access.", example: "token_env: PROJECT_TOKEN" },
    { key: "limits.moves_per_issue", type: "number", default: "10", description: "Agent moves per card before it goes to needs_human.", example: "limits:\n  moves_per_issue: 10" },
    { key: "limits.entries_per_column", type: "number", default: "3", description: "Times a card may come back to the same column.", example: "limits:\n  entries_per_column: 3" },
    { key: "limits.budget_usd_per_issue", type: "number", default: "no limit", description: "Stop when agents have spent this much on a card.", example: "limits:\n  budget_usd_per_issue: 30" },
    { key: "columns.<name>", type: "map", required: true, description: "One entry per project column, by its exact name. {} for a column without an agent.", example: "columns:\n  Done: {}" },
    { key: "columns.<name>.agent", type: "string", source: "agents", description: "The agent that works cards in this column.", example: "    agent: coder" },
    { key: "columns.<name>.agents", type: "list", source: "agentRefs", description: "Several agents, or group:<name> for a whole group. mode says how cards are handed out.", example: "    agents: [group:developers]" },
    { key: "columns.<name>.mode", type: "string", values: ["pool", "all", "label"], default: "pool", description: "pool: one agent per card, the least busy. all: every agent works the card, then they vote where it goes. label: route by the issue's labels (routes).", example: "    mode: all" },
    { key: "columns.<name>.routes", type: "map", source: "agentRefs", description: "For mode: label: issue label → agent(s); default when none match.", example: "    routes: { frontend: web-dev, default: group:developers }" },
    { key: "columns.<name>.role", type: "string", source: "roles", description: "What the agent does in this column: a library role name, or the instructions as text. Required when the column has an agent.", example: "    role: implement" },
    { key: "columns.<name>.model", type: "string", default: "the agent's model", description: "Model for this column's agents.", example: "    model: claude-opus-5-5" },
    { key: "columns.<name>.effort", type: "string", values: EFFORTS, default: "the agent's effort", description: "Effort for this column's agents.", example: "    effort: high" },
    { key: "columns.<name>.on_start", type: "string", description: "Column to move the card to when the agent starts (e.g. Ready → In progress).", example: "    on_start: In progress" },
    { key: "columns.<name>.moves_to", type: "list", default: "[] (only needs_human)", description: 'Columns the agent may move the card to, or "any".', example: "    moves_to: [In review]" },
    {
      key: "columns.<name>.evidence",
      type: "list",
      values: EVIDENCE,
      default: "[]",
      description: `What an agent must show to move a card into this column: ${EVIDENCE.map((item) => `${item} (${EVIDENCE_TEXT[item]})`).join("; ")}.`,
      example: "    evidence: [pull_request, tests]",
    },
    { key: "columns.<name>.test_command", type: "string or list", default: "common test runners", description: "For tests evidence: command(s) that count as a test run (matched as a substring).", example: "    test_command: npm test" },
    { key: "columns.<name>.handoff_required", type: "list", values: HANDOFF_FIELDS, default: "[]", description: "Handoff fields an agent must fill (move_to_column's fields) to move a card into this column.", example: "    handoff_required: [status, verified]" },
    { key: "work_types.<name>.labels", type: "list", required: true, description: "Issue labels that mark a card as this type (the first type in the file that matches wins).", example: "work_types:\n  docs:\n    labels: [documentation]" },
    { key: "work_types.<name>.forbid", type: "list", default: "[]", description: "Columns agents may not move this type of card into.", example: "    forbid: [In review]" },
    { key: "fields.start", type: "string", default: "not tracked", description: "Name of the project's date field for when work on a card starts. Agents set it with set_card_fields.", example: "fields:\n  start: Start date" },
    { key: "fields.end", type: "string", default: "not tracked", description: "Name of the project's date field for when work on a card ends.", example: "fields:\n  end: End date" },
    { key: "fields.estimate", type: "string", default: "not tracked", description: "Name of the project's number field for the card's estimate.", example: "fields:\n  estimate: Estimate" },
    { key: "fields.start_on", type: "list", default: "[]", description: "Columns that fill in the start date (today, UTC) when a card enters them, if it has none yet. Needs fields.start.", example: "  start_on: [In progress]" },
    { key: "fields.end_on", type: "list", default: "[]", description: "Columns that set the end date to today (UTC) when a card enters them. Needs fields.end.", example: "  end_on: [Done]" },
    {
      key: "related_agents.columns",
      type: "list",
      default: "every column with agents",
      description: "Columns whose agent an agent on a related issue (parent, sub-issue, blocker) may start with start_related_agent. [] allows none. Each start counts as the card entering its column again (limits.entries_per_column).",
      example: "related_agents:\n  columns: [In progress, Integration]",
    },
    {
      key: "sub_issues.column",
      type: "string",
      default: "not added",
      description: "Sub-issues that agents create on this board (create_sub_issue) are added to the board in this column when the task finishes, which starts that column's agent.",
      example: "sub_issues:\n  column: Backlog",
    },
    {
      key: "sub_issues.moves_to",
      type: "list",
      default: "[] (agents can't move sub-issues)",
      description: "Columns an agent working a parent card may move its sub-issue cards to (move_sub_issue). Only evidence about the sub-issue itself (pull_request, merged, sub_issues) can be checked for such a move.",
      example: "sub_issues:\n  moves_to: [Ready, Done]",
    },
  ],
};

export const CONFIG_DOCS: FileDoc[] = [AGENT, AGENT_MCP, SKILL, ROLE, LIBRARY_MCP, GROUP, BOARD];

/** The reference for the editor, with the values that exist right now. */
export function configReference(profiles: ProfileSet): { files: FileDoc[]; values: Record<ValueSource, string[]> } {
  const agents = profiles.agents.map((agent) => agent.name);
  const groups = profiles.groups.map((group) => group.name);
  return {
    files: CONFIG_DOCS,
    values: {
      skills: Object.keys(profiles.library.skills),
      mcp: Object.keys(profiles.library.mcp),
      roles: Object.keys(profiles.library.roles),
      agents,
      groups,
      agentRefs: [...agents, ...groups.map((group) => `group:${group}`)],
    },
  };
}
