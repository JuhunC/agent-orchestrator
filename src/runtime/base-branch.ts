import type { Board } from "../boards/loader.ts";
import { getSchedule, getSetting, setSetting } from "../db.ts";
import type { GitHubClient } from "../github/app.ts";
import { pickBase } from "../github/branches.ts";
import type { Profile } from "../profiles/types.ts";
import type { Task } from "../types.ts";

/**
 * Which branch agents' pull requests go into. Most specific first: the run itself (a schedule, or
 * the Run agent dialog), the board, the agent's agent.md, the repository's setting in the admin UI,
 * and otherwise the repository's default branch. Pull requests keep their own base, and a
 * sub-issue still goes into its parent issue's branch (which starts from this one).
 */
export interface BaseChoice {
  /** null: the repository's default branch on GitHub. */
  branch: string | null;
  /** Where it was set, in words ("on the product board"); null for the default branch. */
  from: string | null;
}

const SETTING = "base_branches";

/** Base branches set per repository in the admin UI (Settings → Base branches): owner/name (lower case) → branch. */
export function repoBaseBranches(): Record<string, string> {
  try {
    const parsed = JSON.parse(getSetting(SETTING) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function setRepoBaseBranch(repo: string, branch: string | null): void {
  const all = repoBaseBranches();
  if (branch) all[repo.toLowerCase()] = branch;
  else delete all[repo.toLowerCase()];
  setSetting(SETTING, JSON.stringify(all));
}

export function chooseBase(input: {
  owner: string;
  repo: string;
  requested?: BaseChoice | null;
  board?: Pick<Board, "name" | "baseBranch"> | null;
  profile?: Pick<Profile, "name" | "github"> | null;
}): BaseChoice {
  const { owner, repo, board, profile } = input;
  if (input.requested?.branch) return input.requested;
  const fromBoard = board ? pickBase(board.baseBranch, owner, repo) : null;
  if (fromBoard) return { branch: fromBoard, from: `on the ${board!.name} board` };
  const fromAgent = profile ? pickBase(profile.github.baseBranch, owner, repo) : null;
  if (fromAgent) return { branch: fromAgent, from: `in ${profile!.name}'s agent.md` };
  const fromRepo = repoBaseBranches()[`${owner}/${repo}`.toLowerCase()];
  if (fromRepo) return { branch: fromRepo, from: `for ${owner}/${repo} in Settings` };
  return { branch: null, from: null };
}

/** The base branch for a task (its board, when it has one, is already loaded). */
export function baseForTask(task: Task, profile: Profile | null, board: Board | null): BaseChoice {
  const requested = task.requestedBase
    ? {
        branch: task.requestedBase,
        from: task.scheduleId ? `on schedule "${getSchedule(task.scheduleId)?.name ?? `#${task.scheduleId}`}"` : task.retryOf ? `by task #${task.retryOf}, which this repeats` : "when this run was started",
      }
    : null;
  return chooseBase({ owner: task.owner, repo: task.repo, requested, board, profile });
}

/** Throws a plain message when the repository has no such branch. */
export async function checkBranchExists(gh: GitHubClient, owner: string, repo: string, branch: string): Promise<void> {
  try {
    await gh.rest.repos.getBranch({ owner, repo, branch });
  } catch (error) {
    if (Number((error as { status?: number }).status) === 404) throw new Error(`${owner}/${repo} has no branch \`${branch}\`. Create it on GitHub first, or pick another.`);
    throw error;
  }
}
