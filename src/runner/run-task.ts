import { buildFollowUpPrompt, buildPrompt } from "../agents/prompt.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { addEvent, lastSessionId, threadHistory, updateTask } from "../db.ts";
import { installationClient, type GitHubClient } from "../github/app.ts";
import { editComment, fetchThread, postComment, type ThreadContext } from "../github/threads.ts";
import { errorMessage, log } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { commitAndPush, openOrUpdatePullRequest, type ToolContext } from "../runtime/github-tools.ts";
import { sessions } from "../runtime/manager.ts";
import { agentEnv, taskEnv } from "../runtime/options.ts";
import { prepareWorkspace, type Workspace } from "../runtime/workspace.ts";
import type { EventKind, Task, ThreadRef } from "../types.ts";
import { git } from "./git.ts";
import { retryTime, type DetectedLimit } from "./limits.ts";
import { setLimit } from "./limit-store.ts";
import { ProgressThrottle, renderProgress, renderResult, type ProgressState } from "./progress.ts";

function patch(taskId: number, changes: Partial<Task>): Task {
  const task = updateTask(taskId, changes);
  bus.publish({ type: "task", task });
  return task;
}

function emit(taskId: number, kind: EventKind, message: string): void {
  bus.publish({ type: "event", event: addEvent(taskId, kind, message) });
}

/** What the agent left unpublished: uncommitted files or commits not on GitHub. */
async function unpublishedWork(workspace: Workspace): Promise<{ dirty: boolean; unpushed: number }> {
  const dirty = Boolean((await git(workspace.dir, ["status", "--porcelain"])).trim());
  const remote = `refs/remotes/origin/${workspace.branch}`;
  const base = (await git(workspace.dir, ["rev-parse", "--verify", "--quiet", remote]).catch(() => "")) || workspace.startSha;
  const unpushed = Number(await git(workspace.dir, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "0"));
  return { dirty, unpushed };
}

