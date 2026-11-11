import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { addEvent, getTask, updateTask, waitingTasks } from "../db.ts";
import { clientFor } from "../github/accounts.ts";
import type { GitHubClient } from "../github/app.ts";
import { getIssue, listDependencies, listSubIssues, type IssueRef } from "../github/relations.ts";
import { errorMessage, log } from "../log.ts";
import type { Task, WaitFor } from "../types.ts";
import { scheduler } from "./scheduler.ts";

/**
 * Tasks whose agent paused them until other work is done (the wait_for tool). Such a task is back
 * in the queue with waitReason "wake" and its deadline as retryAt, so it holds no slot while it
 * waits. It resumes its own session when what it waits for has happened (a webhook or the regular
 * check here sees it), when someone writes to its agent on the thread, when a person wakes it
 * from the admin UI, or at the deadline. Once woken it's an ordinary queued task (waitReason
 * null) that still carries its waitFor, so the agent is told why it's back.
 */

/** What the task waits for, to follow "until …" or "waiting for …". */
export function describeWait(wait: WaitFor): string {
  const list = (numbers: number[]) => numbers.map((number) => `#${number}`).join(", ");
  switch (wait.until) {
    case "sub_issues_done":
      return "this issue's sub-issues are closed";
    case "blockers_closed":
      return "the issues blocking this one are closed";
    case "issues_closed":
      return `${list(wait.issues)} ${wait.issues.length === 1 ? "is" : "are"} closed`;
    case "pull_merged":
      return `pull request #${wait.pull} is merged`;
    case "pull_reviewed":
      return `pull request #${wait.pull} is reviewed`;
    case "time":
      return `${wait.deadline.slice(0, 16).replace("T", " ")} UTC`;
  }
}

export interface WaitCheck {
  /** Has what the task waits for happened? */
  met: boolean;
  /** What happened, or what is still missing: a clause without a full stop. */
  text: string;
}

function closed(issues: IssueRef[], what: string, none: string): WaitCheck {
  const refs = (list: IssueRef[]) => list.map((issue) => `#${issue.number}`).join(", ");
  const open = issues.filter((issue) => issue.state === "open");
  if (!issues.length) return { met: true, text: none };
  if (!open.length) return { met: true, text: issues.length === 1 ? `${what} #${issues[0]!.number} is closed` : `all ${issues.length} ${what}s are closed (${refs(issues)})` };
  return { met: false, text: `${open.length} of ${issues.length} ${what}${issues.length === 1 ? "" : "s"} ${open.length === 1 ? "is" : "are"} still open (${refs(open)})` };
}

const REVIEW_WORDS: Record<string, string> = { APPROVED: "approved it", CHANGES_REQUESTED: "asked for changes", COMMENTED: "commented", DISMISSED: "had their review dismissed" };

/** Looks on GitHub whether what a task waits for has happened. */
export async function checkWait(gh: GitHubClient, task: Pick<Task, "owner" | "repo" | "threadNumber">, wait: WaitFor, now = Date.now()): Promise<WaitCheck> {
  const { owner, repo } = task;
  switch (wait.until) {
    case "time":
      return now >= Date.parse(wait.deadline) ? { met: true, text: "the time you asked for has passed" } : { met: false, text: "the time you asked for hasn't passed yet" };
    case "sub_issues_done":
      return closed(await listSubIssues(gh, owner, repo, task.threadNumber), "sub-issue", "this issue has no sub-issues any more");
    case "blockers_closed":
      return closed(await listDependencies(gh, owner, repo, task.threadNumber, "blocked_by"), "blocking issue", "nothing blocks this issue any more");
    case "issues_closed":
      return closed(await Promise.all(wait.issues.map((number) => getIssue(gh, owner, repo, number))), "issue", "there is nothing to wait for");
    case "pull_merged":
    case "pull_reviewed": {
      const number = wait.pull!;
      if (wait.until === "pull_reviewed") {
        const { data: reviews } = await gh.rest.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100 });
        const fresh = reviews.filter((review) => review.state !== "PENDING" && (review.submitted_at ?? "") > wait.since);
        const last = fresh.at(-1);
        if (last) return { met: true, text: `@${last.user?.login ?? "someone"} reviewed pull request #${number} and ${REVIEW_WORDS[last.state] ?? last.state.toLowerCase()}` };
      }
      const { data: pull } = await gh.rest.pulls.get({ owner, repo, pull_number: number });
      if (pull.merged) return { met: true, text: `pull request #${number} was merged into \`${pull.base.ref}\`` };
      if (pull.state === "closed") return { met: true, text: `pull request #${number} was closed without being merged` };
      return { met: false, text: wait.until === "pull_reviewed" ? `nobody has reviewed pull request #${number} since you paused` : `pull request #${number} is still open` };
    }
  }
}

/** Wakes a paused task: it resumes as soon as a slot is free, told `why`. False when it isn't waiting (any more). */
export function wakeTask(taskId: number, why: string): boolean {
  const task = getTask(taskId);
  if (task?.status !== "queued" || task.waitReason !== "wake" || !task.waitFor) return false;
  const updated = updateTask(task.id, { retryAt: null, waitReason: null, waitFor: { ...task.waitFor, woke: why } });
  bus.publish({ type: "event", event: addEvent(task.id, "system", `Woken: ${why}`) });
  bus.publish({ type: "task", task: updated });
  scheduler.kick();
  return true;
}

/** Checks being made now, so a webhook and the timer don't look at the same task twice at once. */
const checking = new Set<number>();

/**
 * Looks at what paused tasks wait for (all of them, or one repository's) and wakes those whose
 * wait is over. A check that fails (GitHub unreachable) is tried again next time; the deadline
 * wakes the task in any case.
 */
export async function checkWaits(where: { owner?: string; repo?: string } = {}): Promise<number> {
  let woken = 0;
  for (const task of waitingTasks(where)) {
    const wait = task.waitFor;
    if (!wait || wait.woke || wait.until === "time" || checking.has(task.id)) continue;
    checking.add(task.id);
    try {
      const result = await checkWait(await clientFor(task), task, wait);
      if (result.met && wakeTask(task.id, result.text)) woken++;
    } catch (error) {
      log.warn("Could not check what a paused task waits for", { task: task.id, error: errorMessage(error) });
    } finally {
      checking.delete(task.id);
    }
  }
  return woken;
}

/** Webhooks that can end a wait: issues and pull requests closing, reviews, sub-issue changes. */
const WAKING_EVENTS = new Set(["issues", "pull_request", "pull_request_review", "sub_issues", "issue_dependencies"]);

/** A webhook arrived: if it could end a wait in that repository, look now instead of at the next regular check. */
export function noteWaitEvent(event: string, payload: { repository?: { full_name?: string } }): void {
  if (!WAKING_EVENTS.has(event)) return;
  const [owner, repo] = String(payload.repository?.full_name ?? "").split("/");
  if (!owner || !repo || !waitingTasks({ owner, repo }).length) return;
  void checkWaits({ owner, repo }).catch((error) => log.warn("Checking paused tasks failed", { error: errorMessage(error) }));
}

let timer: NodeJS.Timeout | null = null;

/** Looks at every paused task's condition every WAIT_CHECK_SECONDS, for changes no webhook told us about. */
export function startWaitChecks(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!waitingTasks().length) return;
    void checkWaits().catch((error) => log.warn("Checking paused tasks failed", { error: errorMessage(error) }));
  }, config.waitCheckSeconds * 1000);
  timer.unref();
}

export function stopWaitChecks(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
