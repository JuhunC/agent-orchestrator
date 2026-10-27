import { realpathSync } from "node:fs";

function short(text: string, max = 160): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Strips the workspace prefix from paths; Claude may report them with symlinks resolved. */
export function makeRelative(cwd: string): (path: unknown) => string {
  const prefixes = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) prefixes.push(real);
  } catch {
    // workspace may not exist yet
  }
  return (path) => {
    const value = String(path ?? "");
    const prefix = prefixes.find((candidate) => candidate && value.startsWith(candidate));
    return prefix ? value.slice(prefix.length).replace(/^\/+/, "") || "." : value;
  };
}

const GITHUB_TOOL_LABELS: Record<string, string> = {
  get_thread: "Re-read the thread on GitHub",
  post_comment: "Posting a comment",
  commit_and_push: "Committing and pushing",
  open_pull_request: "Opening a pull request",
  get_ci_status: "Checking CI",
  fetch_from_github: "Fetching from GitHub",
  clone_repository: "Cloning a repository",
  move_to_column: "Moving the card",
  update_issue: "Updating the issue",
  submit_review: "Reviewing the pull request",
  list_wiki_pages: "Listing wiki pages",
  read_wiki_page: "Reading a wiki page",
  write_wiki_page: "Writing a wiki page",
  delete_wiki_page: "Deleting a wiki page",
  list_sub_issues: "Checking the sub-issues",
  create_sub_issue: "Creating a sub-issue",
  move_sub_issue: "Moving a sub-issue's card",
  link_issue: "Linking issues",
  merge_into_parent: "Merging into the parent issue's branch",
};

/** A one-line, human description of a Claude Code tool call, for progress comments and the UI. */
export function describeTool(name: string, input: Record<string, any>, rel: (path: unknown) => string): string {
  if (name.startsWith("mcp__github__")) return GITHUB_TOOL_LABELS[name.slice(13)] ?? `GitHub: ${name.slice(13)}`;
  if (name.startsWith("mcp__")) {
    const [, server, toolName] = name.split("__");
    return `Used ${server}.${toolName}`;
  }
  const path = input.file_path ?? input.path ?? input.notebook_path;
  switch (name) {
    case "Bash":
      return `Ran \`${short(String(input.command ?? ""), 120)}\``;
    case "Read":
      return `Read \`${rel(path)}\``;
    case "Write":
      return `Wrote \`${rel(path)}\``;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Edited \`${rel(path)}\``;
    case "Grep":
      return `Searched for \`${short(String(input.pattern ?? ""), 80)}\``;
    case "Glob":
      return `Listed \`${short(String(input.pattern ?? ""), 80)}\``;
    case "WebFetch":
      return `Fetched ${short(String(input.url ?? ""), 100)}`;
    case "WebSearch":
      return `Searched the web for "${short(String(input.query ?? ""), 80)}"`;
    case "TodoWrite": {
      const todos = (input.todos ?? []) as { content?: string; status?: string; activeForm?: string }[];
      const active = todos.find((todo) => todo.status === "in_progress");
      return active ? `Working on: ${short(active.activeForm ?? active.content ?? "", 120)}` : `Updated plan (${todos.length} items)`;
    }
    case "Task":
    case "Agent":
      return `Asked the ${input.subagent_type ?? "general"} subagent: ${short(String(input.description ?? input.prompt ?? ""), 100)}`;
    case "Skill":
      return `Used the ${input.skill ?? input.name ?? ""} skill`;
    default:
      return `Used ${name}`;
  }
}

export { short };
