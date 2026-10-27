import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { errorMessage, log } from "../log.ts";
import { getBotIdentity, installationToken, repoRemoteUrl } from "../github/app.ts";
import { issueBranch, sameRepo } from "../github/relations.ts";
import type { ThreadContext } from "../github/threads.ts";
import type { Profile } from "../profiles/types.ts";
import { git, refExists } from "../runner/git.ts";
import type { Task } from "../types.ts";

export interface Workspace {
  dir: string;
  branch: string;
  baseBranch: string;
  /** False for pull requests from forks. */
  canPush: boolean;
  /** The agent may push (its profile allows it and the branch is pushable). */
  willPush: boolean;
  startSha: string;
}

export function workspaceDir(task: Pick<Task, "owner" | "repo" | "agent" | "threadKind" | "threadNumber">): string {
  return join(config.dataDir, "workspaces", task.owner, task.repo, task.agent, `${task.threadKind}-${task.threadNumber}`);
}

/** Keeps a path out of commits without touching the repo's .gitignore. */
export function excludeFromGit(dir: string, pattern: string): void {
  const file = join(dir, ".git", "info", "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").includes(pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}

/** Was this checkout cloned with a filter (objects fetched from GitHub on demand)? */
async function isPartialClone(dir: string): Promise<boolean> {
  return (await git(dir, ["config", "--get", "remote.origin.promisor"]).catch(() => "")) === "true" || Boolean(await git(dir, ["config", "--get", "remote.origin.partialclonefilter"]).catch(() => ""));
}

/**
 * Where a sub-issue's work goes: its parent issue's branch, when the agent uses parent branches
 * (github.parent_branch, on by default) and the parent is an open issue in the same repository.
 */
export function parentBranchFor(profile: Pick<Profile, "github">, thread: ThreadContext, task: Pick<Task, "owner" | "repo">): string | null {
  const parent = thread.relations.parent;
  if (!profile.github.parentBranch || thread.kind !== "issue" || !parent || parent.state !== "open" || !sameRepo(parent, task.owner, task.repo)) return null;
  return issueBranch(parent.number);
}

/**
 * Clones (or refreshes) the agent's checkout for a thread and puts it on the right branch:
 * the PR's head branch for pull requests; the shared `ao/issue-<n>` for board cards and for
 * issues with a parent or sub-issues (a sub-issue starts from its parent's branch and merges
 * into it); `agent/<name>/<kind>-<n>` otherwise.
 */
export async function prepareWorkspace(task: Task, profile: Profile, thread: ThreadContext): Promise<Workspace> {
  const dir = workspaceDir(task);
  const token = await installationToken(task.installationId);
  const remote = repoRemoteUrl(task.owner, task.repo);

  // A full clone: the agent's shell has no GitHub credentials, so git must never need to fetch
  // missing objects on its own (a blob-less partial clone does, for checkout, diff, log -p, merge…).
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    await git(dirname(dir), ["clone", "--no-checkout", remote, dir], { token });
  } else {
    await git(dir, ["remote", "set-url", "origin", remote]);
    if (await isPartialClone(dir)) {
      // Made by an older version with --filter=blob:none: download everything once (git 2.36+).
      const filter = await git(dir, ["config", "--get", "remote.origin.partialclonefilter"]).catch(() => "blob:none");
      await git(dir, ["config", "--unset-all", "remote.origin.promisor"]).catch(() => undefined);
      await git(dir, ["config", "--unset-all", "remote.origin.partialclonefilter"]).catch(() => undefined);
      try {
        await git(dir, ["fetch", "--prune", "--refetch", "origin"], { token });
      } catch (error) {
        // Stay a working partial clone; the orchestrator's own git calls carry the token.
        await git(dir, ["config", "remote.origin.promisor", "true"]);
        await git(dir, ["config", "remote.origin.partialclonefilter", filter]);
        log.warn("Could not turn the workspace into a full clone", { dir, error: errorMessage(error) });
        await git(dir, ["fetch", "--prune", "origin"], { token });
      }
    } else {
      await git(dir, ["fetch", "--prune", "origin"], { token });
    }
  }

  let branch: string;
  let baseBranch: string;
  let startPoint: string;
  let canPush = true;
  if (thread.kind === "pull" && thread.pull) {
    baseBranch = thread.pull.baseRef;
    if (!thread.pull.isFork) {
      branch = thread.pull.headRef;
      startPoint = `origin/${branch}`;
    } else {
      branch = `agent/${profile.name}/pull-${thread.number}`;
      await git(dir, ["fetch", "origin", `+refs/pull/${thread.number}/head:refs/remotes/origin/pr-${thread.number}`], { token });
      startPoint = `origin/pr-${thread.number}`;
      canPush = false;
    }
  } else {
    const parentBranch = parentBranchFor(profile, thread, task);
    const inTree = profile.github.parentBranch && thread.kind === "issue" && (parentBranch !== null || thread.relations.subIssues.length > 0);
    baseBranch = parentBranch ?? thread.defaultBranch;
    // Board stages share one branch per issue, so the tester checks out the developer's work;
    // so does a sub-issue tree, so the parent's agent can see (and check) its sub-issues' work.
    const own = `agent/${profile.name}/${thread.kind}-${thread.number}`;
    branch = task.board || inTree ? issueBranch(thread.number, thread.kind === "discussion" ? "discussion" : "issue") : own;
    const candidates = [branch, ...(inTree && !task.board ? [own] : []), baseBranch, thread.defaultBranch];
    startPoint = `origin/${thread.defaultBranch}`;
    for (const candidate of candidates) {
      if (await refExists(dir, `refs/remotes/origin/${candidate}`)) {
        startPoint = `origin/${candidate}`;
        break;
      }
    }
  }
  if (branch === thread.defaultBranch) canPush = false;
  if (!(await refExists(dir, startPoint))) throw new Error(`Branch ${startPoint.replace("origin/", "")} not found (is the repository empty?)`);

  // After a usage-limit pause, keep the interrupted attempt's work so the agent can carry on.
  const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const keepWork = task.attempts > 0 && current === branch;
  if (!keepWork) {
    await git(dir, ["checkout", "--force", "-B", branch, startPoint], { token });
    await git(dir, ["clean", "-fd", "-e", ".deps/"]);
  }
  excludeFromGit(dir, "/.deps/");
  const identity = await getBotIdentity(task.installationId);
  await git(dir, ["config", "user.name", identity.name]);
  await git(dir, ["config", "user.email", identity.email]);
  const startSha = keepWork && task.startSha ? task.startSha : await git(dir, ["rev-parse", "HEAD"]);

  return { dir, branch, baseBranch, canPush, willPush: canPush && profile.github.push, startSha };
}

/**
 * A sub-issue's pull request goes into its parent's branch. If that branch isn't on GitHub yet,
 * create it where this branch left the default branch, so the pull request shows only this work.
 */
export async function ensureBaseBranch(task: Pick<Task, "installationId">, workspace: Workspace, defaultBranch: string): Promise<boolean> {
  if (workspace.baseBranch === defaultBranch) return false;
  const token = await installationToken(task.installationId);
  if ((await git(workspace.dir, ["ls-remote", "--heads", "origin", workspace.baseBranch], { token })).trim()) return false;
  const fork = await git(workspace.dir, ["merge-base", "HEAD", `refs/remotes/origin/${defaultBranch}`]);
  try {
    await git(workspace.dir, ["push", "origin", `${fork}:refs/heads/${workspace.baseBranch}`], { token });
  } catch (error) {
    // Another sub-issue's agent created it first: that's fine.
    if (!(await git(workspace.dir, ["ls-remote", "--heads", "origin", workspace.baseBranch], { token })).trim()) throw error;
    return false;
  }
  await git(workspace.dir, ["fetch", "origin", `+refs/heads/${workspace.baseBranch}:refs/remotes/origin/${workspace.baseBranch}`], { token });
  return true;
}
