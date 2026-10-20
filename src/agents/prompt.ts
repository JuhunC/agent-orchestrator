import type { ThreadContext } from "../github/threads.ts";
import type { Agent, Task } from "../types.ts";

export interface WorkspaceInfo {
  branch: string;
  baseBranch: string;
  canPush: boolean;
  /** False when the agent is configured not to push or open PRs. */
  willPush: boolean;
}

const MAX_PROMPT = 100_000;
const KIND_LABEL = { issue: "issue", pull: "pull request", discussion: "discussion" } as const;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…(truncated)` : trimmed;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function historySection(history: Task[]): string {
  if (!history.length) return "";
  const entries = history.map((task) => {
    const where = `${KIND_LABEL[task.threadKind]} #${task.threadNumber}`;
    const lines = [
      `### Run ${task.id} — ${task.finishedAt?.slice(0, 16).replace("T", " ") ?? task.createdAt.slice(0, 16)} UTC on ${where} (${task.status})`,
      `Requested by @${task.requestedBy}:`,
      quote(clip(task.requestText, 1500)),
    ];
    if (task.branch) lines.push(`Branch: \`${task.branch}\`${task.commits ? ` (${task.commits} commit${task.commits === 1 ? "" : "s"})` : ""}`);
    if (task.prUrl) lines.push(`Pull request: #${task.prNumber} ${task.prUrl}`);
    if (task.resultText) lines.push("Your reply:", quote(clip(task.resultText, 2500)));
    if (task.error) lines.push(`Error: ${clip(task.error, 500)}`);
    return lines.join("\n");
  });
  return [
    "## Your previous work here",
    "You have worked on this thread before. Use this as context and build on it rather than starting over.",
    "",
    entries.join("\n\n"),
  ].join("\n");
}

export function buildPrompt(input: {
  agent: Agent;
  task: Task;
  thread: ThreadContext;
  history: Task[];
  workspace: WorkspaceInfo;
}): string {
  const { agent, task, thread, history, workspace } = input;
  const kind = KIND_LABEL[thread.kind];
  const repo = `${task.owner}/${task.repo}`;

  const workspaceText = workspace.willPush
    ? [
        `Your current directory is a git checkout of ${repo} on branch \`${workspace.branch}\` (based on \`${workspace.baseBranch}\`).`,
        "Make the changes needed directly in this directory. You may commit; anything left uncommitted is committed for you.",
        thread.kind === "pull"
          ? "When you finish, the orchestrator pushes the branch, which updates this pull request."
          : "When you finish, the orchestrator pushes the branch and opens (or updates) a pull request.",
        "Do not push, change branches, or rewrite history yourself.",
      ].join("\n")
    : [
        `Your current directory is a git checkout of ${repo} on branch \`${workspace.branch}\`.`,
        workspace.canPush
          ? "You are configured as a read-only agent: your changes won't be pushed, so answer in your reply."
          : "This pull request comes from a fork, so changes can't be pushed. Explain or suggest changes in your reply.",
      ].join("\n");

  const conversation = thread.comments
    .filter((comment) => !comment.fromOrchestrator)
    .map((comment) => `**@${comment.author}** (${comment.createdAt.slice(0, 16).replace("T", " ")}):\n${quote(clip(comment.body, 4000))}`);

  const inline = thread.reviewComments.map(
    (comment) => `**@${comment.author}** on \`${comment.path}${comment.line ? `:${comment.line}` : ""}\`:\n${quote(clip(comment.body, 2000))}`,
  );

  const sections = [
    `You are "${agent.name}" (GitHub handle @${agent.handle}), an AI agent working on the GitHub repository ${repo}.`,
    `@${task.requestedBy} asked you for help on ${kind} #${thread.number}: "${thread.title}" (${thread.url}).`,
    "",
    "## Request",
    quote(clip(task.requestText, 20_000)),
    "",
    "## Working copy",
    workspaceText,
    "",
    `## The ${kind}`,
    `**${thread.title}** — opened by @${thread.author}, ${thread.state}`,
    thread.body.trim() ? clip(thread.body, 20_000) : "_(no description)_",
  ];
  if (thread.pull) {
    sections.push("", `Head branch: \`${thread.pull.headRef}\`${thread.pull.isFork ? ` (from fork ${thread.pull.headRepo ?? "unknown"})` : ""} → base \`${thread.pull.baseRef}\``);
  }
  if (conversation.length) sections.push("", "## Conversation so far (oldest first)", conversation.join("\n\n"));
  if (inline.length) sections.push("", "## Inline review comments", inline.join("\n\n"));
  const historyText = historySection(history);
  if (historyText) sections.push("", historyText);
  sections.push(
    "",
    "## How to reply",
    "When you are done, end with a concise summary for the people on GitHub: what you changed (or found), anything left to do, and any question you need answered. It is posted as a comment.",
  );

  const prompt = sections.join("\n");
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + "\n…(prompt truncated)" : prompt;
}
