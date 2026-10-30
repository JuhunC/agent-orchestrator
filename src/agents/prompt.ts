import { describeRelations } from "../github/relations.ts";
import type { ThreadContext } from "../github/threads.ts";
import type { GithubPermissions } from "../profiles/types.ts";
import type { Task } from "../types.ts";

type Agent = { name: string; handle: string; github?: Pick<GithubPermissions, "subIssues" | "relations" | "mergeIntoParent"> & Partial<Pick<GithubPermissions, "startRelated">> };

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

function workspaceSection(repo: string, thread: ThreadContext, workspace: WorkspaceInfo): string {
  return workspace.willPush
    ? [
        `Your current directory is a git checkout of ${repo} on branch \`${workspace.branch}\` (based on \`${workspace.baseBranch}\`).`,
        "Make the changes needed directly in this directory and commit as you go if you like.",
        thread.kind === "pull"
          ? "Publish with the github tool commit_and_push; that updates this pull request."
          : "Publish with the github tools: commit_and_push, then open_pull_request.",
        "Don't change branches or rewrite history that's already pushed.",
      ].join("\n")
    : [
        `Your current directory is a git checkout of ${repo} on branch \`${workspace.branch}\`.`,
        workspace.canPush
          ? "You can't push from this agent, so answer in your reply."
          : "This pull request comes from a fork, so changes can't be pushed. Explain or suggest changes in your reply.",
      ].join("\n");
}

/** Parent, sub-issues and dependencies, and what they mean for the agent's branch. Empty when there are none. */
function relatedSection(task: Task, thread: ThreadContext, workspace: WorkspaceInfo, agent?: Agent): string {
  const lines = describeRelations(thread.relations, task.owner, task.repo);
  if (!lines.length) return "";
  const github = agent?.github;
  const parent = thread.relations.parent;
  if (parent && workspace.baseBranch !== thread.defaultBranch) {
    lines.push(
      "",
      `This is a sub-issue of #${parent.number}: your branch \`${workspace.branch}\` starts from the parent's branch \`${workspace.baseBranch}\`, and your work merges into that branch, not into \`${thread.defaultBranch}\`${workspace.willPush ? " (open_pull_request targets it)" : ""}.${github?.mergeIntoParent ? " When your work is pushed and done, merge it there with merge_into_parent." : ""}`,
    );
  }
  if (thread.relations.subIssues.length && github && github.subIssues !== "none") {
    lines.push("", `Sub-issues merge their work into this issue's branch \`${workspace.branch}\`. Check it all arrived with list_sub_issues: each sub-issue's branch head must be an ancestor of this branch.`);
  }
  const startable = (github?.startRelated ?? []).filter((relation) =>
    relation === "parent" ? Boolean(parent) : relation === "sub_issue" ? thread.relations.subIssues.length > 0 : relation === "blocked_by" ? thread.relations.blockedBy.length > 0 : thread.relations.blocking.length > 0,
  );
  if (startable.length) {
    const which = startable.map((relation) => ({ parent: "the parent", sub_issue: "a sub-issue", blocked_by: "an issue blocking this one", blocks: "an issue this one blocks" })[relation]).join(", ");
    lines.push(
      "",
      `When ${which} needs its agent to act on what you did (for example: your work is merged into the parent's branch, or a blocker is done), start that agent with start_related_agent and say what you did and what it should do. It starts when you finish. Don't start agents just to report progress.`,
    );
  }
  return ["## Related issues", ...lines].join("\n");
}

const REPLY_INSTRUCTIONS =
  "When you are done, end with a concise summary for the people on GitHub: what you changed (or found), anything left to do, and any question you need answered. It is posted as a comment.";

/**
 * The prompt for an agent session that already knows this thread (a live session, or one resumed
 * with --resume): only what's new since its last run, to save tokens.
 */
