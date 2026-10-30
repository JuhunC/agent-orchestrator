import { buildFollowUpPrompt, buildPrompt, type BoardStage } from "../agents/prompt.ts";
import { addIssueToBoard, moveCard, startColumnAgent } from "../boards/engine.ts";
import { allowedMoves, getBoard } from "../boards/loader.ts";
import { describeRules, hasCardFields, hasRules } from "../boards/rules.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { addEvent, addHandoff, addVote, getBoardItem, lastSessionId, listHandoffs, tasksInRound, threadHistory, updateTask } from "../db.ts";
import { agentAccount, clientFor } from "../github/accounts.ts";
import type { GitHubClient } from "../github/app.ts";
import { refText } from "../github/relations.ts";
import { editComment, fetchThread, postComment, type ThreadContext } from "../github/threads.ts";
import { errorMessage, log } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { commitAndPush, openOrUpdatePullRequest, PullRequestLimitError, type BoardContext, type SubIssueMove, type ToolContext } from "../runtime/github-tools.ts";
import { sessions } from "../runtime/manager.ts";
import { cardMoveProblems, cardWorkType, moveProblems } from "../runtime/evidence.ts";
import { agentEnv, fallbackModels, taskEnv } from "../runtime/options.ts";
import { isolationStatus } from "../runtime/isolation.ts";
import { RELATION_NAME, runRelatedStart } from "../runtime/related-agents.ts";
import { addUsage } from "../runtime/usage.ts";
import { prepareWorkspace, type Workspace } from "../runtime/workspace.ts";
import type { EventKind, Task, ThreadRef } from "../types.ts";
import { git } from "./git.ts";
import { settleInbox } from "./inbox.ts";
import { retryTime, type DetectedLimit } from "./limits.ts";
import { getLimit, setLimit } from "./limit-store.ts";
import { progressEditAllowed, ProgressThrottle, renderProgress, renderResult, type ProgressState } from "./progress.ts";
import { recordIncident } from "./incidents.ts";

function patch(taskId: number, changes: Partial<Task>): Task {
  const task = updateTask(taskId, changes);
  bus.publish({ type: "task", task });
  return task;
}

function emit(taskId: number, kind: EventKind, message: string): void {
  bus.publish({ type: "event", event: addEvent(taskId, kind, message) });
}

