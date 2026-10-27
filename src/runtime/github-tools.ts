import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../config.ts";
import { getBoardItem, linkedThreads, linkThreads, listBoardItems, type CardFieldValues } from "../db.ts";
import { installationToken, repoRemoteUrl, type GitHubClient } from "../github/app.ts";
import { ciStatus, fetchThread, findOpenPull, openPull, postComment, updatePull, type ThreadContext } from "../github/threads.ts";
import { errorMessage } from "../log.ts";
import type { Profile } from "../profiles/types.ts";
import { listWikiPages, readWikiPage, writeWikiPage } from "../github/wiki.ts";
import { git, GitError } from "../runner/git.ts";
import { mention } from "../runner/progress.ts";
import type { EventKind, Task } from "../types.ts";
import { allowedMoves, canMove, type Board } from "../boards/loader.ts";
import { HANDOFF_FIELDS, hasCardFields, renderHandoff, type HandoffField, type HandoffFields } from "../boards/rules.ts";
import { setCardFields } from "../boards/engine.ts";
import {
  addBlockedBy,
  addSubIssue,
  describeRelations,
  getIssue,
  issueBranch,
  isIssueBranch,
  listSubIssues,
  RELATIONS,
  refText,
  removeBlockedBy,
  removeSubIssue,
  sameRepo,
  toIssueRef,
  type IssueRef,
} from "../github/relations.ts";
import { cardMoveProblems, cardWorkType, moveProblems, type ReviewRecord, type TestRun } from "./evidence.ts";
import { checkSubIssues, describeSubIssueWork, fetchBranch, isAncestor } from "./sub-issues.ts";
import { ensureBaseBranch, excludeFromGit, parentBranchFor, type Workspace } from "./workspace.ts";

/** Set when the task came from a project board column. */
export interface BoardContext {
  board: Board;
  column: string;
  itemId: string;
  /** Where the agent asked to move the card; done when the task finishes successfully. */
  pendingMove: { to: string; note: string } | null;
  /** Test commands the orchestrator saw finish in this task (for `tests` evidence). */
  testRuns: TestRun[];
  /** Reviews the agent submitted in this task (for `review` and `approval` evidence). */
  reviews: ReviewRecord[];
  /** Sub-issue cards the agent asked to move (move_sub_issue); done when the task finishes successfully. */
  subMoves: SubIssueMove[];
  /** Sub-issues the agent created, to add to the board's sub_issues.column when the task finishes. */
  newSubIssues: IssueRef[];
  /** Start/end/estimate for sub-issues that aren't on the board yet, set when they're added. */
  subIssueFields: Record<number, CardFieldValues>;
}

/** A parent's agent moving one of its sub-issue cards. */
export interface SubIssueMove {
  issue: IssueRef;
  /** The card, or null when the sub-issue isn't on the board yet (it's added in the target column). */
  itemId: string | null;
  from: string | null;
  to: string;
  note: string;
  fields: HandoffFields;
}

/** What the GitHub tools act on. Live sessions swap it for each task. */
export interface ToolContext {
  task: Task;
  profile: Profile;
  thread: ThreadContext;
  workspace: Workspace;
  gh: GitHubClient;
  onEvent: (kind: EventKind, message: string) => void;
  /** Called when the agent opens (or finds) the pull request. */
  onPullRequest: (pr: { number: number; url: string }) => void;
  comments: number;
  pushes: number;
  /** Sub-issues created in this task (create_sub_issue). */
  subIssuesCreated?: number;
  board: BoardContext | null;
}

const MAX_COMMENTS_PER_TASK = 10;
const MAX_SUB_ISSUES_PER_TASK = 20;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-27");
const FIELD_ARGS = {
  start: DATE.nullable().optional().describe("Start date, YYYY-MM-DD (null clears it)"),
  end: DATE.nullable().optional().describe("End date, YYYY-MM-DD (null clears it)"),
  estimate: z.number().nonnegative().nullable().optional().describe("Estimate, in the team's unit (null clears it)"),
};

/** The card field values given in a tool call, checked; a string is a reason to refuse. */
function fieldValues(args: CardFieldValues, known: CardFieldValues = {}): CardFieldValues | string {
  const values: CardFieldValues = {};
  for (const key of ["start", "end", "estimate"] as const) if (args[key] !== undefined) values[key] = args[key] as never;
  for (const key of ["start", "end"] as const) {
    const value = values[key];
    if (value && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) return `${value} isn't a real date.`;
  }
  const start = values.start !== undefined ? values.start : known.start;
  const end = values.end !== undefined ? values.end : known.end;
  if (start && end && start > end) return `The start date (${start}) is after the end date (${end}).`;
  return values;
}

