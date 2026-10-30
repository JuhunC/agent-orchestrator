import { gitTokenFor } from "../github/accounts.ts";
import { issueBranch, listSubIssues, refText, sameRepo, type IssueRef } from "../github/relations.ts";
import { git } from "../runner/git.ts";
import type { ToolContext } from "./github-tools.ts";

type Ctx = Pick<ToolContext, "task" | "workspace" | "gh">;

/** Brings a branch from GitHub into refs/remotes/origin/<branch>. Its commit, or null if it isn't on GitHub. */
export async function fetchBranch(ctx: Ctx, branch: string): Promise<string | null> {
  const { dir } = ctx.workspace;
  const token = await gitTokenFor(ctx.task);
  const sha = (await git(dir, ["ls-remote", "--heads", "origin", branch], { token })).split(/\s+/)[0] || null;
  if (!sha) {
    await git(dir, ["update-ref", "-d", `refs/remotes/origin/${branch}`]).catch(() => undefined);
    return null;
  }
  await git(dir, ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { token });
  return sha;
}

/** Is `commit` an ancestor of (or equal to) `of`? */
export async function isAncestor(dir: string, commit: string, of: string): Promise<boolean> {
  try {
    await git(dir, ["merge-base", "--is-ancestor", commit, of]);
    return true;
  } catch {
    return false;
  }
}

/** One sub-issue's work, checked against its parent's branch. */
export interface SubIssueWork {
  issue: IssueRef;
  /** Its branch (ao/issue-<n>); null for a sub-issue in another repository, which isn't checked. */
  branch: string | null;
  /** Where its branch is on GitHub; null when it has no branch yet. */
  head: string | null;
  /** Its head is an ancestor of the parent's branch on GitHub. */
  merged: boolean;
  /** Not merged on GitHub, but its head is in the parent agent's checkout (merged, not pushed). */
  mergedLocally: boolean;
}

/** Closed sub-issues that were dropped rather than done don't need merged work. */
export function dropped(issue: IssueRef): boolean {
  return issue.state === "closed" && (issue.stateReason === "not_planned" || issue.stateReason === "duplicate");
}

/**
 * Checks the sub-issues of issue #number: for each, is the head of its branch an ancestor of
 * `into` on GitHub (normally the parent's branch, ao/issue-<number>)?
 */
export async function checkSubIssues(ctx: Ctx, number: number, into: string, known?: IssueRef[]): Promise<{ into: string; intoSha: string | null; items: SubIssueWork[] }> {
  const { owner, repo } = ctx.task;
  const { dir } = ctx.workspace;
  const subIssues = known ?? (await listSubIssues(ctx.gh, owner, repo, number));
  const intoSha = await fetchBranch(ctx, into);
  const items: SubIssueWork[] = [];
  for (const issue of subIssues) {
    if (!sameRepo(issue, owner, repo)) {
      items.push({ issue, branch: null, head: null, merged: false, mergedLocally: false });
      continue;
    }
    const branch = issueBranch(issue.number);
    const head = await fetchBranch(ctx, branch);
    const merged = Boolean(head && intoSha && (await isAncestor(dir, head, intoSha)));
    const mergedLocally = Boolean(head && !merged && into === ctx.workspace.branch && (await isAncestor(dir, head, "HEAD")));
    items.push({ issue, branch, head, merged, mergedLocally });
  }
  return { into, intoSha, items };
}

/** One line per sub-issue, for the agent. */
export function describeSubIssueWork(check: Awaited<ReturnType<typeof checkSubIssues>>, owner: string, repo: string, extra: (issue: IssueRef) => string = () => ""): string {
  const { into, intoSha, items } = check;
  const lines = items.map((item) => {
    const ref = `${refText(item.issue, owner, repo)} "${item.issue.title}" (${item.issue.state}${item.issue.stateReason && item.issue.state === "closed" ? `, ${item.issue.stateReason.replace("_", " ")}` : ""})`;
    let work: string;
    if (!item.branch) work = "in another repository, not checked";
    else if (!item.head) work = `no branch yet (\`${item.branch}\`)`;
    else if (item.merged) work = `\`${item.branch}\` at ${item.head.slice(0, 10)}: merged into \`${into}\``;
    else if (item.mergedLocally) work = `\`${item.branch}\` at ${item.head.slice(0, 10)}: merged in your checkout, but not pushed yet`;
    else work = `\`${item.branch}\` at ${item.head.slice(0, 10)}: NOT merged into \`${into}\` (its head isn't an ancestor)`;
    return `- ${ref}: ${work}${extra(item.issue)}`;
  });
  const head = intoSha ? `Checked against \`${into}\` on GitHub (at ${intoSha.slice(0, 10)}).` : `\`${into}\` isn't on GitHub yet, so nothing is merged into it.`;
  return [head, ...lines, "A squash or rebase merge copies the commits, so that work shows as not merged; merge with a merge commit to keep it checkable."].join("\n");
}

/**
 * What stops `sub_issues` evidence: every sub-issue's branch must be merged into `into`, and a
 * sub-issue without a branch must be closed. Sub-issues closed as not planned or duplicate are skipped.
 */
export function subIssueProblems(check: Awaited<ReturnType<typeof checkSubIssues>>, owner: string, repo: string): string[] {
  const problems: string[] = [];
  for (const item of check.items) {
    if (dropped(item.issue)) continue;
    const ref = refText(item.issue, owner, repo);
    if (!item.branch) {
      if (item.issue.state === "open") problems.push(`${ref} is in another repository and still open; it counts once it's closed`);
    } else if (item.head && !item.merged) {
      problems.push(
        item.mergedLocally
          ? `${ref} is merged in your checkout but not on GitHub: push with commit_and_push`
          : `${ref}'s branch \`${item.branch}\` (at ${item.head.slice(0, 10)}) isn't merged into \`${check.into}\` yet`,
      );
    } else if (!item.head && item.issue.state === "open") {
      problems.push(`${ref} has no work yet (no branch \`${item.branch}\`) and is still open`);
    }
  }
  return problems;
}