const FALLBACK_PROMPT =
  "The model you were running on hit its usage limit, so you now run on a fallback model. Continue the task from where you left off: your earlier work in this session and the working copy are intact. Finish as instructed before.";

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
  // The body last posted, so an edit that changes nothing isn't sent.
  let lastProgress = "";
  const throttle: ProgressThrottle = new ProgressThrottle(async (force) => {
    if (!gh || !profile || !task.progressCommentId) return;
    const body = renderProgress(profile, task, state);
    if (body === lastProgress) return;
    // Optional updates wait for the edit budget (and for GitHub to stop throttling); forced ones go now.
    if (!force && !progressEditAllowed()) return throttle.markDirty();
    lastProgress = body;
    await editComment(gh, target(), task.progressCommentId, body).catch((error) => log.warn("Could not update progress comment", { task: task.id, error: errorMessage(error) }));
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
    const isolation = isolationStatus();
    if (isolation.required && isolation.mode === "off") throw new Error(`AGENT_ISOLATION is required, but agents can't run as a separate user: ${isolation.problem}`);
    if (task.board) {
      const board = getBoard(task.board);
      const column = board && task.boardColumn ? board.columns[task.boardColumn] : undefined;
      if (!board || !column || !task.boardItemId) throw new Error(`The ${task.board} board no longer has a "${task.boardColumn}" column`);
      if (board.errors.length) throw new Error(`The ${board.name} board has errors: ${board.errors.join("; ")}`);
      boardContext = { board, column: column.name, itemId: task.boardItemId, pendingMove: null, testRuns: [], reviews: [], subMoves: [], newSubIssues: [], subIssueFields: {} };
    }
    emit(task.id, "status", `Started ${profile.name}${boardContext ? ` (${boardContext.board.name}: ${boardContext.column})` : ""}`);
    gh = await clientFor(task);
    thread = await fetchThread(gh, task.owner, task.repo, task.threadKind, task.threadNumber);
    task = patch(task.id, { threadTitle: thread.title, threadUrl: thread.url });

    if (task.dryRun) {
      onEvent("system", `Dry run${task.retryOf ? ` of task #${task.retryOf}` : ""} with ${profile.name}'s current profile: nothing is changed on GitHub`);
    } else if (task.progressCommentId) {
      // Resuming after a usage-limit pause: keep updating the same comment.
      await editComment(gh, target(), task.progressCommentId, renderProgress(profile, task, state)).catch(() => undefined);
    } else {
      lastProgress = renderProgress(profile, task, state);
      const comment = await postComment(gh, target(), lastProgress);
      task = patch(task.id, { progressCommentId: comment.id });
    }
    if (config.progressComments === "edit") throttle.start(); // "minimal": no edits until the end

    const column = boardContext ? boardContext.board.columns[boardContext.column]! : null;
    if (!task.dryRun && boardContext && column?.onStart && getBoardItem(boardContext.board.name, boardContext.itemId)?.status === column.name) {
      await moveCard(boardContext.board, boardContext.itemId, column.onStart, { agentMove: false, trigger: false, excludeTaskId: task.id });
      onEvent("system", `Moved the card to ${column.onStart}`);
    }

    emit(task.id, "status", "Preparing workspace");
    const workspace = await prepareWorkspace(task, profile, thread);
    task = patch(task.id, { branch: workspace.branch, baseBranch: workspace.baseBranch, startSha: workspace.startSha });
    onEvent("system", `Checked out \`${workspace.branch}\``);

    const history = threadHistory(ref, profile.name, task.id);
    if (history.length) onEvent("system", `Loaded ${history.length} earlier run${history.length === 1 ? "" : "s"} as context`);
    const workType = boardContext ? await cardWorkType({ gh, task }, boardContext.board).catch(() => null) : null;
    const moves = boardContext && column ? allowedMoves(boardContext.board, column.name, workType?.type) : [];
    const stage: BoardStage | null =
      boardContext && column
        ? {
            board: boardContext.board.name,
            column: column.name,
            role: column.role,
            moves,
            requirements: moves.flatMap((name) => {
              const rules = boardContext!.board.columns[name]?.rules;
              return rules && hasRules(rules) ? [{ column: name, text: describeRules(rules) }] : [];
            }),
            workType: workType ? { name: workType.type.name, label: workType.label, forbid: workType.type.forbid } : null,
            subIssues: profile.github.subIssues === "write" && (boardContext.board.subIssues.column || boardContext.board.subIssues.movesTo.length) ? boardContext.board.subIssues : null,
            mergeIntoParent: profile.github.mergeIntoParent,
            fields:
              profile.github.updateIssue && hasCardFields(boardContext.board.fields)
                ? { ...boardContext.board.fields, values: getBoardItem(boardContext.board.name, boardContext.itemId)?.fields ?? {} }
                : null,
            needsHuman: boardContext.board.needsHuman,
            handoffs: listHandoffs(boardContext.board.name, boardContext.itemId),
            peers: task.boardRound ? tasksInRound(task.boardRound).map((peer) => peer.agent).filter((name) => name !== profile.name) : [],
          }
        : null;
    const prompts = {
      full: buildPrompt({ agent: profile, task, thread, history, workspace, board: stage }),
      followUp: buildFollowUpPrompt({ agent: profile, task, thread, workspace, since: history.at(-1)?.finishedAt ?? null, interrupted: task.attempts > 0, board: stage }),
    };

    const context: ToolContext = { task, profile, thread, workspace, gh, onEvent, onPullRequest: setPullRequest, comments: 0, pushes: 0, board: boardContext };
    // While the model service's usage limit holds, an agent with a fallback model starts on it.
    const fallbacks = fallbackModels(profile);
    let usingFallback = Boolean(getLimit() && fallbacks.length);
    const startModel = usingFallback ? fallbacks[0]! : (column?.model ?? null);
    if (usingFallback) onEvent("system", `The usage limit is in force, so this runs on the fallback model ${startModel}`);
    state.phase = "working";
    throttle.markDirty();
    const runOptions = {
      task,
      profile,
      library: profiles.library,
      workspace,
      env: agentEnv(profile, taskEnv(task, workspace)),
      // A dry run starts afresh (the thread's history is in its prompt), so it can't change the real session.
      resumeSessionId: task.dryRun ? null : lastSessionId(ref, profile.name),
      prompts,
      context,
      model: startModel,
      effort: column?.effort ?? null,
      onEvent,
      signal,
      timeoutMs: (profile.timeoutMinutes ?? config.defaultTimeoutMinutes) * 60_000,
    };
    let outcome = await sessions.run(runOptions);
    let costUsd = outcome.costUsd ?? 0;
    let usage = outcome.usage;
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
      usage = addUsage(usage, outcome.usage);
    }
    // A usage limit on the model: carry on with the fallback model at once instead of pausing.
    if (outcome.limit && !outcome.cancelled && !usingFallback && fallbacks.length) {
      setLimit(retryTime(outcome.limit), outcome.limit.message);
      usingFallback = true;
      onEvent("system", `Usage limit reached (${outcome.limit.message}). Continuing with the fallback model ${fallbacks[0]}`);
      outcome = await sessions.run({
        ...runOptions,
        model: fallbacks[0]!,
        resumeSessionId: outcome.sessionId ?? runOptions.resumeSessionId,
        prompts: { full: prompts.full, followUp: FALLBACK_PROMPT },
      });
      costUsd += outcome.costUsd ?? 0;
      usage = addUsage(usage, outcome.usage);
    }
    task = patch(task.id, {
      prompt: outcome.prompt,
      sessionId: outcome.sessionId,
      // Add to earlier attempts (a usage-limit pause resumes the same task).
      costUsd: (task.costUsd ?? 0) + costUsd,
      usage: addUsage(task.usage, usage),
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
    if (workspace.willPush && !task.dryRun) {
      const left = await unpublishedWork(workspace);
      if ((left.dirty || left.unpushed) && profile.github.finalize) {
        state.phase = "publishing";
        await throttle.flush(true);
        onEvent("system", "Publishing changes the agent left unpushed");
        const pushed = await commitAndPush(context, `${profile.name}: ${thread.title}`.slice(0, 72));
        if (pushed.pushed && task.threadKind !== "pull" && profile.github.pullRequest && !state.prNumber) {
          await openOrUpdatePullRequest(context, thread.title, outcome.result || "_No summary from the agent._").catch((error) => {
            if (!(error instanceof PullRequestLimitError)) throw error;
            onEvent("system", error.message);
          });
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
    let move = boardContext?.pendingMove ?? null;
    let refused = "";
    if (boardContext && move) {
      // The evidence was checked when the agent asked; check it again in case it changed since.
      const problems = await moveProblems(context, move.to, null).catch((error) => [`the requirements couldn't be checked: ${errorMessage(error)}`]);
      if (problems.length) {
        refused = `The move to **${move.to}** was refused because, by the end of the task:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
        onEvent("system", `Refused the move to ${move.to}: ${problems.join("; ")}`);
        move = null;
      }
    }
    // Sub-issue cards the agent moved, checked again the same way, and the sub-issues it created.
    const subMoves: SubIssueMove[] = [];
    const subLines: string[] = [];
    const newColumn = boardContext?.board.subIssues.column ?? null;
    const newCards: SubIssueMove["issue"][] = [];
    for (const issue of boardContext && newColumn ? boardContext.newSubIssues.filter((candidate) => !boardContext!.subMoves.some((subMove) => subMove.issue.number === candidate.number)) : []) {
      // New sub-issues meet their column's requirements like any agent move (e.g. dependencies).
      const problems = await cardMoveProblems(context, issue, newColumn!, null).catch((error) => [`the requirements couldn't be checked: ${errorMessage(error)}`]);
      if (problems.length) subLines.push(`Sub-issue #${issue.number} wasn't added to the board in **${newColumn}** because:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
      else newCards.push(issue);
    }
    for (const subMove of boardContext?.subMoves ?? []) {
      const problems = await cardMoveProblems(context, subMove.issue, subMove.to, null).catch((error) => [`the requirements couldn't be checked: ${errorMessage(error)}`]);
      if (problems.length) {
        subLines.push(`The move of sub-issue #${subMove.issue.number} to **${subMove.to}** was refused because, by the end of the task:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
        onEvent("system", `Refused the move of #${subMove.issue.number} to ${subMove.to}: ${problems.join("; ")}`);
      } else {
        subMoves.push(subMove);
        subLines.push(`**Moved sub-issue #${subMove.issue.number} to ${subMove.to}.**`);
      }
    }
    if (newCards.length) subLines.push(`**Added sub-issue${newCards.length === 1 ? "" : "s"} ${newCards.map((issue) => `#${issue.number}`).join(", ")} to the board in ${newColumn}.**`);
    const quoted = (note: string) => note.split("\n").map((line) => `> ${line}`).join("\n");
    const own =
      boardContext && move && task.boardRound
        ? `**Voted to move the card to ${move.to}** (it moves when every agent in this column has finished). Handoff:\n\n${quoted(move.note)}`
        : boardContext && move
          ? `**Moved the card to ${move.to}.** Handoff:\n\n${quoted(move.note)}`
          : boardContext
            ? refused
              ? `The card stays in **${boardContext.column}**. ${refused}`
              : `The card stays in **${boardContext.column}** (the agent didn't move it).`
            : "";
    const issueState = context.issueState ?? null;
    if (issueState) subLines.push(issueState.state === "closed" ? `**Closed the issue** as ${issueState.reason.replace("_", " ")}.` : "**Reopened the issue.**");
    const relatedStarts = context.relatedStarts ?? [];
    for (const start of relatedStarts) subLines.push(`**Asked the agent of ${refText(start.target, task.owner, task.repo)} to pick it up** (${RELATION_NAME[start.relation]}).`);
    details = [own, ...subLines, details].filter(Boolean).join("\n\n");
    if (task.dryRun) {
      // Nothing from a dry run reaches GitHub or the board.
      await finish("succeeded", outcome.result, "", "", commits);
      return;
    }
    if (boardContext && move && task.boardRound) addVote(task.boardRound, { taskId: task.id, agent: profile.name, to: move.to, note: move.note });
    await finish("succeeded", outcome.result, "", details, commits);
    if (boardContext && move && !task.boardRound) {
      // After the reply is posted: hand the card to the next column (and its agent).
      addHandoff(boardContext.board.name, boardContext.itemId, { taskId: task.id, agent: profile.name, fromColumn: boardContext.column, toColumn: move.to, note: move.note });
      const landed = await moveCard(boardContext.board, boardContext.itemId, move.to, { agentMove: true, excludeTaskId: task.id, startedBy: task.id, actor: task }).catch((error) => {
        log.warn("Could not move the card", { task: task.id, error: errorMessage(error) });
        return null;
      });
      if (landed) emit(task.id, "system", `Moved the card to ${landed}`);
    }
    if (boardContext) await settleSubIssues(boardContext, subMoves, newCards, newColumn);
    if (issueState) {
      // Last, so a project workflow that moves closed cards can't stop this task's own moves.
      await gh.rest.issues
        .update({ owner: task.owner, repo: task.repo, issue_number: task.threadNumber, state: issueState.state, state_reason: issueState.reason })
        .then(() => emit(task.id, "system", issueState.state === "closed" ? `Closed the issue as ${issueState.reason.replace("_", " ")}` : "Reopened the issue"))
        .catch((error) => emit(task.id, "error", `Couldn't ${issueState.state === "closed" ? "close" : "reopen"} the issue: ${errorMessage(error)}`));
    }
    // After everything else, so the related issue's agent sees this task's finished work.
    for (const start of relatedStarts) {
      const line = await runRelatedStart(start, { task, profile, title: thread.title, url: thread.url }).catch((error) => `Couldn't start an agent on ${refText(start.target, task.owner, task.repo)}: ${errorMessage(error)}`);
      emit(task.id, "system", line);
      log.info("Related-issue start", { task: task.id, target: `${start.target.owner}/${start.target.repo}#${start.target.number}`, result: line });
    }
  } catch (error) {
    let message = errorMessage(error);
    // An agent acting as its own GitHub account fails like this when the account can't reach the repository.
    if (/\b(401|403|404)\b|Not Found|Bad credentials|Authentication failed|Repository not found|Resource not accessible|Permission to .* denied/i.test(message)) {
      const account = await agentAccount(task.agent).catch(() => null);
      if (account?.login) message += ` (${task.agent} acts on GitHub as @${account.login}: check that this account can access ${task.owner}/${task.repo} and that its token is still valid, or remove the account from the agent to use the GitHub App.)`;
    }
    log.error("Task failed", { task: task.id, error: message });
    onEvent("error", message);
    await finish("failed", task.resultText ?? "", message);
  }

  /** After the reply: move the sub-issue cards the agent moved, and put the sub-issues it created on the board. */
  async function settleSubIssues(context: BoardContext, subMoves: SubIssueMove[], newCards: SubIssueMove["issue"][], column: string | null) {
    const { board } = context;
    const handoff = (itemId: string, subMove: SubIssueMove) =>
      addHandoff(board.name, itemId, { taskId: task.id, agent: profile!.name, fromColumn: subMove.from ?? "off the board", toColumn: subMove.to, note: `From the parent issue #${task.threadNumber}:\n\n${subMove.note}` });
    for (const subMove of subMoves) {
      try {
        if (subMove.itemId) {
          handoff(subMove.itemId, subMove);
          await moveCard(board, subMove.itemId, subMove.to, { agentMove: true, startedBy: task.id, actor: task });
        } else {
          const itemId = await addIssueToBoard(board, subMove.issue, subMove.to, { trigger: false, fields: context.subIssueFields[subMove.issue.number] });
          handoff(itemId, subMove);
          await startColumnAgent(board, itemId, undefined, task.id);
        }
        emit(task.id, "system", `Moved sub-issue #${subMove.issue.number} to ${subMove.to}`);
      } catch (error) {
        log.warn("Could not move a sub-issue's card", { task: task.id, issue: subMove.issue.number, error: errorMessage(error) });
        emit(task.id, "error", `Couldn't move sub-issue #${subMove.issue.number}: ${errorMessage(error)}`);
      }
    }
    for (const issue of column ? newCards : []) {
      try {
        await addIssueToBoard(board, issue, column!, { trigger: true, fields: context.subIssueFields[issue.number], startedBy: task.id });
        emit(task.id, "system", `Added sub-issue #${issue.number} to the board in ${column}`);
      } catch (error) {
        emit(task.id, "error", `Couldn't add sub-issue #${issue.number} to the board: ${errorMessage(error)}`);
      }
    }
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
    if (status === "failed" && !task.dryRun) recordIncident("task_failed", "warning", `${task.agent} failed on ${task.owner}/${task.repo}#${task.threadNumber}: ${reason.split("\n")[0]!.slice(0, 300)}`, { taskId: task.id });
    // Mentions that arrived too late for the agent to see become a follow-up run.
    settleInbox(task, status !== "cancelled");
    emit(task.id, "status", status === "succeeded" ? "Finished" : status === "cancelled" ? "Cancelled" : `Failed: ${reason}`);
    await throttle.flush(true);
    await throttle.stop();
    if (!gh || !profile || task.dryRun) return;
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
    const gh = await clientFor(task);
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
