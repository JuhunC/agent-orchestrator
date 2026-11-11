import { config } from "../config.ts";
import { describeRelations, isIssueBranch } from "../github/relations.ts";
import { RESULT_MARKER, type ThreadContext } from "../github/threads.ts";
import type { GithubPermissions } from "../profiles/types.ts";
import type { Task } from "../types.ts";

type Agent = { name: string; handle: string; github?: Pick<GithubPermissions, "subIssues" | "relations" | "mergeIntoParent"> & Partial<Pick<GithubPermissions, "startRelated">> };

export interface WorkspaceInfo {
  branch: string;
  baseBranch: string;
  /** Where work goes when it isn't a sub-issue's (the configured base branch, else the default branch), and where that was set. */
  targetBranch?: string;
  targetFrom?: string | null;
  canPush: boolean;
  /** False when the agent is configured not to push or open PRs. */
  willPush: boolean;
  /** The working copy is as the last attempt left it, not refreshed from GitHub. */
  kept?: boolean;
}

/** A run one of the agent's schedules started. */
export interface ScheduleRun {
  id: number;
  name: string;
  /** When it runs, in words ("every weekday at 09:00 UTC"). */
  description: string;
  /** Which run this is (1 = the first). */
  run: number;
  /** Who set it up, in words ("@alice in the admin UI", "your agent.md"). */
  setUpBy: string;
  /** The agent may change or delete it (its schedule tools, and not from agent.md). */
  canChange: boolean;
  /** When the run before this one started. */
  previousRunAt: string | null;
}

/** A task that paused itself (wait_for) and is being resumed. */
export interface Woke {
  /** What it waited for ("this issue's sub-issues are closed"). */
  waited: string;
  /** Why it goes on now ("all 3 sub-issues are closed (#4, #5, #6)"). */
  happened: string;
  /** What reached the agent while it was paused, as a message for it. */
  note: string | null;
  /** The texts in that message, so the same comments aren't shown twice. */
  said: string[];
}

function wokeLine(woke: Woke): string {
  return `You paused this task until ${woke.waited}. It has been resumed because ${woke.happened}.`;
}

function scheduleSection(schedule: ScheduleRun): string {
  const since = schedule.previousRunAt ? `the last run (${schedule.previousRunAt.slice(0, 16).replace("T", " ")} UTC)` : "it was set up";
  return [
    "## This schedule",
    `"${schedule.name}" (schedule #${schedule.id}) runs ${schedule.description}, and this is run ${schedule.run}. It was set up by ${schedule.setUpBy}.`,
    `The request is the same on every run. Look at the thread and your earlier runs for what has changed since ${since}, and don't redo work that's done. If there's nothing new worth reporting, say so in a line or two.`,
    schedule.canChange
      ? `If the job this schedule exists for is finished for good, delete it with delete_schedule (id ${schedule.id}); to change its timing or request, use update_schedule.`
      : "Only a person can change or stop this schedule (in the admin UI, under Schedules).",
  ].join("\n");
}

const MAX_PROMPT = 100_000;
/** Room kept for the headings and "left out" lines added around trimmed lists. */
const HEADINGS = 1_000;
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

/** "(3 earlier comments left out…)": said in the prompt wherever the oldest entries had to go. */
function leftOut(count: number, what: string, where = ""): string[] {
  return count ? [`_(${count} earlier ${what}${count === 1 ? "" : "s"} left out to keep this prompt short${where})_`] : [];
}

/**
 * Makes lists of prompt entries (each oldest first) fit into `room` characters by leaving out the
 * oldest: first from lists over their share of the room, in the order given, then from any list.
 * The newest entry of each list stays. Cuts the lists in place; returns how many each one lost.
 */
function fit(lists: { entries: string[]; share: number }[], room: number): number[] {
  const size = (entries: string[]) => entries.reduce((sum, entry) => sum + entry.length + 2, 0);
  let total = lists.reduce((sum, list) => sum + size(list.entries), 0);
  const lost = lists.map(() => 0);
  for (const keepShare of [true, false]) {
    for (const [index, list] of lists.entries()) {
      let own = size(list.entries);
      const floor = keepShare ? list.share * room : 0;
      while (total > room && list.entries.length > 1 && own > floor) {
        const gone = list.entries.shift()!.length + 2;
        own -= gone;
        total -= gone;
        lost[index]!++;
      }
    }
  }
  return lost;
}

