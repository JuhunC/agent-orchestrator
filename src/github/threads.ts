import type { ThreadKind } from "../types.ts";
import type { GitHubClient } from "./app.ts";
import { ensureLabels } from "./labels.ts";
import { fetchRelations, NO_RELATIONS, type Relations } from "./relations.ts";

export const PROGRESS_MARKER = "<!-- agent-orchestrator:progress -->";
export const RESULT_MARKER = "<!-- agent-orchestrator:result -->";
const MAX_BODY = 65_000;

export interface ThreadComment {
  author: string;
  body: string;
  createdAt: string;
  fromOrchestrator: boolean;
}

export interface ThreadContext {
  kind: ThreadKind;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  state: string;
  nodeId: string;
  /** The issue's database id (sub-issue and dependency endpoints take it); null for discussions. */
  databaseId: number | null;
  defaultBranch: string;
  /** Parent, sub-issues and dependencies (issues only). */
  relations: Relations;
  comments: ThreadComment[];
  reviewComments: { author: string; path: string; line: number | null; body: string }[];
  pull: {
    headRef: string;
    headRepo: string | null;
    baseRef: string;
    isFork: boolean;
  } | null;
}

function clampBody(body: string): string {
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 40)}\n\n…(truncated)` : body;
}

function isOrchestratorComment(body: string): boolean {
  return body.includes(PROGRESS_MARKER);
}

export async function fetchThread(gh: GitHubClient, owner: string, repo: string, kind: ThreadKind, number: number): Promise<ThreadContext> {
  if (kind === "discussion") return fetchDiscussion(gh, owner, repo, number);

  const [{ data: issue }, { data: repository }] = await Promise.all([
    gh.rest.issues.get({ owner, repo, issue_number: number }),
    gh.rest.repos.get({ owner, repo }),
  ]);
  const lastPage = Math.max(1, Math.ceil((issue.comments ?? 0) / 100));
  const { data: comments } = await gh.rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100, page: lastPage });

  let pull: ThreadContext["pull"] = null;
  let reviewComments: ThreadContext["reviewComments"] = [];
  if (kind === "pull") {
    const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: number });
    const headRepo = pr.head.repo?.full_name ?? null;
    pull = {
      headRef: pr.head.ref,
      headRepo,
      baseRef: pr.base.ref,
      isFork: !headRepo || headRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase(),
    };
    const { data: inline } = await gh.rest.pulls.listReviewComments({ owner, repo, pull_number: number, per_page: 100 });
    reviewComments = inline.slice(-30).map((comment) => ({
      author: comment.user?.login ?? "ghost",
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
      body: comment.body,
    }));
  }
  const relations = kind === "issue" ? await fetchRelations(gh, owner, repo, issue) : NO_RELATIONS;

  return {
    kind,
    number,
    title: issue.title,
    body: issue.body ?? "",
    url: issue.html_url,
    author: issue.user?.login ?? "ghost",
    state: issue.state,
    nodeId: issue.node_id,
    databaseId: issue.id,
    defaultBranch: repository.default_branch,
    relations,
    comments: comments.slice(-30).map((comment) => ({
      author: comment.user?.login ?? "ghost",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      fromOrchestrator: isOrchestratorComment(comment.body ?? ""),
    })),
    reviewComments,
    pull,
  };
}

interface DiscussionQuery {
  repository: {
    defaultBranchRef: { name: string } | null;
    discussion: {
      id: string;
      title: string;
      body: string;
      url: string;
      closed: boolean;
      author: { login: string } | null;
      comments: { nodes: { author: { login: string } | null; body: string; createdAt: string }[] };
    } | null;
  };
}

async function fetchDiscussion(gh: GitHubClient, owner: string, repo: string, number: number): Promise<ThreadContext> {
  const data = await gh.graphql<DiscussionQuery>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        defaultBranchRef { name }
        discussion(number: $number) {
          id title body url closed
          author { login }
          comments(last: 30) { nodes { author { login } body createdAt } }
        }
      }
    }`,
    { owner, repo, number },
  );
  const discussion = data.repository.discussion;
  if (!discussion) throw new Error(`Discussion #${number} not found in ${owner}/${repo}`);
  return {
    kind: "discussion",
    number,
    title: discussion.title,
    body: discussion.body,
    url: discussion.url,
    author: discussion.author?.login ?? "ghost",
    state: discussion.closed ? "closed" : "open",
    nodeId: discussion.id,
    databaseId: null,
    defaultBranch: data.repository.defaultBranchRef?.name ?? "main",
    relations: NO_RELATIONS,
    comments: discussion.comments.nodes.map((comment) => ({
      author: comment.author?.login ?? "ghost",
      body: comment.body,
      createdAt: comment.createdAt,
      fromOrchestrator: isOrchestratorComment(comment.body),
    })),
    reviewComments: [],
    pull: null,
  };
}