/** The board stage a task belongs to, for its prompt. */
export interface BoardStage {
  board: string;
  column: string;
  role: string;
  moves: string[];
  needsHuman: string | null;
  /** Other agents working this card in the same column at the same time ("all" columns). */
  peers?: string[];
  handoffs: { agent: string; fromColumn: string; toColumn: string; note: string; ts: string }[];
  /** What the orchestrator checks before a move into each target column that has rules. */
  requirements?: { column: string; text: string }[];
  /** The card's work type, when the board has work types and the card matches one. */
  workType?: { name: string; label: string; forbid: string[] } | null;
  /** The board's sub_issues settings, when this agent may create sub-issues and the board uses them. */
  subIssues?: { column: string | null; movesTo: string[] } | null;
  /** The agent may merge a sub-issue into its parent's branch. */
  mergeIntoParent?: boolean;
  /** The project fields the board tracks per card, and this card's values, when the agent may set them. */
  fields?: {
    start: string | null;
    end: string | null;
    estimate: string | null;
    startOn: string[];
    endOn: string[];
    values: { start?: string | null; end?: string | null; estimate?: number | null };
  } | null;
}

function fieldsLines(fields: NonNullable<BoardStage["fields"]>): string[] {
  const parts = [
    ...(fields.start ? [`start date ("${fields.start}"): ${fields.values.start ?? "not set"}`] : []),
    ...(fields.end ? [`end date ("${fields.end}"): ${fields.values.end ?? "not set"}`] : []),
    ...(fields.estimate ? [`estimate ("${fields.estimate}"): ${fields.values.estimate ?? "not set"}`] : []),
  ];
  const auto = [
    ...(fields.startOn.length ? [`the start date is filled in when the card enters ${fields.startOn.map((name) => `"${name}"`).join(" or ")}`] : []),
    ...(fields.endOn.length ? [`the end date when it enters ${fields.endOn.map((name) => `"${name}"`).join(" or ")}`] : []),
  ];
  return [
    `The project tracks this card's ${parts.join("; ")}. Set them with set_card_fields (dates as YYYY-MM-DD) when you plan or learn something that changes them.`,
    ...(auto.length ? [`The orchestrator also does it for you: ${auto.join(", and ")}.`] : []),
  ];
}