/**
 * The prompt from its start and its end. The end (board stage, how to reply) is what tells the
 * agent what to do, so when it's still too long after trimming, the cut is made before it.
 */
function assemble(head: string[], tail: string[]): string {
  const start = head.join("\n");
  const end = tail.join("\n");
  if (start.length + end.length + 1 <= MAX_PROMPT) return `${start}\n${end}`;
  return `${start.slice(0, Math.max(0, MAX_PROMPT - end.length - 60))}\n…(cut here to keep the prompt short)\n${end}`.slice(-MAX_PROMPT);
}

const commentEntry = (comment: { author: string; createdAt: string; body: string }) => `**@${comment.author}** (${comment.createdAt.slice(0, 16).replace("T", " ")}):\n${quote(clip(comment.body, 4000))}`;
const handoffEntry = (handoff: BoardStage["handoffs"][number]) =>
  `**${handoff.agent}** (${handoff.fromColumn} → ${handoff.toColumn}, ${handoff.ts.slice(0, 16).replace("T", " ")}):\n${quote(clip(handoff.note, 3000))}`;

function historyEntries(history: Task[]): string[] {
  return history.map((task) => {
    const where = `${KIND_LABEL[task.threadKind]} #${task.threadNumber}`;
    const lines = [
      `### Run ${task.id} — ${task.finishedAt?.slice(0, 16).replace("T", " ") ?? task.createdAt.slice(0, 16)} UTC on ${where} (${ended(task)})`,
      `Requested by @${task.requestedBy}:`,
      quote(clip(task.requestText, 1500)),
    ];
    if (task.branch) lines.push(`Branch: \`${task.branch}\`${task.commits ? ` (${task.commits} commit${task.commits === 1 ? "" : "s"})` : ""}`);
    if (task.prUrl) lines.push(`Pull request: #${task.prNumber} ${task.prUrl}`);
    if (task.resultText) lines.push("Your reply:", quote(clip(task.resultText, 2500)));
    if (task.error) lines.push(`Error: ${clip(task.error, 500)}`);
    return lines.join("\n");
  });
}

/** What other agents did or are doing on the thread: who, when, how it ended and the start of what they said. */
function otherEntries(others: Task[]): string[] {
  return others.map((task) => {
    const where = `${KIND_LABEL[task.threadKind]} #${task.threadNumber}`;
    const active = task.status === "running" ? "working on it now" : task.status !== "queued" ? null : task.waitReason === "wake" ? `paused until other work is done${task.waitFor?.note ? ` (${clip(task.waitFor.note, 200).split("\n").join(" ")})` : ""}` : "waiting to start";
    const lines = [
      active
        ? `### ${task.agent} — ${active} on ${where} (task ${task.id})`
        : `### ${task.agent} — run ${task.id}, ${task.finishedAt?.slice(0, 16).replace("T", " ") ?? task.createdAt.slice(0, 16)} UTC on ${where} (${ended(task)})`,
      `Asked by @${task.requestedBy}: ${clip(task.requestText, 400).split("\n").join(" ")}`,
    ];
    if (task.branch) lines.push(`Branch: \`${task.branch}\`${task.commits ? ` (${task.commits} commit${task.commits === 1 ? "" : "s"})` : ""}`);
    if (task.prUrl) lines.push(`Pull request: #${task.prNumber} ${task.prUrl}`);
    if (task.resultText) lines.push("Its reply began:", quote(clip(task.resultText, 1200)));
    if (task.error && !active) lines.push(`Error: ${clip(task.error, 300)}`);
    return lines.join("\n");
  });
}

function othersSection(entries: string[], lost: number, sinceLastRun = false): string {
  if (!entries.length) return "";
  return [
    sinceLastRun ? "## Other agents here since your last run" : "## Other agents' work here",
    "Other agents work on this thread too. Build on what they did rather than repeating it, and don't undo it without saying why. If one is working now, don't change the same files it's likely to be changing.",
    "",
    ...leftOut(lost, "run"),
    entries.join("\n\n"),
  ].join("\n");
}