/** Runs one task from start to finish. Never throws. */
export async function executeTask(initial: Task, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let task = patch(initial.id, { status: "running", startedAt: new Date(startedAt).toISOString(), error: null, retryAt: null });
  const profiles = loadProfiles();
  const profile = profiles.agents.find((candidate) => candidate.name === task.agent) ?? null;
  const ref: ThreadRef = { owner: task.owner, repo: task.repo, kind: task.threadKind, number: task.threadNumber };
  const state: ProgressState = { phase: "starting", steps: [], latestText: "", startedAt, finishedAt: null, note: "", prNumber: null, prUrl: null };

  let gh: GitHubClient | null = null;
  let thread: ThreadContext | null = null;
  const target = () => ({ owner: task.owner, repo: task.repo, kind: task.threadKind, number: task.threadNumber, threadNodeId: thread?.nodeId });
  const throttle = new ProgressThrottle(async () => {
    if (!gh || !profile || !task.progressCommentId) return;
    await editComment(gh, target(), task.progressCommentId, renderProgress(profile, task, state)).catch((error) =>
      log.warn("Could not update progress comment", { task: task.id, error: errorMessage(error) }),
    );
  });
  const onEvent = (kind: EventKind, message: string) => {
    emit(task.id, kind, message);
    if (kind === "tool" || kind === "error") state.steps.push(message);
    if (kind === "text") state.latestText = message.slice(0, 200);
    if (kind !== "stderr") throttle.markDirty();
  };
  const setPullRequest = (pr: { number: number; url: string }) => {
    state.prNumber = pr.number;
    state.prUrl = task.threadKind === "pull" ? null : pr.url;
    task = patch(task.id, { prNumber: pr.number, prUrl: pr.url });
    throttle.markDirty();
  };

  try {
    if (!profile) throw new Error(`Agent "${task.agent}" no longer exists`);
    if (profile.errors.length) throw new Error(`The ${profile.name} profile has errors: ${profile.errors.join("; ")}`);
    emit(task.id, "status", `Started ${profile.name}`);
    gh = await installationClient(task.installationId);
    thread = await fetchThread(gh, task.owner, task.repo, task.threadKind, task.threadNumber);
    task = patch(task.id, { threadTitle: thread.title, threadUrl: thread.url });

    if (task.progressCommentId) {
      // Resuming after a usage-limit pause: keep updating the same comment.
      await editComment(gh, target(), task.progressCommentId, renderProgress(profile, task, state)).catch(() => undefined);
    } else {
      const comment = await postComment(gh, target(), renderProgress(profile, task, state));
      task = patch(task.id, { progressCommentId: comment.id });
    }
    throttle.start();

    emit(task.id, "status", "Preparing workspace");
    const workspace = await prepareWorkspace(task, profile, thread);
    task = patch(task.id, { branch: workspace.branch, baseBranch: workspace.baseBranch, startSha: workspace.startSha });
    onEvent("system", `Checked out \`${workspace.branch}\``);

    const history = threadHistory(ref, profile.name, task.id);
    if (history.length) onEvent("system", `Loaded ${history.length} earlier run${history.length === 1 ? "" : "s"} as context`);
    const prompts = {
      full: buildPrompt({ agent: profile, task, thread, history, workspace }),
      followUp: buildFollowUpPrompt({ task, thread, workspace, since: history.at(-1)?.finishedAt ?? null, interrupted: task.attempts > 0 }),
    };

    const context: ToolContext = { task, profile, thread, workspace, gh, onEvent, onPullRequest: setPullRequest, comments: 0, pushes: 0 };
    state.phase = "working";
    throttle.markDirty();
    const outcome = await sessions.run({
      task,
      profile,
      library: profiles.library,
      workspace,
      env: agentEnv(profile, taskEnv(task, workspace)),
      resumeSessionId: lastSessionId(ref, profile.name),
      prompts,
      context,
      onEvent,
      signal,
      timeoutMs: (profile.timeoutMinutes ?? config.defaultTimeoutMinutes) * 60_000,
    });
    task = patch(task.id, {
      prompt: outcome.prompt,
      sessionId: outcome.sessionId,
      costUsd: outcome.costUsd,
      resultText: outcome.result,
      live: outcome.live,
      exitCode: outcome.isError ? 1 : 0,
    });

    if (outcome.cancelled) {
      if (signal.reason === "shutdown") await finish("failed", outcome.result, "The orchestrator stopped while this was running. Mention the agent again to retry.");
      else await finish("cancelled", outcome.result, "Cancelled from the admin UI.");
      return;
    }
    if (outcome.limit) {
      await pauseForLimit(outcome.limit, outcome.result);
      return;
    }
    if (outcome.timedOut || outcome.isError) {
      const reason = outcome.timedOut ? `Timed out after ${profile.timeoutMinutes ?? config.defaultTimeoutMinutes} minutes.` : (outcome.error ?? "The agent stopped with an error.");
      await finish("failed", outcome.result, reason);
      return;
    }

    // Safety net: publish work the agent left behind, if its profile allows it.
    if (workspace.willPush) {
      const left = await unpublishedWork(workspace);
      if ((left.dirty || left.unpushed) && profile.github.finalize) {
        state.phase = "publishing";
        await throttle.flush(true);
        onEvent("system", "Publishing changes the agent left unpushed");
        const pushed = await commitAndPush(context, `${profile.name}: ${thread.title}`.slice(0, 72));
        if (pushed.pushed && task.threadKind !== "pull" && profile.github.pullRequest && !state.prNumber) {
          await openOrUpdatePullRequest(context, thread.title, outcome.result || "_No summary from the agent._");
        }
      } else if (left.dirty || left.unpushed) {
        onEvent("system", "The agent left changes it didn't push");
      }
    }
    let details = "";
    const commits = Number(await git(workspace.dir, ["rev-list", "--count", `${workspace.startSha}..HEAD`]).catch(() => "0"));
    if (commits) {
      const files = (await git(workspace.dir, ["diff", "--name-only", `${workspace.startSha}..HEAD`])).split("\n").filter(Boolean);
      const list = files.slice(0, 30).map((file) => `- \`${file}\``).join("\n");
      details = `<details><summary>Changed files (${files.length})</summary>\n\n${list}${files.length > 30 ? "\n- …" : ""}\n</details>`;
    }
    task = patch(task.id, { commits });
    await finish("succeeded", outcome.result, "", details, commits);
  } catch (error) {
    const message = errorMessage(error);
    log.error("Task failed", { task: task.id, error: message });
    onEvent("error", message);
    await finish("failed", task.resultText ?? "", message);
  }

  /** The model service hit its usage limit: wait for the reset and carry on, instead of failing. */
  async function pauseForLimit(limit: DetectedLimit, text: string) {
    const until = retryTime(limit);
    setLimit(until, limit.message);
    if (task.attempts + 1 > config.usageLimitRetries) {
      await finish("failed", text, `Hit the usage limit ${task.attempts + 1} times (${limit.message}). Mention the agent again once it has reset.`);
      return;
    }
    const at = until.toISOString().slice(11, 16);
    onEvent("system", `Usage limit reached (${limit.message}). Paused until ${at} UTC`);
    state.phase = "waiting";
    state.note = `Hit the model service's usage limit: _${limit.message.replace(/[_*`]/g, "")}_. It continues automatically at **${at} UTC**${until.toDateString() !== new Date().toDateString() ? ` on ${until.toISOString().slice(0, 10)}` : ""}.`;
    task = patch(task.id, { status: "queued", retryAt: until.toISOString(), attempts: task.attempts + 1, error: null });
    await throttle.flush(true);
    await throttle.stop();
  }

  async function finish(status: "succeeded" | "failed" | "cancelled", text: string, reason: string, details = "", commits = 0) {
    state.phase = status;
    state.finishedAt = Date.now();
    state.note = status === "succeeded" ? "" : reason;
    task = patch(task.id, { status, finishedAt: new Date(state.finishedAt).toISOString(), error: status === "succeeded" ? null : reason, resultText: text || task.resultText });
    emit(task.id, "status", status === "succeeded" ? "Finished" : status === "cancelled" ? "Cancelled" : `Failed: ${reason}`);
    await throttle.flush(true);
    await throttle.stop();
    if (!gh || !profile) return;
    if (status === "cancelled" && !task.progressCommentId) return;
    const body = renderResult(profile, task, {
      ok: status === "succeeded",
      text: status === "succeeded" ? text : [reason, text ? `\n**Last reply from the agent:**\n\n${text}` : ""].join("\n"),
      durationMs: state.finishedAt - startedAt,
      prUrl: state.prUrl,
      prNumber: state.prNumber && task.threadKind !== "pull" ? state.prNumber : null,
      commits,
      details,
    });
    await postComment(gh, target(), body).catch((error) => log.warn("Could not post result comment", { task: task.id, error: errorMessage(error) }));
  }
}

/** Marks a task interrupted by a restart as failed, and says so on GitHub. */
export async function markInterrupted(task: Task): Promise<void> {
  const updated = patch(task.id, { status: "failed", finishedAt: new Date().toISOString(), error: "Interrupted because the orchestrator restarted" });
  emit(task.id, "error", "Interrupted because the orchestrator restarted");
  if (!task.progressCommentId) return;
  try {
    const gh = await installationClient(task.installationId);
    const state: ProgressState = {
      phase: "failed",
      steps: [],
      latestText: "",
      startedAt: task.startedAt ? Date.parse(task.startedAt) : Date.now(),
      finishedAt: Date.now(),
      note: "The orchestrator restarted while this was running. Mention the agent again to retry.",
      prNumber: null,
      prUrl: null,
    };
    await editComment(gh, { owner: task.owner, repo: task.repo, kind: task.threadKind }, task.progressCommentId, renderProgress({ name: task.agent }, updated, state));
  } catch (error) {
    log.warn("Could not update interrupted task's comment", { task: task.id, error: errorMessage(error) });
  }
}
