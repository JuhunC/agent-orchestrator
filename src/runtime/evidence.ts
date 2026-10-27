import { copyFileSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Board } from "../boards/loader.ts";
import { CARD_EVIDENCE, EVIDENCE_TEXT, FIELD_HINTS, forbids, isTestCommand, missingFields, workTypeFor, type ColumnRules, type HandoffFields, type WorkType } from "../boards/rules.ts";
import { issueBranch, isIssueBranch, refText, type IssueRef } from "../github/relations.ts";
import { findOpenPull } from "../github/threads.ts";
import type { GitHubClient } from "../github/app.ts";
import { git } from "../runner/git.ts";
import type { ToolContext } from "./github-tools.ts";
import { checkSubIssues, fetchBranch, isAncestor, subIssueProblems } from "./sub-issues.ts";

/** A shell command that looked like a test run, as the orchestrator saw it finish. */
export interface TestRun {
  command: string;
  passed: boolean;
  /** The checkout's content when it finished (a git tree id), to tell whether files changed since. */
  tree: string | null;
}

/** A review the agent submitted with submit_review, and the commit it reviewed. */
export interface ReviewRecord {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  sha: string;
}

/**
 * The git tree of everything in the checkout (tracked and untracked, minus ignored files), built
 * in a throwaway index so the agent's own index is untouched. Equal trees mean equal files.
 */
export async function workTree(dir: string): Promise<string | null> {
  const index = join(tmpdir(), `ao-index-${randomUUID()}`);
  try {
    const real = await git(dir, ["rev-parse", "--git-path", "index"]);
    const path = isAbsolute(real) ? real : join(dir, real);
    // Starting from the real index reuses its file stats, so unchanged files aren't re-read.
    if (existsSync(path)) copyFileSync(path, index);
    else await git(dir, ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: index } });
    await git(dir, ["add", "-A"], { env: { GIT_INDEX_FILE: index } });
    return await git(dir, ["write-tree"], { env: { GIT_INDEX_FILE: index } });
  } catch {
    return null;
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Hooks that record test runs for board tasks whose board asks for `tests` evidence. They run
 * before the agent sees the command's result, so a later move_to_column already knows about it.
 * A command that exits non-zero ends in PostToolUseFailure; one sent to the background proves nothing.
 */
export function testRunHooks(current: () => ToolContext | null): NonNullable<Options["hooks"]> {
  const record = (passed: boolean): HookCallback => async (input) => {
    const ctx = current();
    const board = ctx?.board;
    if (!ctx || !board || !("tool_input" in input)) return {};
    const command = String((input.tool_input as { command?: unknown } | null)?.command ?? "");
    const columns = Object.values(board.board.columns).filter((column) => column.rules.evidence.includes("tests"));
    if (!command || !columns.some((column) => isTestCommand(column.rules, command))) return {};
    const response = ("tool_response" in input ? input.tool_response : null) as { interrupted?: boolean; backgroundTaskId?: string; timedOutAfterMs?: number } | null;
    const finished = !response?.interrupted && !response?.backgroundTaskId && !response?.timedOutAfterMs;
    board.testRuns.push({ command, passed: passed && finished, tree: await workTree(ctx.workspace.dir) });
    if (board.testRuns.length > 50) board.testRuns.shift();
    return {};
  };
  return {
    PostToolUse: [{ matcher: "Bash", hooks: [record(true)] }],
    PostToolUseFailure: [{ matcher: "Bash", hooks: [record(false)] }],
  };
}

/** The card's labels, for work types. */
export async function cardLabels(gh: GitHubClient, owner: string, repo: string, number: number): Promise<string[]> {
  const { data } = await gh.rest.issues.get({ owner, repo, issue_number: number });
  return data.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);
}

/** The card's work type, if the board has any (one GitHub call; none when the board has no work types). */
export async function cardWorkType(ctx: Pick<ToolContext, "gh" | "task">, board: Board): Promise<{ type: WorkType; label: string } | null> {
  if (!board.workTypes.length) return null;
  return workTypeFor(board.workTypes, await cardLabels(ctx.gh, ctx.task.owner, ctx.task.repo, ctx.task.threadNumber));
}