function historySection(entries: string[], lost: number): string {
  if (!entries.length) return "";
  return [
    "## Your previous work here",
    "You have worked on this thread before. Use this as context and build on it rather than starting over.",
    "",
    ...leftOut(lost, "run"),
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
        ...(thread.kind !== "pull" && workspace.targetFrom && workspace.baseBranch === workspace.targetBranch
          ? [`Work in this repository goes into \`${workspace.targetBranch}\` (the base branch set ${workspace.targetFrom}), not the default branch \`${thread.defaultBranch}\`: open_pull_request targets it, so compare with and merge from \`origin/${workspace.targetBranch}\`.`]
          : []),
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
  const target = workspace.targetBranch ?? thread.defaultBranch;
  if (parent && isIssueBranch(workspace.baseBranch) && workspace.baseBranch !== target) {
    lines.push(
      "",
      `This is a sub-issue of #${parent.number}: your branch \`${workspace.branch}\` starts from the parent's branch \`${workspace.baseBranch}\`, and your work merges into that branch, not into \`${target}\`${workspace.willPush ? " (open_pull_request targets it)" : ""}.${github?.mergeIntoParent ? " When your work is pushed and done, merge it there with merge_into_parent." : ""}`,
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

/** Who the agent may pass the thread to (route_to_agent). */
export interface RoutingInfo {
  /** Nobody named an agent, and routing the thread is this task's whole job. */
  triage: boolean;
  /** The other agents, with how much each has to do right now. */
  agents: { name: string; handle: string; description: string; running: number; queued: number }[];
}

function routingSection(routing: RoutingInfo, kind: string): string {
  const load = (agent: RoutingInfo["agents"][number]) => [agent.running ? `${agent.running} running` : "", agent.queued ? `${agent.queued} waiting` : ""].filter(Boolean).join(", ") || "free";
  const agents = routing.agents.length
    ? routing.agents.map((agent) => `- **${agent.name}** (@${agent.handle}): ${clip(agent.description, 300) || "no description"} (now: ${load(agent)})`)
    : ["- _(there's no other agent right now)_"];
  if (routing.triage) {
    return [
      "## Routing",
      `Nobody said which agent this ${kind} is for, so it came to you to route. Read it, decide whose kind of work it is, and pass it on with route_to_agent, giving the reason in a sentence. Don't do the work yourself and don't change the ${kind}.`,
      "When two agents fit equally, prefer the one with less to do. When it takes more than one (a design, then the code), pass it to the one that goes first and say so in the instructions. When no agent fits, or it isn't clear what is being asked, pass it to nobody: say in your reply what's missing, for a person to answer, and call report_outcome (blocked).",
      "",
      "The agents:",
      ...agents,
    ].join("\n");
  }
  return [
    "## Passing this on",
    "If this is another agent's kind of work and not yours, pass it on with route_to_agent (with the reason) rather than do it badly or turn it down. The agent starts when you finish. It hands the whole request over: it isn't for getting help with part of it.",
    "",
    "The other agents:",
    ...agents,
  ].join("\n");
}

/** How to end a task. The wait_for sentence is left out when pausing is switched off (WAIT_MAX_HOURS=0). */
function replyInstructions(): string {
  return [
    "When you are done, end with a concise summary for the people on GitHub: what you changed (or found), anything left to do, and any question you need answered. It is posted as a comment.",
    ...(config.waitMaxHours > 0
      ? ["If you can only go on once other work is done (sub-issues, a blocking issue, a merge or a review), call wait_for instead of finishing: the task pauses and you are resumed here when that has happened."]
      : []),
    "If you did not fully do what was asked, call report_outcome first (partial, blocked or gave_up, with a short note), so the task isn't shown as done.",
  ].join(" ");
}

/** How a finished run ended, for the prompt: its status, and what its agent reported when that wasn't "done". */
function ended(task: Task): string {
  if (task.status !== "succeeded" || !task.outcome || task.outcome === "done") return task.status;
  return `${{ partial: "partly done", blocked: "blocked", gave_up: "gave up" }[task.outcome]}${task.outcomeNote ? `: ${clip(task.outcomeNote, 300).split("\n").join(" ")}` : ""}`;
}

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

/** `notes` are the handoff notes that fit (see handoffEntry), `lost` how many older ones didn't. */
function boardSection(stage: BoardStage, notes: string[], lost = 0): string {
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
    ...(notes.length ? ["", "### Handoff notes from earlier stages (oldest first)", ...leftOut(lost, "note"), notes.join("\n\n")] : []),
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
  schedule?: ScheduleRun | null;
  /** Other agents' tasks on the thread (db.othersOnThread); those since this agent's last run are shown. */
  others?: Task[];
  /** The task is resumed after its agent paused it; `since` is then when it paused. */
  woke?: Woke | null;
  /** The agents it may pass the thread to; null when it may not (or there are none). */
  routing?: RoutingInfo | null;
}): string {
  const { task, thread, workspace, since, interrupted, woke } = input;
  const kind = KIND_LABEL[thread.kind];
  const repo = `${task.owner}/${task.repo}`;
  // The task's own "paused" comment is no news to the agent that paused it.
  const ownNotice = (body: string) => Boolean(woke) && body.includes(RESULT_MARKER) && body.includes(`[task #${task.id}](`);
  const fresh = thread.comments.filter(
    (comment) => !comment.fromOrchestrator && !ownNotice(comment.body) && (!since || comment.createdAt > since) && comment.body.trim() !== task.requestText.trim() && !woke?.said.includes(comment.body.trim()),
  );
  const head = [
    woke
      ? `${wokeLine(woke)} Your work so far is in the working copy and in this session. Carry on where you left off and finish as instructed before. If you still can't go on, call wait_for again, or report_outcome.`
      : interrupted
        ? `You were interrupted while working on this (a usage limit, or the orchestrator restarted). Your uncommitted changes are still in the working copy. Continue where you left off.`
        : input.schedule
          ? `It's time for a scheduled run of "${input.schedule.name}" on ${kind} #${thread.number}: "${thread.title}" (${thread.url}).`
          : `@${task.requestedBy} has a new request for you on ${kind} #${thread.number}: "${thread.title}" (${thread.url}).`,
    "",
    input.schedule ? "## What to do on each run" : "## Request",
    quote(clip(task.requestText, 20_000)),
    ...(input.schedule ? ["", scheduleSection(input.schedule)] : []),
    ...(woke?.note ? ["", "## What came in while you were paused", woke.note] : []),
  ];
  const related = relatedSection(task, thread, workspace, input.agent);
  const tail = (notes: string[], lostNotes = 0) => [
    "",
    "## Working copy",
    `${workspaceSection(repo, thread, workspace)}\n${
      workspace.kept
        ? `Your unpublished work is still in it, so it hasn't been refreshed from GitHub. \`origin/${workspace.branch}\` is up to date: merge it if you need what was pushed since.`
        : "The branch has been refreshed from GitHub, so it includes anything pushed since your last run."
    }`,
    ...(related ? ["", related] : []),
    ...(input.board ? ["", boardSection(input.board, notes, lostNotes)] : []),
    ...(input.routing ? ["", routingSection(input.routing, kind)] : []),
    "",
    "## How to reply",
    replyInstructions(),
  ];
  // When it's too long, the oldest comments and handoff notes go, never the end of the prompt.
  const comments = fresh.map(commentEntry);
  const notes = (input.board?.handoffs ?? []).map(handoffEntry);
  const others = otherEntries((input.others ?? []).filter((other) => !other.finishedAt || !since || other.finishedAt > since));
  const room = MAX_PROMPT - head.join("\n").length - tail([]).join("\n").length - HEADINGS;
  const [lostComments, lostNotes, lostOthers] = fit(
    [
      { entries: comments, share: 0.6 },
      { entries: notes, share: 0.25 },
      { entries: others, share: 0.15 },
    ],
    room,
  );
  if (comments.length) head.push("", woke ? "## New on the thread since you paused (oldest first)" : "## New on the thread since your last run (oldest first)", ...leftOut(lostComments!, "comment", `; the thread has them: ${thread.url}`), comments.join("\n\n"));
  if (others.length) head.push("", othersSection(others, lostOthers!, Boolean(since)));
  return assemble(head, tail(notes, lostNotes));
}

export function buildPrompt(input: {
  agent: Agent;
  task: Task;
  thread: ThreadContext;
  history: Task[];
  /** Other agents' tasks on the thread (db.othersOnThread). */
  others?: Task[];
  workspace: WorkspaceInfo;
  board?: BoardStage | null;
  schedule?: ScheduleRun | null;
  /** The task is resumed after its agent paused it, in a session that doesn't remember it. */
  woke?: Woke | null;
  /** The agents it may pass the thread to; null when it may not (or there are none). */
  routing?: RoutingInfo | null;
}): string {
  const { agent, task, thread, history, workspace, woke } = input;
  const kind = KIND_LABEL[thread.kind];
  const repo = `${task.owner}/${task.repo}`;

  const workspaceText = workspaceSection(repo, thread, workspace);

  const conversation = thread.comments.filter((comment) => !comment.fromOrchestrator).map(commentEntry);

  const inline = thread.reviewComments.map(
    (comment) => `**@${comment.author}** on \`${comment.path}${comment.line ? `:${comment.line}` : ""}\`:\n${quote(clip(comment.body, 2000))}`,
  );

  // A triage task's request is the issue itself, which is shown below.
  const triage = Boolean(input.routing?.triage);
  const head = [
    `You are "${agent.name}" (GitHub handle @${agent.handle}), an AI agent working on the GitHub repository ${repo}.`,
    input.schedule
      ? `It's time for a scheduled run of "${input.schedule.name}" on ${kind} #${thread.number}: "${thread.title}" (${thread.url}).`
      : triage
        ? `@${task.requestedBy} opened ${kind} #${thread.number}: "${thread.title}" (${thread.url}) and named no agent, so it came to you, the triage agent, to pass to the agent that fits.`
        : `@${task.requestedBy} asked you for help on ${kind} #${thread.number}: "${thread.title}" (${thread.url}).`,
    ...(triage ? [] : ["", input.schedule ? "## What to do on each run" : "## Request", quote(clip(task.requestText, 20_000))]),
    ...(input.schedule ? ["", scheduleSection(input.schedule)] : []),
    ...(woke
      ? [
          "",
          "## You paused this task earlier",
          `${wokeLine(woke)} What you did before the pause is in the working copy and on the thread, not in this session: look at it first, then carry on from there instead of starting over. If you still can't go on, call wait_for again, or report_outcome.`,
          ...(woke.note ? ["", woke.note] : []),
        ]
      : []),
    "",
    "## Working copy",
    workspaceText,
    "",
    `## The ${kind}`,
    `**${thread.title}** — opened by @${thread.author}, ${thread.state}`,
    thread.body.trim() ? clip(thread.body, 20_000) : "_(no description)_",
  ];
  if (thread.pull) {
    head.push("", `Head branch: \`${thread.pull.headRef}\`${thread.pull.isFork ? ` (from fork ${thread.pull.headRepo ?? "unknown"})` : ""} → base \`${thread.pull.baseRef}\``);
  }
  const related = relatedSection(task, thread, workspace, agent);
  if (related) head.push("", related);
  const tail = (notes: string[], lostNotes = 0) => [
    ...(input.board ? ["", boardSection(input.board, notes, lostNotes)] : []),
    ...(input.routing ? ["", routingSection(input.routing, kind)] : []),
    "",
    "## How to reply",
    replyInstructions(),
  ];

  // A long thread doesn't fit: the oldest comments go first, then the oldest inline comments,
  // handoff notes, other agents' runs and its own earlier runs. The request, the issue and the end of the prompt always stay.
  const notes = (input.board?.handoffs ?? []).map(handoffEntry);
  const runs = historyEntries(history);
  const others = otherEntries(input.others ?? []);
  const room = MAX_PROMPT - head.join("\n").length - tail([]).join("\n").length - HEADINGS;
  const [lostComments, lostInline, lostNotes, lostOthers, lostRuns] = fit(
    [
      { entries: conversation, share: 0.45 },
      { entries: inline, share: 0.15 },
      { entries: notes, share: 0.15 },
      { entries: others, share: 0.1 },
      { entries: runs, share: 0.15 },
    ],
    room,
  );
  if (conversation.length) head.push("", "## Conversation so far (oldest first)", ...leftOut(lostComments!, "comment", `; the thread has them: ${thread.url}`), conversation.join("\n\n"));
  if (inline.length) head.push("", "## Inline review comments", ...leftOut(lostInline!, "inline comment"), inline.join("\n\n"));
  const historyText = historySection(runs, lostRuns!);
  if (historyText) head.push("", historyText);
  if (others.length) head.push("", othersSection(others, lostOthers!));
  return assemble(head, tail(notes, lostNotes));
}