export interface PostedComment {
  id: string;
  url: string;
}

/** Posts a comment on an issue, PR or discussion. `threadNodeId` is required for discussions. */
export async function postComment(
  gh: GitHubClient,
  target: { owner: string; repo: string; kind: ThreadKind; number: number; threadNodeId?: string },
  body: string,
): Promise<PostedComment> {
  if (target.kind === "discussion") {
    const data = await gh.graphql<{ addDiscussionComment: { comment: { id: string; url: string } } }>(
      `mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { id url } } }`,
      { id: target.threadNodeId, body: clampBody(body) },
    );
    return data.addDiscussionComment.comment;
  }
  const { data } = await gh.rest.issues.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.number,
    body: clampBody(body),
  });
  return { id: String(data.id), url: data.html_url };
}

export async function editComment(
  gh: GitHubClient,
  target: { owner: string; repo: string; kind: ThreadKind },
  commentId: string,
  body: string,
): Promise<void> {
  if (target.kind === "discussion") {
    await gh.graphql(
      `mutation($id: ID!, $body: String!) { updateDiscussionComment(input: { commentId: $id, body: $body }) { comment { id } } }`,
      { id: commentId, body: clampBody(body) },
    );
    return;
  }
  await gh.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: Number(commentId), body: clampBody(body) });
}

/** Adds 👀 to whatever triggered the agent (issue, comment, review, discussion). */
export async function addEyesReaction(gh: GitHubClient, subjectNodeId: string): Promise<void> {
  await gh.graphql(`mutation($id: ID!) { addReaction(input: { subjectId: $id, content: EYES }) { clientMutationId } }`, {
    id: subjectNodeId,
  });
}

const PERMISSION_RANK: Record<string, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

export async function userPermission(gh: GitHubClient, owner: string, repo: string, username: string): Promise<string> {
  try {
    const { data } = await gh.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return (data.role_name || data.permission || "none").toLowerCase();
  } catch {
    return "none";
  }
}

export function permissionAtLeast(actual: string, required: string): boolean {
  return (PERMISSION_RANK[actual] ?? 0) >= (PERMISSION_RANK[required] ?? PERMISSION_RANK.write);
}

/**
 * Marks an issue or PR as handled by an agent: assigns the handle (GitHub ignores it unless the
 * handle is a real collaborator account) and adds an `agent:<name>` label.
 */
export async function markAgentOnThread(
  gh: GitHubClient,
  owner: string,
  repo: string,
  number: number,
  handle: string,
  label: string | null,
): Promise<void> {
  await gh.rest.issues.addAssignees({ owner, repo, issue_number: number, assignees: [handle] }).catch(() => undefined);
  if (label) await ensureLabels(gh, owner, repo, [label]).then((labels) => gh.rest.issues.addLabels({ owner, repo, issue_number: number, labels })).catch(() => undefined);
}

export async function findOpenPull(gh: GitHubClient, owner: string, repo: string, branch: string): Promise<{ number: number; url: string; headSha: string; base: string } | null> {
  const { data } = await gh.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "open", per_page: 1 });
  const pr = data[0];
  return pr ? { number: pr.number, url: pr.html_url, headSha: pr.head.sha, base: pr.base?.ref ?? "" } : null;
}

export async function openPull(
  gh: GitHubClient,
  input: { owner: string; repo: string; head: string; base: string; title: string; body: string; draft?: boolean },
): Promise<{ number: number; url: string }> {
  const { data } = await gh.rest.pulls.create({
    owner: input.owner,
    repo: input.repo,
    head: input.head,
    base: input.base,
    title: input.title,
    body: clampBody(input.body),
    draft: input.draft ?? false,
  });
  return { number: data.number, url: data.html_url };
}

export async function updatePull(gh: GitHubClient, owner: string, repo: string, number: number, title: string, body: string): Promise<void> {
  await gh.rest.pulls.update({ owner, repo, pull_number: number, title, body: clampBody(body) });
}

/** Check runs and commit statuses for a commit, summarised for an agent. */
export async function ciStatus(gh: GitHubClient, owner: string, repo: string, ref: string): Promise<string> {
  const [runs, statuses] = await Promise.all([
    gh.rest.checks.listForRef({ owner, repo, ref, per_page: 50 }).then(({ data }) => data.check_runs).catch(() => []),
    gh.rest.repos.getCombinedStatusForRef({ owner, repo, ref }).then(({ data }) => data.statuses).catch(() => []),
  ]);
  const lines = [
    ...runs.map((run) => `- ${run.name}: ${run.status === "completed" ? run.conclusion : run.status}${run.html_url ? ` (${run.html_url})` : ""}`),
    ...statuses.map((status) => `- ${status.context}: ${status.state}${status.description ? ` — ${status.description}` : ""}`),
  ];
  return lines.length ? lines.join("\n") : "No checks have reported for this commit yet.";
}