function describeFields(values: CardFieldValues, names: { start: string | null; end: string | null; estimate: string | null }): string {
  return (["start", "end", "estimate"] as const)
    .filter((key) => values[key] !== undefined)
    .map((key) => `${names[key] ?? key} ${values[key] === null ? "cleared" : values[key]}`)
    .join(", ");
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Commits anything uncommitted and pushes the task's branch. Shared with the end-of-task safety net. */
export async function commitAndPush(ctx: ToolContext, message: string): Promise<{ pushed: number; sha: string; files: string[] }> {
  const { workspace, task } = ctx;
  const { dir } = workspace;
  await git(dir, ["add", "-A"]);
  if ((await git(dir, ["diff", "--cached", "--name-only"])).trim()) {
    const trailer = `\n\nRequested by ${mention(task.requestedBy)} in ${task.requestUrl || task.threadUrl}\nOrchestrator task #${task.id}`;
    await git(dir, ["commit", "--no-verify", "-m", message.trim() + trailer]);
  }
  const token = await installationToken(task.installationId);
  const remoteRef = `refs/remotes/origin/${workspace.branch}`;
  await git(dir, ["fetch", "origin", `+refs/heads/${workspace.branch}:${remoteRef}`], { token }).catch(() => undefined);
  const base = (await git(dir, ["rev-parse", "--verify", "--quiet", remoteRef]).catch(() => "")) || workspace.startSha;
  const ahead = Number(await git(dir, ["rev-list", "--count", `${base}..HEAD`]));
  const sha = await git(dir, ["rev-parse", "HEAD"]);
  if (!ahead) return { pushed: 0, sha, files: [] };
  const files = (await git(dir, ["diff", "--name-only", `${base}..HEAD`])).split("\n").filter(Boolean);
  try {
    await git(dir, ["push", "origin", `HEAD:refs/heads/${workspace.branch}`], { token });
  } catch (error) {
    if (!(error instanceof GitError) || !/rejected|non-fast-forward|fetch first/i.test(error.stderr)) throw error;
    // Someone else pushed to the branch: rebase onto it once and retry.
    try {
      await git(dir, ["rebase", remoteRef]);
    } catch {
      await git(dir, ["rebase", "--abort"]).catch(() => undefined);
      throw new Error(`The branch ${workspace.branch} changed on GitHub and your commits conflict with it. Resolve with \`git rebase ${remoteRef}\`, then try again.`);
    }
    await git(dir, ["push", "origin", `HEAD:refs/heads/${workspace.branch}`], { token });
  }
  ctx.pushes++;
  return { pushed: ahead, sha: await git(dir, ["rev-parse", "HEAD"]), files };
}

/** Thrown instead of opening a pull request when the issue already has MAX_PULL_REQUESTS_PER_ISSUE. */
export class PullRequestLimitError extends Error {}

// One PR check-and-open at a time per thread, so agents finishing together can't both slip under the limit.
const pullLocks = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (pullLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  pullLocks.set(key, next);
  void next.catch(() => undefined).finally(() => {
    if (pullLocks.get(key) === next) pullLocks.delete(key);
  });
  return next;
}

/**
 * Opens the task's pull request, or updates it if one is already open for the branch.
 * Throws PullRequestLimitError rather than open one past MAX_PULL_REQUESTS_PER_ISSUE.
 */
export async function openOrUpdatePullRequest(ctx: ToolContext, title: string, body: string, draft = false): Promise<{ number: number; url: string; created: boolean }> {
  const { task, thread, workspace, gh, profile } = ctx;
  const parent = workspace.baseBranch !== thread.defaultBranch ? thread.relations.parent : null;
  const link =
    thread.kind === "issue"
      ? `Closes #${thread.number}${parent ? ` · part of #${parent.number} (merges into \`${workspace.baseBranch}\`, the parent issue's branch)` : ""}`
      : `From discussion #${thread.number}: ${thread.url}`;
  const footer = `<sub>Opened by **${profile.name}** for ${mention(task.requestedBy)} · orchestrator task #${task.id}. Mention @${profile.handle} here to ask for changes.</sub>`;
  const fullBody = [body.trim(), "", link, "", footer].join("\n");
  const source = { owner: task.owner, repo: task.repo, kind: thread.kind, number: thread.number };
  const pr = await oneAtATime(`${task.owner}/${task.repo}/${thread.kind}/${thread.number}`.toLowerCase(), async () => {
    let result: { number: number; url: string; created: boolean };
    const existing = await findOpenPull(gh, task.owner, task.repo, workspace.branch);
    if (existing) {
      await updatePull(gh, task.owner, task.repo, existing.number, title, fullBody);
      result = { ...existing, created: false };
    } else {
      const limit = config.maxPullRequestsPerIssue;
      const opened = linkedThreads(source).filter((linked) => linked.kind === "pull");
      if (limit > 0 && opened.length >= limit) {
        const list = opened.map((linked) => `#${linked.number}`).join(", ");
        throw new PullRequestLimitError(
          `Didn't open a pull request: ${thread.kind} #${thread.number} already has ${opened.length} from agents (${list}) and MAX_PULL_REQUESTS_PER_ISSUE is ${limit}. The commits are on the branch ${workspace.branch}.`,
        );
      }
      if (thread.kind === "issue" && (await ensureBaseBranch(task, workspace, thread.defaultBranch))) {
        ctx.onEvent("system", `Created \`${workspace.baseBranch}\` on GitHub for the parent issue's work`);
      }
      const created = await openPull(gh, { owner: task.owner, repo: task.repo, head: workspace.branch, base: workspace.baseBranch, title, body: fullBody, draft });
      result = { ...created, created: true };
    }
    linkThreads(task.owner, task.repo, { kind: thread.kind, number: thread.number }, { kind: "pull", number: result.number });
    return result;
  });
  ctx.onPullRequest(pr);
  return pr;
}

/**
 * The orchestrator's GitHub tools, served in-process to the agent as the `github` MCP server.
 * The installation token stays in this process; the agent only sees the results.
 */
export function createGithubServer(profile: Profile, current: () => ToolContext | null, options: { cardFields?: boolean } = {}): McpSdkServerConfigWithInstance {
  const withContext = (handler: (ctx: ToolContext) => Promise<ToolResult>) => async (): Promise<ToolResult> => {
    const ctx = current();
    if (!ctx) return fail("No task is active.");
    try {
      return await handler(ctx);
    } catch (error) {
      return fail(errorMessage(error));
    }
  };

  const tools: SdkMcpToolDefinition<any>[] = [
    tool("get_thread", "Fetch the current issue, pull request or discussion with its latest comments, to see anything new.", {}, () =>
      withContext(async (ctx) => {
        const thread = await fetchThread(ctx.gh, ctx.task.owner, ctx.task.repo, ctx.task.threadKind, ctx.task.threadNumber);
        ctx.thread = thread;
        const comments = thread.comments
          .filter((comment) => !comment.fromOrchestrator)
          .map((comment) => `@${comment.author} (${comment.createdAt}):\n${comment.body}`)
          .join("\n\n---\n\n");
        const related = describeRelations(thread.relations, ctx.task.owner, ctx.task.repo);
        return ok(`# ${thread.title}\n${thread.url} (${thread.state})\n\n${thread.body}${related.length ? `\n\n## Related issues\n${related.join("\n")}` : ""}\n\n## Comments\n\n${comments || "(none)"}`);
      })(),
    ),
  ];

  if (profile.github.comment) {
    tools.push(
      tool(
        "post_comment",
        "Post a comment on the current issue, pull request or discussion. Use it to ask a question you need answered, or to share something important before you finish. Your final reply is posted for you; don't duplicate it.",
        { body: z.string().min(1).describe("Markdown comment") },
        (args) =>
          withContext(async (ctx) => {
            if (ctx.comments >= MAX_COMMENTS_PER_TASK) return fail(`You've already posted ${MAX_COMMENTS_PER_TASK} comments for this task.`);
            ctx.comments++;
            const posted = await postComment(ctx.gh, { owner: ctx.task.owner, repo: ctx.task.repo, kind: ctx.task.threadKind, number: ctx.task.threadNumber, threadNodeId: ctx.thread.nodeId }, `**${profile.name}:** ${args.body}`);
            ctx.onEvent("tool", "Posted a comment on GitHub");
            return ok(`Posted: ${posted.url}`);
          })(),
      ),
    );
  }

  if (profile.github.push) {
    tools.push(
      tool(
        "commit_and_push",
        "Commit all current changes in the working copy (if any) and push the branch to GitHub. Call it whenever your work is in a good state; on a pull request this updates the PR.",
        { message: z.string().min(1).describe("Commit message in the repository's style: a short summary line, then a blank line and details") },
        (args) =>
          withContext(async (ctx) => {
            if (!ctx.workspace.canPush) return fail("This branch can't be pushed (a pull request from a fork). Describe your changes in your reply instead.");
            const result = await commitAndPush(ctx, args.message);
            if (!result.pushed) return ok("Nothing new to push: no changes and no unpushed commits.");
            ctx.onEvent("tool", `Pushed ${result.pushed} commit${result.pushed === 1 ? "" : "s"} to \`${ctx.workspace.branch}\``);
            return ok(`Pushed ${result.pushed} commit(s) to ${ctx.workspace.branch} (now at ${result.sha.slice(0, 10)}). Changed files: ${result.files.join(", ")}`);
          })(),
      ),
    );
  }

  if (profile.github.pullRequest) {
    tools.push(
      tool(
        "open_pull_request",
        "Open a pull request for your pushed branch, or update its title and description if one is already open. Push with commit_and_push first.",
        {
          title: z.string().min(1).describe("What changes, in a few words"),
          body: z.string().describe("Summary, how it was tested, anything reviewers should look at. The issue link is added for you."),
          draft: z.boolean().optional().describe("Open as a draft"),
        },
        (args) =>
          withContext(async (ctx) => {
            if (ctx.task.threadKind === "pull") return ok(`You're already working on pull request #${ctx.task.threadNumber}; commit_and_push updates it.`);
            const token = await installationToken(ctx.task.installationId);
            const remote = await git(ctx.workspace.dir, ["ls-remote", "--heads", "origin", ctx.workspace.branch], { token });
            if (!remote.trim()) return fail(`The branch ${ctx.workspace.branch} isn't on GitHub yet. Call commit_and_push first.`);
            let pr: Awaited<ReturnType<typeof openOrUpdatePullRequest>>;
            try {
              pr = await openOrUpdatePullRequest(ctx, args.title, args.body, args.draft);
            } catch (error) {
              if (!(error instanceof PullRequestLimitError)) throw error;
              ctx.onEvent("system", error.message);
              return fail(`${error.message} Don't try again; say in your summary that the work is on that branch.`);
            }
            ctx.onEvent("tool", `${pr.created ? "Opened" : "Updated"} pull request #${pr.number}`);
            return ok(`${pr.created ? "Opened" : "Updated"} pull request #${pr.number}: ${pr.url}`);
          })(),
      ),
    );
  }

  tools.push(
    tool(
      "move_to_column",
      "Move this card on the project board when your part is done (board tasks only). The move happens after you finish, and the next column's agent receives your handoff note. Some columns require evidence or handoff fields; if something's missing the move is refused with what to fix.",
      {
        column: z.string().min(1).describe("Target column, from the allowed list in your instructions"),
        handoff: z.string().min(1).describe("Note for whoever works the card next: what you did, what's left, what to check"),
        fields: z
          .object(Object.fromEntries(HANDOFF_FIELDS.map((field) => [field, z.string().optional()])) as Record<HandoffField, z.ZodOptional<z.ZodString>>)
          .optional()
          .describe("Structured handoff: status, decisions, verified, open_questions, risks, do_not_redo. Fill the ones the target column requires."),
      },
      (args) =>
        withContext(async (ctx) => {
          if (!ctx.board) return fail("This task isn't from a project board, so there's no card to move.");
          const { board, column } = ctx.board;
          const target = Object.keys(board.columns).find((name) => name.toLowerCase() === args.column.toLowerCase()) ?? (board.needsHuman?.toLowerCase() === args.column.toLowerCase() ? board.needsHuman : null);
          if (!target || !canMove(board, column, target)) return fail(`You can't move the card from "${column}" to "${args.column}". Allowed: ${allowedMoves(board, column).join(", ")}.`);
          const problems = await moveProblems(ctx, target, args.fields ?? {});
          if (problems.length) {
            const allowed = allowedMoves(board, column, (await cardWorkType(ctx, board))?.type);
            ctx.onEvent("tool", `Move to ${target} refused: ${problems.length} requirement${problems.length === 1 ? "" : "s"} not met`);
            return fail(
              [
                `Can't move the card to "${target}" yet:`,
                ...problems.map((problem) => `- ${problem}`),
                `Fix these and call move_to_column again (allowed: ${allowed.join(", ")}).${board.needsHuman ? ` If you can't, move it to "${board.needsHuman}" and explain why.` : ""}`,
              ].join("\n"),
            );
          }
          ctx.board.pendingMove = { to: target, note: renderHandoff(args.handoff, args.fields ?? {}) };
          ctx.onEvent("tool", `Will move the card to ${target}`);
          const rules = board.columns[target]?.rules;
          const frozen = rules?.evidence.length ? " Don't change files or push after this: the evidence is checked again before the card moves." : "";
          return ok(`The card will move to "${target}" when you finish. Wrap up now.${frozen}`);
        })(),
    ),
  );

  if (profile.github.updateIssue && options.cardFields) {
    tools.push(
      tool(
        "set_card_fields",
        "Set this card's planning fields in the GitHub Project (board tasks only): start date, end date and estimate. Pass null to clear one. With number, set one of this issue's sub-issues instead.",
        { number: z.number().int().positive().optional().describe("A sub-issue's number; defaults to this card"), ...FIELD_ARGS },
        (args) =>
          withContext(async (ctx) => {
            if (!ctx.board) return fail("set_card_fields only works on a project board task.");
            const { board } = ctx.board;
            const { owner, repo, threadNumber } = ctx.task;
            if (!hasCardFields(board.fields)) return fail(`The ${board.name} board doesn't track a start date, end date or estimate (fields: in its board file).`);
            let itemId: string | null = ctx.board.itemId;
            let number = threadNumber;
            if (args.number && args.number !== threadNumber) {
              if (profile.github.subIssues !== "write") return fail("You can set this card's fields only (github.sub_issues: write also allows its sub-issues').");
              const subIssues = await listSubIssues(ctx.gh, owner, repo, threadNumber);
              if (!subIssues.some((issue) => issue.number === args.number && sameRepo(issue, owner, repo))) return fail(`#${args.number} isn't a sub-issue of #${threadNumber}.`);
              number = args.number;
              itemId = listBoardItems(board.name).find((row) => row.kind === "issue" && row.number === number && row.owner.toLowerCase() === owner.toLowerCase() && row.repo.toLowerCase() === repo.toLowerCase())?.itemId ?? null;
            }
            const values = fieldValues(args as CardFieldValues, itemId ? getBoardItem(board.name, itemId)?.fields : ctx.board.subIssueFields[number]);
            if (typeof values === "string") return fail(values);
            if (!Object.keys(values).length) return fail("Pass start, end and/or estimate.");
            if (!itemId) {
              if (!ctx.board.newSubIssues.some((issue) => issue.number === number) && !ctx.board.subMoves.some((move) => move.issue.number === number)) {
                return fail(`#${number} isn't on the ${board.name} board, so it has no project fields. Put it there with move_sub_issue first.`);
              }
              ctx.board.subIssueFields[number] = { ...ctx.board.subIssueFields[number], ...values };
              return ok(`#${number} isn't on the board yet; its ${describeFields(values, board.fields)} are set when it's added.`);
            }
            const set = await setCardFields(board, itemId, values);
            ctx.onEvent("tool", `Set #${number}'s ${describeFields(set, board.fields)}`);
            return ok(`Set #${number}'s ${describeFields(set, board.fields)}.`);
          })(),
      ),
    );
  }

  if (profile.github.updateIssue) {
    tools.push(
      tool(
        "update_issue",
        "Edit the current issue: its title, its description (e.g. to add acceptance criteria), or labels.",
        {
          title: z.string().optional(),
          body: z.string().optional().describe("The full new description (replaces the old one)"),
          add_labels: z.array(z.string()).optional(),
          remove_labels: z.array(z.string()).optional(),
        },
        (args) =>
          withContext(async (ctx) => {
            const { owner, repo, threadNumber, threadKind } = ctx.task;
            if (threadKind === "discussion") return fail("Discussions can't be edited with this tool.");
            if (args.title || args.body !== undefined) {
              await ctx.gh.rest.issues.update({ owner, repo, issue_number: threadNumber, ...(args.title ? { title: args.title } : {}), ...(args.body !== undefined ? { body: args.body } : {}) });
            }
            if (args.add_labels?.length) await ctx.gh.rest.issues.addLabels({ owner, repo, issue_number: threadNumber, labels: args.add_labels });
            for (const label of args.remove_labels ?? []) await ctx.gh.rest.issues.removeLabel({ owner, repo, issue_number: threadNumber, name: label }).catch(() => undefined);
            ctx.onEvent("tool", "Updated the issue");
            return ok("Updated the issue.");
          })(),
      ),
    );
  }

  if (profile.github.review) {
    tools.push(
      tool(
        "submit_review",
        "Submit a review on this task's pull request: approve it, request changes, or comment. Reviews never merge.",
        {
          event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
          body: z.string().min(1).describe("Your findings, with file:line references"),
        },
        (args) =>
          withContext(async (ctx) => {
            const { owner, repo } = ctx.task;
            const pr = ctx.task.threadKind === "pull" ? { number: ctx.task.threadNumber } : await findOpenPull(ctx.gh, owner, repo, ctx.workspace.branch);
            if (!pr) return fail("There's no open pull request for this task's branch yet.");
            try {
              await ctx.gh.rest.pulls.createReview({ owner, repo, pull_number: pr.number, event: args.event, body: args.body });
            } catch (error) {
              // GitHub doesn't let an app approve or block a PR it opened itself; leave the verdict as a comment review.
              if (args.event === "COMMENT" || !/own pull request|Can not (approve|request changes)/i.test(errorMessage(error))) throw error;
              const verdict = args.event === "APPROVE" ? "Approved" : "Changes requested";
              await ctx.gh.rest.pulls.createReview({ owner, repo, pull_number: pr.number, event: "COMMENT", body: `**${verdict}.**\n\n${args.body}` });
            }
            ctx.board?.reviews.push({ event: args.event, sha: await git(ctx.workspace.dir, ["rev-parse", "HEAD"]) });
            ctx.onEvent("tool", `Reviewed pull request #${pr.number}: ${args.event.toLowerCase().replace("_", " ")}`);
            return ok(`Submitted a ${args.event} review on #${pr.number}.`);
          })(),
      ),
    );
  }

  tools.push(
    tool("get_ci_status", "Show CI check results for the commit you last pushed.", {}, () =>
      withContext(async (ctx) => {
        const sha = await git(ctx.workspace.dir, ["rev-parse", "HEAD"]);
        return ok(await ciStatus(ctx.gh, ctx.task.owner, ctx.task.repo, sha));
      })(),
    ),
  );

  if (profile.github.clone) {
    tools.push(
      tool(
        "clone_repository",
        "Clone another repository the orchestrator can access (read-only) into .deps/<owner>/<repo> inside your working copy, for reference.",
        {
          repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("owner/name"),
          ref: z.string().optional().describe("Branch or tag; defaults to the default branch"),
        },
        (args) =>
          withContext(async (ctx) => {
            const [owner, name] = args.repository.split("/") as [string, string];
            const target = join(ctx.workspace.dir, ".deps", owner, name);
            const token = await installationToken(ctx.task.installationId);
            if (existsSync(join(target, ".git"))) {
              await git(target, ["fetch", "--depth", "1", "origin", args.ref ?? "HEAD"], { token });
              await git(target, ["checkout", "--force", "FETCH_HEAD"]);
            } else {
              mkdirSync(join(ctx.workspace.dir, ".deps", owner), { recursive: true });
              const clone = ["clone", "--depth", "1", ...(args.ref ? ["--branch", args.ref] : []), repoRemoteUrl(owner, name), target];
              await git(ctx.workspace.dir, clone, { token });
            }
            excludeFromGit(ctx.workspace.dir, "/.deps/");
            ctx.onEvent("tool", `Cloned ${args.repository}`);
            return ok(`Cloned ${args.repository} into .deps/${owner}/${name} (read-only reference; changes there are not pushed).`);
          })(),
      ),
    );
  }

  if (profile.github.subIssues !== "none") {
    tools.push(
      tool(
        "list_sub_issues",
        "List this issue's sub-issues and check each one's work: whether the head of its branch (ao/issue-<n>) is an ancestor of this issue's branch, i.e. merged into it on GitHub. Also shows each one's board column.",
        {},
        () =>
          withContext(async (ctx) => {
            const { owner, repo, threadKind, threadNumber } = ctx.task;
            if (threadKind !== "issue") return fail("Only issues have sub-issues.");
            const subIssues = await listSubIssues(ctx.gh, owner, repo, threadNumber);
            if (!subIssues.length) return ok(`#${threadNumber} has no sub-issues.${profile.github.subIssues === "write" ? " Split the work with create_sub_issue." : ""}`);
            const check = await checkSubIssues(ctx, threadNumber, issueBranch(threadNumber), subIssues);
            const cards = ctx.board ? listBoardItems(ctx.board.board.name) : [];
            const column = (issue: IssueRef) => {
              const card = cards.find((row) => row.kind === "issue" && row.number === issue.number && sameRepo(row, issue.owner, issue.repo));
              return card?.status ? ` · board column: ${card.status}` : "";
            };
            return ok(describeSubIssueWork(check, owner, repo, column));
          })(),
      ),
    );
  }

  if (profile.github.subIssues === "write") {
    tools.push(
      tool(
        "create_sub_issue",
        "Create a new issue in this repository as a sub-issue of the current issue, to split the work. Agents working on a sub-issue branch from this issue's branch and merge into it.",
        {
          title: z.string().min(1).describe("What this piece of work is"),
          body: z.string().describe("What to do and how to tell it's done (Markdown)"),
          labels: z.array(z.string()).optional(),
          ...(options.cardFields ? FIELD_ARGS : {}),
        },
        (args) =>
          withContext(async (ctx) => {
            const { owner, repo, threadKind, threadNumber } = ctx.task;
            if (threadKind !== "issue") return fail("Sub-issues can only be created under an issue.");
            if ((ctx.subIssuesCreated ?? 0) >= MAX_SUB_ISSUES_PER_TASK) return fail(`You've already created ${MAX_SUB_ISSUES_PER_TASK} sub-issues in this task.`);
            const values = fieldValues(args as CardFieldValues);
            if (typeof values === "string") return fail(values);
            const footer = `<sub>Sub-issue of #${threadNumber}, created by **${profile.name}** · orchestrator task #${ctx.task.id}.</sub>`;
            const { data } = await ctx.gh.rest.issues.create({ owner, repo, title: args.title, body: [args.body.trim(), "", footer].join("\n"), ...(args.labels?.length ? { labels: args.labels } : {}) });
            const child = toIssueRef(data);
            ctx.subIssuesCreated = (ctx.subIssuesCreated ?? 0) + 1;
            try {
              await addSubIssue(ctx.gh, owner, repo, threadNumber, child);
            } catch (error) {
              return fail(`Created #${child.number} (${child.url}), but couldn't make it a sub-issue of #${threadNumber}: ${errorMessage(error)}`);
            }
            ctx.thread.relations = { ...ctx.thread.relations, subIssues: [...ctx.thread.relations.subIssues, child] };
            const column = ctx.board?.board.subIssues.column;
            if (ctx.board && column) ctx.board.newSubIssues.push(child);
            const hasValues = Object.keys(values).length > 0;
            const tracked = Boolean(ctx.board && hasCardFields(ctx.board.board.fields));
            if (ctx.board && hasValues && tracked) ctx.board.subIssueFields[child.number] = values;
            ctx.onEvent("tool", `Created sub-issue #${child.number}`);
            return ok(
              [
                `Created #${child.number} "${child.title}" as a sub-issue of #${threadNumber}: ${child.url}`,
                `Its work goes on \`${issueBranch(child.number)}\`, based on and merged into \`${issueBranch(threadNumber)}\`.`,
                ...(ctx.board && column ? [`It's added to the ${ctx.board.board.name} board in "${column}" when you finish.`] : []),
                ...(hasValues
                  ? [tracked && (column || ctx.board!.board.subIssues.movesTo.length) ? `Its ${describeFields(values, ctx.board!.board.fields)} are set when it's added to the board (on its own column or with move_sub_issue).` : "The start, end and estimate weren't set: only cards on a board that tracks them have those."]
                  : []),
              ].join("\n"),
            );
          })(),
      ),
      tool(
        "move_sub_issue",
        "Move one of this issue's sub-issue cards on the project board (board tasks only, to the columns the board allows). The move happens after you finish, and that column's agent gets your handoff note. A sub-issue that isn't on the board yet is added in that column.",
        {
          number: z.number().int().positive().describe("The sub-issue's number"),
          column: z.string().min(1).describe("Target column"),
          handoff: z.string().min(1).describe("Note for whoever works the sub-issue next"),
          fields: z
            .object(Object.fromEntries(HANDOFF_FIELDS.map((field) => [field, z.string().optional()])) as Record<HandoffField, z.ZodOptional<z.ZodString>>)
            .optional()
            .describe("Structured handoff fields the target column requires"),
        },
        (args) =>
          withContext(async (ctx) => {
            if (!ctx.board) return fail("move_sub_issue only works on a project board task.");
            const { board } = ctx.board;
            const { owner, repo, threadKind, threadNumber } = ctx.task;
            if (threadKind !== "issue") return fail("Only issues have sub-issues.");
            if (!board.subIssues.movesTo.length) return fail(`The ${board.name} board doesn't let agents move sub-issues (sub_issues.moves_to isn't set in its board file).`);
            const allowed = [...new Set([...board.subIssues.movesTo, ...(board.needsHuman ? [board.needsHuman] : [])])];
            const target = allowed.find((name) => name.toLowerCase() === args.column.toLowerCase());
            if (!target) return fail(`You can move sub-issues to: ${allowed.map((name) => `"${name}"`).join(", ")}.`);
            const subIssues = await listSubIssues(ctx.gh, owner, repo, threadNumber);
            const issue = subIssues.find((candidate) => candidate.number === args.number && sameRepo(candidate, owner, repo));
            if (!issue) return fail(`#${args.number} isn't a sub-issue of #${threadNumber}. Its sub-issues: ${subIssues.map((candidate) => refText(candidate, owner, repo)).join(", ") || "none"}.`);
            const card = listBoardItems(board.name).find((row) => row.kind === "issue" && row.number === issue.number && sameRepo(row, owner, repo)) ?? null;
            if (card?.status === target) return ok(`#${issue.number} is already in "${target}".`);
            const problems = await cardMoveProblems(ctx, issue, target, args.fields ?? {});
            if (problems.length) {
              ctx.onEvent("tool", `Move of #${issue.number} to ${target} refused: ${problems.length} requirement${problems.length === 1 ? "" : "s"} not met`);
              return fail([`Can't move #${issue.number} to "${target}" yet:`, ...problems.map((problem) => `- ${problem}`), "Fix these and call move_sub_issue again, or leave it where it is."].join("\n"));
            }
            ctx.board.subMoves = ctx.board.subMoves.filter((move) => move.issue.number !== issue.number);
            ctx.board.subMoves.push({ issue, itemId: card?.itemId ?? null, from: card?.status ?? null, to: target, note: renderHandoff(args.handoff, args.fields ?? {}), fields: args.fields ?? {} });
            ctx.onEvent("tool", `Will move sub-issue #${issue.number} to ${target}`);
            return ok(`#${issue.number} will move to "${target}" when you finish${card ? "" : " (it isn't on the board yet, so it's added there)"}.`);
          })(),
      ),
    );
  }

  if (profile.github.relations) {
    const TEXT: Record<(typeof RELATIONS)[number], (me: string, other: string) => string> = {
      blocked_by: (me, other) => `${me} is blocked by ${other}`,
      blocks: (me, other) => `${me} blocks ${other}`,
      parent: (me, other) => `${me} is a sub-issue of ${other}`,
      sub_issue: (me, other) => `${other} is a sub-issue of ${me}`,
    };
    tools.push(
      tool(
        "link_issue",
        "Add (or remove) a GitHub relation between the current issue and another issue in this repository: blocked_by (this issue can't be done before the other), blocks, parent (this issue becomes a sub-issue of the other), sub_issue (the other becomes a sub-issue of this one).",
        {
          relation: z.enum(RELATIONS),
          number: z.number().int().positive().describe("The other issue's number"),
          remove: z.boolean().optional().describe("Remove the relation instead of adding it"),
        },
        (args) =>
          withContext(async (ctx) => {
            const { owner, repo, threadKind, threadNumber } = ctx.task;
            if (threadKind !== "issue") return fail(`Relations are between issues; this task is on a ${threadKind === "pull" ? "pull request" : "discussion"}.`);
            if (args.number === threadNumber) return fail("An issue can't be related to itself.");
            const [me, other] = await Promise.all([getIssue(ctx.gh, owner, repo, threadNumber), getIssue(ctx.gh, owner, repo, args.number)]);
            if (other.isPull) return fail(`#${args.number} is a pull request; relations are between issues.`);
            const remove = args.remove === true;
            if (args.relation === "blocked_by") await (remove ? removeBlockedBy : addBlockedBy)(ctx.gh, owner, repo, threadNumber, other);
            else if (args.relation === "blocks") await (remove ? removeBlockedBy : addBlockedBy)(ctx.gh, owner, repo, other.number, me);
            else if (args.relation === "parent") await (remove ? removeSubIssue : addSubIssue)(ctx.gh, owner, repo, other.number, me);
            else await (remove ? removeSubIssue : addSubIssue)(ctx.gh, owner, repo, threadNumber, other);
            const text = TEXT[args.relation](`#${threadNumber}`, `#${other.number}`);
            ctx.onEvent("tool", `${remove ? "Removed" : "Linked"}: ${text}`);
            return ok(remove ? `Removed the relation: ${text} no longer.` : `Linked: ${text}.`);
          })(),
      ),
    );
  }

  if (profile.github.mergeIntoParent) {
    tools.push(
      tool(
        "merge_into_parent",
        "Merge this sub-issue's work into its parent issue's branch (ao/issue-<parent>) with a merge commit, so its head becomes an ancestor of the parent branch. Merges this task's open pull request if there is one. Never merges into the default branch. Push with commit_and_push first.",
        {
          close_issue: z.boolean().optional().describe("Close the sub-issue as completed after merging (default true)"),
        },
        (args) =>
          withContext(async (ctx) => {
            const { owner, repo, threadKind, threadNumber } = ctx.task;
            const { workspace, thread } = ctx;
            const base = threadKind === "pull" ? (thread.pull && !thread.pull.isFork ? thread.pull.baseRef : null) : parentBranchFor(profile, thread, ctx.task);
            if (!base) {
              return fail(
                threadKind === "pull"
                  ? "This pull request comes from a fork, so it can't be merged into a parent branch."
                  : `#${threadNumber} has no open parent issue in this repository${profile.github.parentBranch ? "" : " (or github.parent_branch is off for this agent)"}, so there's no parent branch to merge into.`,
              );
            }
            if (base === thread.defaultBranch || !isIssueBranch(base)) return fail(`merge_into_parent only merges into a parent issue's branch (ao/issue-<n>), never into \`${base}\`.`);
            const head = await git(workspace.dir, ["rev-parse", "HEAD"]);
            const pushed = await fetchBranch(ctx, workspace.branch);
            if (pushed !== head) return fail(`Push your work first with commit_and_push: \`${workspace.branch}\` is ${pushed ? `at ${pushed.slice(0, 10)}` : "not"} on GitHub${pushed ? `, your checkout at ${head.slice(0, 10)}` : ""}.`);
            if (await ensureBaseBranch(ctx.task, { ...workspace, baseBranch: base }, thread.defaultBranch)) ctx.onEvent("system", `Created \`${base}\` on GitHub`);
            const before = await fetchBranch(ctx, base);
            let how = "it was already merged";
            if (!before || !(await isAncestor(workspace.dir, head, before))) {
              const pr = threadKind === "pull" ? { number: threadNumber, base } : await findOpenPull(ctx.gh, owner, repo, workspace.branch);
              try {
                if (pr && pr.base === base) {
                  await ctx.gh.rest.pulls.merge({ owner, repo, pull_number: pr.number, merge_method: "merge", sha: head, commit_title: `Merge #${pr.number} into ${base}` });
                  how = `merged pull request #${pr.number}`;
                } else if (pr) {
                  return fail(`Pull request #${pr.number} targets \`${pr.base}\`, not the parent branch \`${base}\`. Change its base on GitHub, or ask a person to.`);
                } else {
                  await ctx.gh.rest.repos.merge({ owner, repo, base, head: workspace.branch, commit_message: `Merge ${workspace.branch} into ${base} (#${threadNumber})` });
                  how = "merged the branch";
                }
              } catch (error) {
                if (/conflict/i.test(errorMessage(error)) || Number((error as { status?: number }).status) === 409) {
                  return fail(`GitHub can't merge \`${workspace.branch}\` into \`${base}\`: they conflict. Run \`git fetch origin ${base}\` and \`git merge origin/${base}\`, resolve the conflicts, commit_and_push, then call merge_into_parent again.`);
                }
                throw error;
              }
            }
            const after = await fetchBranch(ctx, base);
            if (!after || !(await isAncestor(workspace.dir, head, after))) return fail(`GitHub accepted the merge, but \`${base}\` doesn't contain ${head.slice(0, 10)} yet. Check with list_sub_issues on the parent later.`);
            let closed = "";
            if (threadKind === "issue" && args.close_issue !== false && thread.state === "open") {
              await ctx.gh.rest.issues.update({ owner, repo, issue_number: threadNumber, state: "closed", state_reason: "completed" });
              thread.state = "closed";
              closed = ` Closed #${threadNumber} as completed.`;
            }
            ctx.onEvent("tool", `Merged \`${workspace.branch}\` into \`${base}\``);
            return ok(`Done (${how}): \`${workspace.branch}\` at ${head.slice(0, 10)} is now an ancestor of \`${base}\` (at ${after.slice(0, 10)}).${closed}`);
          })(),
      ),
    );
  }

  if (profile.github.wiki !== "none") {
    const repository = z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional()
      .describe("owner/name of another repository whose wiki to read; defaults to this task's repository");
    const where = (ctx: ToolContext, value?: string) => {
      const [owner, repo] = (value ?? `${ctx.task.owner}/${ctx.task.repo}`).split("/") as [string, string];
      return { owner, repo };
    };
    tools.push(
      tool("list_wiki_pages", "List the pages of the repository's GitHub wiki (title, file, size, link).", { repository }, (args) =>
        withContext(async (ctx) => {
          const { owner, repo } = where(ctx, args.repository);
          const pages = await listWikiPages(ctx.task.installationId, owner, repo);
          if (!pages.length) return ok(`The ${owner}/${repo} wiki has no pages.`);
          return ok(pages.map((page) => `- ${page.title} (${page.file}, ${page.bytes} bytes) ${page.url}`).join("\n"));
        })(),
      ),
      tool(
        "read_wiki_page",
        "Read a page of the repository's GitHub wiki, by title or file name (e.g. \"Home\", \"Release notes\", \"Release-notes.md\").",
        { page: z.string().min(1).describe("Page title or file name"), repository },
        (args) =>
          withContext(async (ctx) => {
            const { owner, repo } = where(ctx, args.repository);
            const { page, content, truncated } = await readWikiPage(ctx.task.installationId, owner, repo, args.page);
            return ok(`# ${page.title}\n${page.url} (${page.file})\n\n${content}${truncated ? "\n\n…(cut off: the page is longer)" : ""}`);
          })(),
      ),
    );
  }
  if (profile.github.wiki === "write") {
    const wikiTarget = (ctx: ToolContext) => `${ctx.task.owner}/${ctx.task.repo}`;
    tools.push(
      tool(
        "write_wiki_page",
        "Create or replace a page in this repository's GitHub wiki and publish it. Write the whole page (Markdown); it replaces what's there, so read it first when editing.",
        {
          page: z.string().min(1).describe("Page title, e.g. \"Getting started\" (saved as Getting-started.md); an existing page keeps its file"),
          content: z.string().describe("The full page content"),
          message: z.string().optional().describe("Commit message for the wiki's history"),
        },
        (args) =>
          withContext(async (ctx) => {
            const result = await writeWikiPage(
              ctx.task.installationId,
              ctx.task.owner,
              ctx.task.repo,
              args.page,
              args.content,
              args.message?.trim() || `${ctx.profile.name}: ${args.page} (#${ctx.task.threadNumber})`,
            );
            if (!result.changed) return ok(`"${result.page.title}" already had that content; nothing changed. ${result.page.url}`);
            ctx.onEvent("tool", `${result.created ? "Created" : "Updated"} wiki page ${result.page.title}`);
            return ok(`${result.created ? "Created" : "Updated"} "${result.page.title}" in the ${wikiTarget(ctx)} wiki: ${result.page.url}`);
          })(),
      ),
      tool(
        "delete_wiki_page",
        "Delete a page from this repository's GitHub wiki.",
        { page: z.string().min(1).describe("Page title or file name"), message: z.string().optional() },
        (args) =>
          withContext(async (ctx) => {
            const result = await writeWikiPage(
              ctx.task.installationId,
              ctx.task.owner,
              ctx.task.repo,
              args.page,
              null,
              args.message?.trim() || `${ctx.profile.name}: delete ${args.page} (#${ctx.task.threadNumber})`,
            );
            ctx.onEvent("tool", `Deleted wiki page ${result.page.title}`);
            return ok(`Deleted "${result.page.title}" from the ${wikiTarget(ctx)} wiki.`);
          })(),
      ),
    );
  }

  return createSdkMcpServer({ name: "github", version: "1.0.0", tools, alwaysLoad: true });
}
