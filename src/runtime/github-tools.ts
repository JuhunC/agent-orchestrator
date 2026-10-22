import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { linkThreads } from "../db.ts";
import { installationToken, repoRemoteUrl, type GitHubClient } from "../github/app.ts";
import { ciStatus, fetchThread, findOpenPull, openPull, postComment, updatePull, type ThreadContext } from "../github/threads.ts";
import { errorMessage } from "../log.ts";
import type { Profile } from "../profiles/types.ts";
import { listWikiPages, readWikiPage, writeWikiPage } from "../github/wiki.ts";
import { git, GitError } from "../runner/git.ts";
import { mention } from "../runner/progress.ts";
import type { EventKind, Task } from "../types.ts";
import { allowedMoves, canMove, type Board } from "../boards/loader.ts";
import { excludeFromGit, type Workspace } from "./workspace.ts";

/** Set when the task came from a project board column. */
export interface BoardContext {
  board: Board;
  column: string;
  itemId: string;
  /** Where the agent asked to move the card; done when the task finishes successfully. */
  pendingMove: { to: string; note: string } | null;
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
  board: BoardContext | null;
}

const MAX_COMMENTS_PER_TASK = 10;

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

/** Opens the task's pull request, or updates it if one is already open for the branch. */
export async function openOrUpdatePullRequest(ctx: ToolContext, title: string, body: string, draft = false): Promise<{ number: number; url: string; created: boolean }> {
  const { task, thread, workspace, gh, profile } = ctx;
  const link = thread.kind === "issue" ? `Closes #${thread.number}` : `From discussion #${thread.number}: ${thread.url}`;
  const footer = `<sub>Opened by **${profile.name}** for ${mention(task.requestedBy)} · orchestrator task #${task.id}. Mention @${profile.handle} here to ask for changes.</sub>`;
  const fullBody = [body.trim(), "", link, "", footer].join("\n");
  const existing = await findOpenPull(gh, task.owner, task.repo, workspace.branch);
  let pr: { number: number; url: string; created: boolean };
  if (existing) {
    await updatePull(gh, task.owner, task.repo, existing.number, title, fullBody);
    pr = { ...existing, created: false };
  } else {
    const created = await openPull(gh, { owner: task.owner, repo: task.repo, head: workspace.branch, base: workspace.baseBranch, title, body: fullBody, draft });
    pr = { ...created, created: true };
  }
  linkThreads(task.owner, task.repo, { kind: thread.kind, number: thread.number }, { kind: "pull", number: pr.number });
  ctx.onPullRequest(pr);
  return pr;
}

/**
 * The orchestrator's GitHub tools, served in-process to the agent as the `github` MCP server.
 * The installation token stays in this process; the agent only sees the results.
 */
export function createGithubServer(profile: Profile, current: () => ToolContext | null): McpSdkServerConfigWithInstance {
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
        return ok(`# ${thread.title}\n${thread.url} (${thread.state})\n\n${thread.body}\n\n## Comments\n\n${comments || "(none)"}`);
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
            const pr = await openOrUpdatePullRequest(ctx, args.title, args.body, args.draft);
            ctx.onEvent("tool", `${pr.created ? "Opened" : "Updated"} pull request #${pr.number}`);
            return ok(`${pr.created ? "Opened" : "Updated"} pull request #${pr.number}: ${pr.url}`);
          })(),
      ),
    );
  }

  tools.push(
    tool(
      "move_to_column",
      "Move this card on the project board when your part is done (board tasks only). The move happens after you finish, and the next column's agent receives your handoff note.",
      {
        column: z.string().min(1).describe("Target column, from the allowed list in your instructions"),
        handoff: z.string().min(1).describe("Note for whoever works the card next: what you did, what's left, what to check"),
      },
      (args) =>
        withContext(async (ctx) => {
          if (!ctx.board) return fail("This task isn't from a project board, so there's no card to move.");
          const { board, column } = ctx.board;
          const target = Object.keys(board.columns).find((name) => name.toLowerCase() === args.column.toLowerCase()) ?? (board.needsHuman?.toLowerCase() === args.column.toLowerCase() ? board.needsHuman : null);
          if (!target || !canMove(board, column, target)) return fail(`You can't move the card from "${column}" to "${args.column}". Allowed: ${allowedMoves(board, column).join(", ")}.`);
          ctx.board.pendingMove = { to: target, note: args.handoff };
          ctx.onEvent("tool", `Will move the card to ${target}`);
          return ok(`The card will move to "${target}" when you finish. Wrap up now.`);
        })(),
    ),
  );

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
