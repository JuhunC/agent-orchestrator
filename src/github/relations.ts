import { errorMessage, log } from "../log.ts";
import type { GitHubClient } from "./app.ts";

/**
 * GitHub's issue relations: sub-issues (parent/child) and dependencies (blocked by / blocking).
 * The REST endpoints take the issue's database id, not its number, for the other issue.
 */
export interface IssueRef {
  /** Database id, which the sub-issue and dependency endpoints take. */
  id: number;
  nodeId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  /** completed, not_planned, duplicate or reopened (closed issues). */
  stateReason: string | null;
  url: string;
  labels: string[];
  /** Blocked-by counts from GitHub's issue JSON (open blockers, all blockers); null when it doesn't say. */
  blockedBy: { open: number; total: number } | null;
}

export interface Relations {
  parent: IssueRef | null;
  subIssues: IssueRef[];
  blockedBy: IssueRef[];
  blocking: IssueRef[];
}

export const NO_RELATIONS: Relations = { parent: null, subIssues: [], blockedBy: [], blocking: [] };

export const RELATIONS = ["blocked_by", "blocks", "parent", "sub_issue"] as const;
export type Relation = (typeof RELATIONS)[number];

function status(error: unknown): number {
  return Number((error as { status?: unknown })?.status ?? 0);
}

/** The repository an issue belongs to, from its API URL (…/repos/<owner>/<repo>). */
function repoOf(issue: Record<string, any>): { owner: string; repo: string } {
  const match = String(issue.repository_url ?? "").match(/\/repos\/([^/]+)\/([^/]+)\/?$/) ?? String(issue.html_url ?? "").match(/\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/);
  return { owner: match?.[1] ?? "", repo: match?.[2] ?? "" };
}

export function toIssueRef(issue: Record<string, any>): IssueRef {
  return {
    id: Number(issue.id),
    nodeId: String(issue.node_id ?? ""),
    ...repoOf(issue),
    number: Number(issue.number),
    title: String(issue.title ?? ""),
    state: issue.state === "closed" ? "closed" : "open",
    stateReason: issue.state_reason ? String(issue.state_reason) : null,
    url: String(issue.html_url ?? ""),
    labels: ((issue.labels ?? []) as unknown[]).map((label) => (typeof label === "string" ? label : String((label as { name?: unknown })?.name ?? ""))).filter(Boolean),
    blockedBy: issue.issue_dependencies_summary
      ? { open: Number(issue.issue_dependencies_summary.blocked_by ?? 0), total: Number(issue.issue_dependencies_summary.total_blocked_by ?? 0) }
      : null,
  };
}

export function sameRepo(ref: Pick<IssueRef, "owner" | "repo">, owner: string, repo: string): boolean {
  return ref.owner.toLowerCase() === owner.toLowerCase() && ref.repo.toLowerCase() === repo.toLowerCase();
}