function boardSection(stage: BoardStage): string {
  const notes = stage.handoffs.map((handoff) => `**${handoff.agent}** (${handoff.fromColumn} → ${handoff.toColumn}, ${handoff.ts.slice(0, 16).replace("T", " ")}):\n${quote(clip(handoff.note, 3000))}`);
  return [
    `## Your stage on the ${stage.board} board: "${stage.column}"`,
    "This issue is a card on a GitHub Project board. Each column has an agent with its own job; yours is below.",
    "",
    stage.role.trim() || "_(no role text)_",
    "",
    `When your part is done, call the github tool move_to_column with one of: ${stage.moves.map((move) => `"${move}"`).join(", ")}, and a handoff note for whoever works the card next.`,
    ...(stage.workType ? [`This card is a ${stage.workType.name} (label "${stage.workType.label}"), so it can't go to: ${stage.workType.forbid.map((name) => `"${name}"`).join(", ")}.`] : []),
    ...(stage.requirements?.length
      ? [
          "Before a move, the orchestrator checks what the target column requires, and refuses the move with what's missing:",
          ...stage.requirements.map((requirement) => `- "${requirement.column}": ${requirement.text}`),
          "Pass handoff fields in move_to_column's `fields`. Get the evidence before you move, and don't change files after moving.",
        ]
      : []),
    ...(stage.fields ? fieldsLines(stage.fields) : []),
    ...(stage.subIssues?.column ? [`Sub-issues you create with create_sub_issue are added to this board in "${stage.subIssues.column}" when you finish.`] : []),
    ...(stage.subIssues?.movesTo.length
      ? [`You can move this card's sub-issues with move_sub_issue to: ${stage.subIssues.movesTo.map((name) => `"${name}"`).join(", ")}. Those moves happen when you finish, and are checked like yours.`]
      : []),
    stage.needsHuman ? `If you're blocked or unsure, move it to "${stage.needsHuman}" and explain why.` : "",
    stage.peers?.length
      ? `Other agents are working this card in this column at the same time: ${stage.peers.join(", ")}. Your move_to_column is a vote: the card moves when all of you finish, and if any of you sends it back, it goes back. Don't push changes another agent might also be making.`
      : "If you don't move the card, it stays in this column.",
    stage.mergeIntoParent ? "Never merge into the default branch: merge_into_parent only merges a sub-issue's work into its parent issue's branch." : "Never merge pull requests.",
    ...(notes.length ? ["", "### Handoff notes from earlier stages (oldest first)", notes.join("\n\n")] : []),
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

export function buildFollowUpPrompt(input: {
  agent?: Agent;
  task: Task;
  thread: ThreadContext;
  workspace: WorkspaceInfo;
  /** When this agent last finished on the thread; comments after it are new. */
  since: string | null;
  /** The previous attempt stopped at a usage limit. */
  interrupted: boolean;
  board?: BoardStage | null;
}): string {
  const { task, thread, workspace, since, interrupted } = input;
  const kind = KIND_LABEL[thread.kind];
  const repo = `${task.owner}/${task.repo}`;
  const fresh = thread.comments.filter((comment) => !comment.fromOrchestrator && (!since || comment.createdAt > since) && comment.body.trim() !== task.requestText.trim());
  const sections = [
    interrupted
      ? `You were interrupted while working on this (a usage limit, or the orchestrator restarted). Your uncommitted changes are still in the working copy. Continue where you left off.`
      : `@${task.requestedBy} has a new request for you on ${kind} #${thread.number}: "${thread.title}" (${thread.url}).`,
    "",
    "## Request",
    quote(clip(task.requestText, 20_000)),
  ];
  if (fresh.length) {
    sections.push(
      "",
      "## New on the thread since your last run (oldest first)",
      fresh.map((comment) => `**@${comment.author}** (${comment.createdAt.slice(0, 16).replace("T", " ")}):\n${quote(clip(comment.body, 4000))}`).join("\n\n"),
    );
  }
  sections.push(
    "",
    "## Working copy",
    `${workspaceSection(repo, thread, workspace)}\nThe branch has been refreshed from GitHub, so it includes anything pushed since your last run.`,
    ...(relatedSection(task, thread, workspace, input.agent) ? ["", relatedSection(task, thread, workspace, input.agent)] : []),
    ...(input.board ? ["", boardSection(input.board)] : []),
    "",
    "## How to reply",
    REPLY_INSTRUCTIONS,
  );
  const prompt = sections.join("\n");
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + "\n…(prompt truncated)" : prompt;
}

export function buildPrompt(input: {
  agent: Agent;
  task: Task;
  thread: ThreadContext;
  history: Task[];
  workspace: WorkspaceInfo;
  board?: BoardStage | null;
}): string {
  const { agent, task, thread, history, workspace } = input;
  const kind = KIND_LABEL[thread.kind];
  const repo = `${task.owner}/${task.repo}`;

  const workspaceText = workspaceSection(repo, thread, workspace);

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
  const related = relatedSection(task, thread, workspace, agent);
  if (related) sections.push("", related);
  if (conversation.length) sections.push("", "## Conversation so far (oldest first)", conversation.join("\n\n"));
  if (inline.length) sections.push("", "## Inline review comments", inline.join("\n\n"));
  const historyText = historySection(history);
  if (historyText) sections.push("", historyText);
  sections.push(
    ...(input.board ? ["", boardSection(input.board)] : []),
    "",
    "## How to reply",
    REPLY_INSTRUCTIONS,
  );

  const prompt = sections.join("\n");
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + "\n…(prompt truncated)" : prompt;
}
