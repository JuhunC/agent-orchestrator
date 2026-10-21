import { buildFollowUpPrompt, buildPrompt, type BoardStage } from "../agents/prompt.ts";
import { moveCard } from "../boards/engine.ts";
import { allowedMoves, getBoard } from "../boards/loader.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { addEvent, addHandoff, getBoardItem, lastSessionId, listHandoffs, threadHistory, updateTask } from "../db.ts";
import { installationClient, type GitHubClient } from "../github/app.ts";
import { editComment, fetchThread, postComment, type ThreadContext } from "../github/threads.ts";
import { errorMessage, log } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { commitAndPush, openOrUpdatePullRequest, type BoardContext, type ToolContext } from "../runtime/github-tools.ts";
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

const RETRY_PROMPT =
  "The model service failed while you were working, so your last turn was cut off. Continue the task from where you left off: your earlier work in this session and the working copy are intact. Finish as instructed before.";

/** Waits, unless the task is cancelled first. Resolves false when cancelled. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  let boardContext: BoardContext | null = null;
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
    if (task.board) {
      const board = getBoard(task.board);
      const column = board && task.boardColumn ? board.columns[task.boardColumn] : undefined;
      if (!board || !column || !task.boardItemId) throw new Error(`The ${task.board} board no longer has a "${task.boardColumn}" column`);
      if (board.errors.length) throw new Error(`The ${board.name} board has errors: ${board.errors.join("; ")}`);
      boardContext = { board, column: column.name, itemId: task.boardItemId, pendingMove: null };
    }
    emit(task.id, "status", `Started ${profile.name}${boardContext ? ` (${boardContext.board.name}: ${boardContext.column})` : ""}`);
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

    const column = boardContext ? boardContext.board.columns[boardContext.column]! : null;
    if (boardContext && column?.onStart && getBoardItem(boardContext.board.name, boardContext.itemId)?.status === column.name) {
      await moveCard(boardContext.board, boardContext.itemId, column.onStart, { agentMove: false, trigger: false, excludeTaskId: task.id });
      onEvent("system", `Moved the card to ${column.onStart}`);
    }

    emit(task.id, "status", "Preparing workspace");
    const workspace = await prepareWorkspace(task, profile, thread);
    task = patch(task.id, { branch: workspace.branch, baseBranch: workspace.baseBranch, startSha: workspace.startSha });
    onEvent("system", `Checked out \`${workspace.branch}\``);

    const history = threadHistory(ref, profile.name, task.id);
    if (history.length) onEvent("system", `Loaded ${history.length} earlier run${history.length === 1 ? "" : "s"} as context`);
    const stage: BoardStage | null =
      boardContext && column
        ? {
            board: boardContext.board.name,
            column: column.name,
            role: column.role,
            moves: allowedMoves(boardContext.board, column.name),
            needsHuman: boardContext.board.needsHuman,
            handoffs: listHandoffs(boardContext.board.name, boardContext.itemId),
          }
        : null;
    const prompts = {
      full: buildPrompt({ agent: profile, task, thread, history, workspace, board: stage }),
      followUp: buildFollowUpPrompt({ task, thread, workspace, since: history.at(-1)?.finishedAt ?? null, interrupted: task.attempts > 0, board: stage }),
    };

    const context: ToolContext = { task, profile, thread, workspace, gh, onEvent, onPullRequest: setPullRequest, comments: 0, pushes: 0, board: boardContext };
    state.phase = "working";
    throttle.markDirty();
    const runOptions = {
      task,
      profile,
      library: profiles.library,
      workspace,
      env: agentEnv(profile, taskEnv(task, workspace)),
      resumeSessionId: lastSessionId(ref, profile.name),
      prompts,
      context,
      model: column?.model ?? null,
      effort: column?.effort ?? null,
      onEvent,
      signal,
      timeoutMs: (profile.timeoutMinutes ?? config.defaultTimeoutMinutes) * 60_000,
    };
    let outcome = await sessions.run(runOptions);
    let costUsd = outcome.costUsd ?? 0;
    // The model service failed to answer even after Claude Code's own retries: wait and continue
    // the same session (the working copy is untouched), up to MODEL_ERROR_RETRIES times.
    let retries = 0;
    while (outcome.serverError && !outcome.cancelled && retries < config.modelErrorRetries) {
      retries++;
      const delay = config.modelErrorRetryDelaySeconds * 2 ** (retries - 1);
      onEvent("system", `The model service failed (${outcome.serverError}). Retrying in ${delay}s (${retries}/${config.modelErrorRetries})`);
      if (!(await wait(delay * 1000, signal))) {
        outcome = { ...outcome, cancelled: true };
        break;
      }
      outcome = await sessions.run({
        ...runOptions,
        resumeSessionId: outcome.sessionId ?? runOptions.resumeSessionId,
        prompts: { full: prompts.full, followUp: RETRY_PROMPT },
      });
      costUsd += outcome.costUsd ?? 0;
    }
    task = patch(task.id, {
      prompt: outcome.prompt,
      sessionId: outcome.sessionId,
      costUsd: costUsd || outcome.costUsd,
      resultText: outcome.result,
      live: outcome.live,
      exitCode: outcome.isError ? 1 : 0,
    });

    if (outcome.cancelled) {
      if (signal.reason === "shutdown") await finish("failed", outcome.result, "The orchestrator stopped while this was running. Mention the agent again to retry.");
      else await finish("cancelled", outcome.result, typeof signal.reason === "string" && signal.reason !== "admin" ? signal.reason : "Cancelled from the admin UI.");
      return;
    }
    if (outcome.limit) {
      await pauseForLimit(outcome.limit, outcome.result);
      return;
    }
    if (outcome.timedOut || outcome.isError) {
      const reason = outcome.timedOut
        ? `Timed out after ${profile.timeoutMinutes ?? config.defaultTimeoutMinutes} minutes.`
        : outcome.serverError
          ? `The model service kept failing (${outcome.serverError})${retries ? ` after ${retries} ${retries === 1 ? "retry" : "retries"}` : ""}.`
          : (outcome.error ?? "The agent stopped with an error.");
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
    const move = boardContext?.pendingMove;
    if (boardContext && move) {
      details = [`**Moved the card to ${move.to}.** Handoff:\n\n${move.note.split("\n").map((line) => `> ${line}`).join("\n")}`, details].filter(Boolean).join("\n\n");
    } else if (boardContext) {
      details = [`The card stays in **${boardContext.column}** (the agent didn't move it).`, details].filter(Boolean).join("\n\n");
    }
    await finish("succeeded", outcome.result, "", details, commits);
    if (boardContext && move) {
      // After the reply is posted: hand the card to the next column (and its agent).
      addHandoff(boardContext.board.name, boardContext.itemId, { taskId: task.id, agent: profile.name, fromColumn: boardContext.column, toColumn: move.to, note: move.note });
      const landed = await moveCard(boardContext.board, boardContext.itemId, move.to, { agentMove: true, excludeTaskId: task.id }).catch((error) => {
        log.warn("Could not move the card", { task: task.id, error: errorMessage(error) });
        return null;
      });
      if (landed) emit(task.id, "system", `Moved the card to ${landed}`);
    }
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