/** "#12" in the same repository, "owner/repo#12" in another. */
export function refText(ref: IssueRef, owner: string, repo: string): string {
  return sameRepo(ref, owner, repo) ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`;
}

export async function getIssue(gh: GitHubClient, owner: string, repo: string, number: number): Promise<IssueRef & { isPull: boolean }> {
  const { data } = await gh.rest.issues.get({ owner, repo, issue_number: number });
  return { ...toIssueRef(data), isPull: Boolean(data.pull_request) };
}

export async function getParent(gh: GitHubClient, owner: string, repo: string, number: number): Promise<IssueRef | null> {
  try {
    const { data } = await gh.rest.issues.getParent({ owner, repo, issue_number: number });
    return toIssueRef(data);
  } catch (error) {
    if (status(error) === 404) return null;
    throw error;
  }
}

export async function listSubIssues(gh: GitHubClient, owner: string, repo: string, number: number): Promise<IssueRef[]> {
  const { data } = await gh.rest.issues.listSubIssues({ owner, repo, issue_number: number, per_page: 100 });
  return data.map((issue) => toIssueRef(issue));
}

export async function listDependencies(gh: GitHubClient, owner: string, repo: string, number: number, which: "blocked_by" | "blocking"): Promise<IssueRef[]> {
  const call = which === "blocked_by" ? gh.rest.issues.listDependenciesBlockedBy : gh.rest.issues.listDependenciesBlocking;
  const { data } = await call({ owner, repo, issue_number: number, per_page: 100 });
  return data.map((issue) => toIssueRef(issue));
}

/**
 * An issue's relations. GitHub's issue JSON carries counts (sub_issues_summary,
 * issue_dependencies_summary); a list is only fetched when its count isn't zero or isn't known.
 * A failing lookup leaves that part empty rather than failing the task.
 */
export async function fetchRelations(gh: GitHubClient, owner: string, repo: string, issue: Record<string, any>): Promise<Relations> {
  const number = Number(issue.number);
  const soft = async <T,>(what: string, run: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (status(error) !== 404) log.warn(`Could not read the issue's ${what}`, { repo: `${owner}/${repo}`, number, error: errorMessage(error) });
      return empty;
    }
  };
  const subTotal = issue.sub_issues_summary?.total;
  const dependencies = issue.issue_dependencies_summary;
  const [parent, subIssues, blockedBy, blocking] = await Promise.all([
    soft("parent", () => getParent(gh, owner, repo, number), null),
    subTotal === 0 ? [] : soft("sub-issues", () => listSubIssues(gh, owner, repo, number), []),
    dependencies?.total_blocked_by === 0 ? [] : soft("blocked-by issues", () => listDependencies(gh, owner, repo, number, "blocked_by"), []),
    dependencies?.total_blocking === 0 ? [] : soft("blocking issues", () => listDependencies(gh, owner, repo, number, "blocking"), []),
  ]);
  return { parent, subIssues, blockedBy, blocking };
}

/** Makes `child` a sub-issue of issue #parent. */
export async function addSubIssue(gh: GitHubClient, owner: string, repo: string, parent: number, child: IssueRef, replaceParent = false): Promise<void> {
  await gh.rest.issues.addSubIssue({ owner, repo, issue_number: parent, sub_issue_id: child.id, replace_parent: replaceParent });
}

export async function removeSubIssue(gh: GitHubClient, owner: string, repo: string, parent: number, child: IssueRef): Promise<void> {
  await gh.rest.issues.removeSubIssue({ owner, repo, issue_number: parent, sub_issue_id: child.id });
}

/** Marks issue #number as blocked by `blocker`. */
export async function addBlockedBy(gh: GitHubClient, owner: string, repo: string, number: number, blocker: IssueRef): Promise<void> {
  await gh.rest.issues.addBlockedByDependency({ owner, repo, issue_number: number, issue_id: blocker.id });
}

export async function removeBlockedBy(gh: GitHubClient, owner: string, repo: string, number: number, blocker: IssueRef): Promise<void> {
  await gh.rest.issues.removeDependencyBlockedBy({ owner, repo, issue_number: number, issue_id: blocker.id });
}

/** The shared branch for an issue that's part of a sub-issue tree or a board: ao/issue-<n>. */
export function issueBranch(number: number, kind: "issue" | "discussion" = "issue"): string {
  return `ao/${kind}-${number}`;
}

/** Is `branch` an issue's shared branch (one a sub-issue may merge into)? */
export function isIssueBranch(branch: string): boolean {
  return /^ao\/issue-\d+$/.test(branch);
}

/** The relations as lines for an agent (empty when there are none). */
export function describeRelations(relations: Relations, owner: string, repo: string): string[] {
  const item = (ref: IssueRef) => `${refText(ref, owner, repo)} "${ref.title}" (${ref.state})`;
  return [
    ...(relations.parent ? [`- Parent: ${item(relations.parent)}`] : []),
    ...(relations.subIssues.length ? [`- Sub-issues (${relations.subIssues.length}): ${relations.subIssues.map(item).join(", ")}`] : []),
    ...(relations.blockedBy.length ? [`- Blocked by: ${relations.blockedBy.map(item).join(", ")}`] : []),
    ...(relations.blocking.length ? [`- Blocking: ${relations.blocking.map(item).join(", ")}`] : []),
  ];
}

/** The issues #number is blocked by; skips the call when GitHub's counts say there are none. */
export async function listBlockedBy(gh: GitHubClient, owner: string, repo: string, issue: number | IssueRef): Promise<IssueRef[]> {
  if (typeof issue !== "number" && issue.blockedBy?.total === 0) return [];
  return listDependencies(gh, owner, repo, typeof issue === "number" ? issue : issue.number, "blocked_by");
}