async function evidenceProblems(ctx: ToolContext, rules: ColumnRules): Promise<string[]> {
  const problems: string[] = [];
  const board = ctx.board!;
  const { dir, branch } = ctx.workspace;
  const head = rules.evidence.some((item) => item === "pull_request" || item === "review" || item === "approval") ? await git(dir, ["rev-parse", "HEAD"]) : "";

  for (const item of rules.evidence) {
    const need = `evidence "${item}" (${EVIDENCE_TEXT[item]})`;
    if (item === "pull_request") {
      const { owner, repo, threadKind, threadNumber } = ctx.task;
      const pr =
        threadKind === "pull"
          ? await ctx.gh.rest.pulls.get({ owner, repo, pull_number: threadNumber }).then(({ data }) => (data.state === "open" ? { number: data.number, headSha: data.head.sha } : null))
          : await findOpenPull(ctx.gh, owner, repo, branch);
      if (!pr) problems.push(`${need}: there's no open pull request for ${branch}. Push with commit_and_push, then call open_pull_request.`);
      else if (pr.headSha !== head) problems.push(`${need}: pull request #${pr.number} is at ${pr.headSha.slice(0, 10)}, but your checkout is at ${head.slice(0, 10)}. Push your commits with commit_and_push.`);
    } else if (item === "merged") {
      const base = ctx.workspace.baseBranch;
      const baseSha = await fetchBranch(ctx, base);
      const sha = await git(dir, ["rev-parse", "HEAD"]);
      const how = ctx.profile.github.mergeIntoParent && isIssueBranch(base) ? "Push it with commit_and_push, then call merge_into_parent." : "It counts once your pull request is merged (with a merge commit).";
      if (!baseSha) problems.push(`${need}: \`${base}\` isn't on GitHub yet. ${how}`);
      else if (!(await isAncestor(dir, sha, baseSha))) problems.push(`${need}: your branch (at ${sha.slice(0, 10)}) isn't merged into \`${base}\` yet. ${how}`);
    } else if (item === "sub_issues") {
      const { owner, repo, threadNumber } = ctx.task;
      const check = await checkSubIssues(ctx, threadNumber, issueBranch(threadNumber));
      for (const problem of subIssueProblems(check, owner, repo)) problems.push(`${need}: ${problem}.${ctx.profile.github.subIssues !== "none" ? " See list_sub_issues." : ""}`);
    } else if (item === "pushed") {
      if (!ctx.pushes) problems.push(`${need}: you haven't pushed anything in this task. Make the change, then call commit_and_push.`);
    } else if (item === "tests") {
      const runs = board.testRuns.filter((run) => isTestCommand(rules, run.command));
      const last = runs.at(-1);
      const how = rules.testCommands.length ? `a command containing ${rules.testCommands.map((command) => `\`${command}\``).join(" or ")}` : "the project's test command (e.g. `npm test`, `pytest`, `go test ./...`)";
      if (!last) problems.push(`${need}: no test run seen in this task. Run ${how} with Bash (not in the background), then try again.`);
      else if (!last.passed) problems.push(`${need}: the last test run (\`${last.command}\`) failed or didn't finish. Fix it and run the tests again.`);
      else if (!last.tree || last.tree !== (await workTree(dir))) problems.push(`${need}: files changed after the last passing test run (\`${last.command}\`). Run the tests again.`);
    } else {
      const verdict = board.reviews.filter((review) => review.event !== "COMMENT").at(-1);
      if (!verdict) problems.push(`${need}: you haven't submitted a verdict in this task. Call submit_review with ${item === "approval" ? "APPROVE" : "APPROVE or REQUEST_CHANGES"}.`);
      else if (item === "approval" && verdict.event !== "APPROVE") problems.push(`${need}: your last review requested changes, so this card can't move here. Move it where changes get made instead.`);
      else if (verdict.sha !== head) problems.push(`${need}: you reviewed ${verdict.sha.slice(0, 10)}, but the checkout is now at ${head.slice(0, 10)}. Review it again.`);
    }
  }
  return problems;
}

