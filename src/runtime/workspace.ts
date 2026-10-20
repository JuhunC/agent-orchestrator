import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { getBotIdentity, installationToken, repoRemoteUrl } from "../github/app.ts";
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

/**
 * Clones (or refreshes) the agent's checkout for a thread and puts it on the right branch:
 * the PR's head branch for pull requests, `agent/<name>/<kind>-<n>` otherwise.
 */
export async function prepareWorkspace(task: Task, profile: Profile, thread: ThreadContext): Promise<Workspace> {
  const dir = workspaceDir(task);
  const token = await installationToken(task.installationId);
  const remote = repoRemoteUrl(task.owner, task.repo);

  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    await git(dirname(dir), ["clone", "--filter=blob:none", "--no-checkout", remote, dir], { token });
  } else {
    await git(dir, ["remote", "set-url", "origin", remote]);
    await git(dir, ["fetch", "--prune", "origin"], { token });
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
    baseBranch = thread.defaultBranch;
    branch = `agent/${profile.name}/${thread.kind}-${thread.number}`;
    startPoint = (await refExists(dir, `refs/remotes/origin/${branch}`)) ? `origin/${branch}` : `origin/${baseBranch}`;
  }
  if (branch === thread.defaultBranch) canPush = false;
  if (!(await refExists(dir, startPoint))) throw new Error(`Branch ${startPoint.replace("origin/", "")} not found (is the repository empty?)`);

  // After a usage-limit pause, keep the interrupted attempt's work so the agent can carry on.
  const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const keepWork = task.attempts > 0 && current === branch;
  if (!keepWork) {
    await git(dir, ["checkout", "--force", "-B", branch, startPoint]);
    await git(dir, ["clean", "-fd", "-e", ".deps/"]);
  }
  excludeFromGit(dir, "/.deps/");
  const identity = await getBotIdentity(task.installationId);
  await git(dir, ["config", "user.name", identity.name]);
  await git(dir, ["config", "user.email", identity.email]);
  const startSha = keepWork && task.startSha ? task.startSha : await git(dir, ["rev-parse", "HEAD"]);

  return { dir, branch, baseBranch, canPush, willPush: canPush && profile.github.push, startSha };
}
