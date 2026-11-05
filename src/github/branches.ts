/**
 * Base branches as people write them in a board file or agent.md (`base_branch:`): one branch
 * for every repository, or a map of owner/name → branch with `default` for the rest.
 */
export interface BaseBranchSetting {
  /** For repositories the map doesn't name; null: their default branch on GitHub. */
  all: string | null;
  /** owner/name in lower case → branch. */
  repos: Record<string, string>;
}

/** Why `name` can't be a base branch, or null when it can. Follows git's ref-name rules. */
export function branchNameProblem(name: string): string | null {
  if (!name) return "give a branch name";
  if (name.startsWith("refs/")) return `give just the branch name, without "refs/heads/"`;
  if (
    name.length > 200 ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.includes("//") ||
    name === "@" ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.split("/").some((part) => part.startsWith("."))
  ) {
    return `"${name}" isn't a valid branch name`;
  }
  // The orchestrator's own branches: work branches from them per issue, so they can't be everyone's base.
  if (/^(ao|agent)\//.test(name)) return `"${name}" is one of the orchestrator's own work branches (ao/…, agent/…)`;
  return null;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** Reads a `base_branch` value; problems are added to `errors` (prefixed with `where`). */
export function parseBaseBranch(value: unknown, where: string, errors: string[]): BaseBranchSetting | null {
  if (value === undefined || value === null || value === "") return null;
  const check = (raw: unknown, at: string): string | null => {
    const name = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
    const problem = typeof raw === "string" || typeof raw === "number" ? branchNameProblem(name) : "give a branch name";
    if (problem) {
      errors.push(`${at}: ${problem}`);
      return null;
    }
    return name;
  };
  if (typeof value === "string" || typeof value === "number") {
    const name = check(value, where);
    return name ? { all: name, repos: {} } : null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${where} must be a branch name, or a map of owner/name → branch (with default: for other repositories)`);
    return null;
  }
  const setting: BaseBranchSetting = { all: null, repos: {} };
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "default") {
      setting.all = check(raw, `${where}.default`);
    } else if (!REPO.test(key)) {
      errors.push(`${where}: "${key}" isn't a repository (owner/name) or "default"`);
    } else {
      const name = check(raw, `${where}.${key}`);
      if (name) setting.repos[key.toLowerCase()] = name;
    }
  }
  return setting.all || Object.keys(setting.repos).length ? setting : null;
}

/** The branch a setting gives for one repository, or null when it leaves the repository alone. */
export function pickBase(setting: BaseBranchSetting | null | undefined, owner: string, repo: string): string | null {
  if (!setting) return null;
  return setting.repos[`${owner}/${repo}`.toLowerCase()] ?? setting.all;
}

/** A setting in words, for the admin UI ("develop", or "acme/api → develop, otherwise main"). */
export function describeBaseSetting(setting: BaseBranchSetting | null | undefined): string | null {
  if (!setting) return null;
  const repos = Object.entries(setting.repos).map(([repo, branch]) => `${repo} → ${branch}`);
  if (!repos.length) return setting.all;
  return `${repos.join(", ")}${setting.all ? `, otherwise ${setting.all}` : ""}`;
}