/**
 * Why a parent's agent may not move one of its sub-issue cards to `target` yet. Only evidence about
 * the card itself can be checked (CARD_EVIDENCE); a column that needs the other card's agent to
 * have run tests or reviewed can't be entered this way.
 */
export async function cardMoveProblems(ctx: ToolContext, card: IssueRef, target: string, fields: HandoffFields | null): Promise<string[]> {
  const board = ctx.board?.board;
  if (!board || target === board.needsHuman) return [];
  const { owner, repo } = ctx.task;
  const ref = refText(card, owner, repo);
  const problems: string[] = [];
  const workType = workTypeFor(board.workTypes, card.labels);
  if (workType && forbids(workType.type, target)) problems.push(`${ref} is a ${workType.type.name} (label "${workType.label}"), and ${workType.type.name} cards can't go to "${target}"`);
  const rules = board.columns[target]?.rules;
  if (rules && fields) {
    for (const field of missingFields(rules.handoffRequired, fields)) problems.push(`handoff field "${field}" is missing: pass fields.${field} (${FIELD_HINTS[field]})`);
  }
  const branch = issueBranch(card.number);
  for (const item of rules?.evidence ?? []) {
    const need = `evidence "${item}" for ${ref}`;
    if (!CARD_EVIDENCE.includes(item)) {
      problems.push(`${need}: only the agent working on ${ref} can show ${EVIDENCE_TEXT[item]}, so you can't move it to "${target}". Move it where its own agent works instead.`);
    } else if (item === "pull_request") {
      const [pr, head] = await Promise.all([findOpenPull(ctx.gh, owner, repo, branch), fetchBranch(ctx, branch)]);
      if (!pr) problems.push(`${need}: there's no open pull request for \`${branch}\``);
      else if (pr.headSha !== head) problems.push(`${need}: pull request #${pr.number} doesn't have the latest commit of \`${branch}\``);
    } else if (item === "merged") {
      const into = issueBranch(ctx.task.threadNumber);
      const [head, intoSha] = [await fetchBranch(ctx, branch), await fetchBranch(ctx, into)];
      if (!head) problems.push(`${need}: ${ref} has no branch (\`${branch}\`) yet`);
      else if (!intoSha || !(await isAncestor(ctx.workspace.dir, head, intoSha))) problems.push(`${need}: \`${branch}\` (at ${head.slice(0, 10)}) isn't merged into \`${into}\` yet`);
    } else {
      const check = await checkSubIssues(ctx, card.number, branch);
      for (const problem of subIssueProblems(check, owner, repo)) problems.push(`${need}: ${problem}`);
    }
  }
  return problems;
}

/**
 * Why an agent may not move this card to `target` yet, as concrete steps it can take in the same
 * session; empty when it may. `fields` is null when only the evidence is re-checked (at the end of
 * the task, before the move happens). Moves to the needs-human column are always allowed.
 */
export async function moveProblems(ctx: ToolContext, target: string, fields: HandoffFields | null): Promise<string[]> {
  const board = ctx.board?.board;
  if (!board || target === board.needsHuman) return [];
  const problems: string[] = [];
  const workType = await cardWorkType(ctx, board);
  if (workType && forbids(workType.type, target)) {
    problems.push(`this card is a ${workType.type.name} (label "${workType.label}"), and ${workType.type.name} cards can't go to "${target}"`);
  }
  const rules = board.columns[target]?.rules;
  if (rules && fields) {
    for (const field of missingFields(rules.handoffRequired, fields)) problems.push(`handoff field "${field}" is missing: pass fields.${field} (${FIELD_HINTS[field]})`);
  }
  if (rules?.evidence.length) problems.push(...(await evidenceProblems(ctx, rules)));
  return problems;
}
