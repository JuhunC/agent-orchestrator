import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createAdapter, type AdapterResult } from "../agents/adapters.ts";
import { buildPrompt, type WorkspaceInfo } from "../agents/prompt.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { addEvent, getAgent, lastSessionId, linkThreads, threadHistory, updateTask } from "../db.ts";
import { getBotIdentity, installationClient, installationToken, repoRemoteUrl, type GitHubClient } from "../github/app.ts";
import { editComment, fetchThread, findOpenPull, openPull, postComment, type ThreadContext } from "../github/threads.ts";
import { errorMessage, log } from "../log.ts";
import type { Agent, EventKind, Task, ThreadRef } from "../types.ts";
import { git, refExists } from "./git.ts";
import { mention, ProgressThrottle, renderProgress, renderResult, type ProgressState } from "./progress.ts";

function patch(taskId: number, changes: Partial<Task>): Task {
  const task = updateTask(taskId, changes);
  bus.publish({ type: "task", task });
  return task;
}

function emit(taskId: number, kind: EventKind, message: string): void {
  bus.publish({ type: "event", event: addEvent(taskId, kind, message) });
}

export function workspaceDir(task: Pick<Task, "owner" | "repo" | "agent" | "threadKind" | "threadNumber">): string {
  return join(config.dataDir, "workspaces", task.owner, task.repo, task.agent, `${task.threadKind}-${task.threadNumber}`);
}

interface Workspace extends WorkspaceInfo {
  dir: string;
  startSha: string;
}

async function prepareWorkspace(task: Task, agent: Agent, thread: ThreadContext): Promise<Workspace> {
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
      branch = `agent/${agent.name}/pull-${thread.number}`;
      await git(dir, ["fetch", "origin", `+refs/pull/${thread.number}/head:refs/remotes/origin/pr-${thread.number}`], { token });
      startPoint = `origin/pr-${thread.number}`;
      canPush = false;
    }
  } else {
    baseBranch = thread.defaultBranch;
    branch = `agent/${agent.name}/${thread.kind}-${thread.number}`;
    startPoint = (await refExists(dir, `refs/remotes/origin/${branch}`)) ? `origin/${branch}` : `origin/${baseBranch}`;
  }
  if (!(await refExists(dir, startPoint))) throw new Error(`Branch ${startPoint.replace("origin/", "")} not found (is the repository empty?)`);

  await git(dir, ["checkout", "--force", "-B", branch, startPoint]);
  await git(dir, ["clean", "-fd"]);
  const identity = await getBotIdentity(task.installationId);
  await git(dir, ["config", "user.name", identity.name]);
  await git(dir, ["config", "user.email", identity.email]);
  const startSha = await git(dir, ["rev-parse", "HEAD"]);

  return { dir, branch, baseBranch, canPush, willPush: canPush && agent.openPullRequest, startSha };
}

function expand(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key]! : match));
}

function agentEnv(agent: Agent, task: Task, workspace: Workspace, promptFile: string, token: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: config.agentHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "true",
    AO_TASK_ID: String(task.id),
    AO_AGENT: agent.name,
    AO_REPO: `${task.owner}/${task.repo}`,
    AO_THREAD_KIND: task.threadKind,
    AO_THREAD_NUMBER: String(task.threadNumber),
    AO_THREAD_URL: task.threadUrl,
    AO_REQUESTED_BY: task.requestedBy,
    AO_BRANCH: workspace.branch,
    AO_PROMPT_FILE: promptFile,
    AO_GITHUB_URL: config.github.url,
  };
  for (const name of config.agentEnvPassthrough) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  for (const [key, value] of Object.entries(agent.env)) {
    const expanded = value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
    // An empty value (e.g. `${UNSET}`) doesn't override a variable that's already there.
    if (expanded || !env[key]) env[key] = expanded;
  }
  if (token) {
    env.GH_TOKEN = token;
    env.GITHUB_TOKEN = token;
    if (!config.github.isDotCom) {
      env.GH_HOST = new URL(config.github.url).host;
      env.GH_ENTERPRISE_TOKEN = token;
    }
  }
  return env;
}

interface RunOutcome extends AdapterResult {
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  toolEvents: number;
  stderrTail: string[];
}

function runAgentProcess(
  agent: Agent,
  task: Task,
  args: string[],
  workspace: Workspace,
  env: Record<string, string>,
  prompt: string | null,
  signal: AbortSignal,
  onEvent: (kind: EventKind, message: string) => void,
): Promise<RunOutcome> {
  const adapter = createAdapter(agent.output, workspace.dir);
  const timeoutMs = (agent.timeoutMinutes ?? config.defaultTimeoutMinutes) * 60_000;
  const stderrTail: string[] = [];
  let toolEvents = 0;
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(agent.command, args, {
      cwd: workspace.dir,
      env,
      detached: true,
      stdio: [prompt === null ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 10_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      onEvent("error", `Timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort, { once: true });

    if (prompt !== null && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt);
    }

    createInterface({ input: child.stdout! }).on("line", (line) => {
      for (const event of adapter.onLine(line)) {
        if (event.kind === "tool") toolEvents++;
        onEvent(event.kind, event.message);
      }
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (!line.trim()) return;
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      onEvent("stderr", line.slice(0, 1000));
    });

    let settled = false;
    const finish = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (spawnError) stderrTail.push(spawnError.message);
      resolve({
        ...adapter.finish(),
        exitCode,
        cancelled: signal.aborted,
        timedOut,
        toolEvents,
        stderrTail,
      });
    };
    child.on("error", (error) => finish(null, error));
    // "close" waits for stdout/stderr to drain, so the adapter has seen every line.
    child.on("close", (code) => finish(code));
  });
}

function commitMessage(agent: Agent, task: Task, thread: ThreadContext): string {
  const title = `${agent.name}: ${thread.title}`.slice(0, 72);
  return `${title}\n\nRequested by ${mention(task.requestedBy)} in ${task.requestUrl || thread.url}\nOrchestrator task #${task.id}`;
}

async function publishChanges(
  gh: GitHubClient,
  task: Task,
  agent: Agent,
  thread: ThreadContext,
  workspace: Workspace,
  summary: string,
): Promise<{ commits: number; pr: { number: number; url: string } | null; files: string[] }> {
  const { dir } = workspace;
  await git(dir, ["add", "-A"]);
  if ((await git(dir, ["diff", "--cached", "--name-only"])).trim()) {
    await git(dir, ["commit", "--no-verify", "-m", commitMessage(agent, task, thread)]);
  }
  const commits = Number(await git(dir, ["rev-list", "--count", `${workspace.startSha}..HEAD`]));
  if (!commits) return { commits: 0, pr: null, files: [] };
  const files = (await git(dir, ["diff", "--name-only", `${workspace.startSha}..HEAD`])).split("\n").filter(Boolean);

  const token = await installationToken(task.installationId);
  await git(dir, ["push", "origin", `HEAD:refs/heads/${workspace.branch}`], { token });

  if (thread.kind === "pull") return { commits, pr: { number: thread.number, url: thread.url }, files };

  let pr = await findOpenPull(gh, task.owner, task.repo, workspace.branch);
  if (!pr) {
    const link = thread.kind === "issue" ? `Closes #${thread.number}` : `From discussion #${thread.number}: ${thread.url}`;
    pr = await openPull(gh, {
      owner: task.owner,
      repo: task.repo,
      head: workspace.branch,
      base: workspace.baseBranch,
      title: thread.title,
      body: [
        link,
        "",
        summary.trim() || "_No summary from the agent._",
        "",
        `<sub>Opened by **${agent.name}** for ${mention(task.requestedBy)} · orchestrator task #${task.id}. Mention @${agent.handle} on this PR to ask for changes.</sub>`,
      ].join("\n"),
    });
  }
  linkThreads(task.owner, task.repo, { kind: thread.kind, number: thread.number }, { kind: "pull", number: pr.number });
  return { commits, pr, files };
}

/** Runs one task from start to finish. Never throws. */
export async function executeTask(initial: Task, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let task = patch(initial.id, { status: "running", startedAt: new Date(startedAt).toISOString(), error: null });
  const agent = getAgent(task.agent);
  const ref: ThreadRef = { owner: task.owner, repo: task.repo, kind: task.threadKind, number: task.threadNumber };
  const state: ProgressState = {
    phase: "starting",
    steps: [],
    latestText: "",
    startedAt,
    finishedAt: null,
    note: "",
    prNumber: null,
    prUrl: null,
  };

  let gh: GitHubClient | null = null;
  let thread: ThreadContext | null = null;
  const target = () => ({ owner: task.owner, repo: task.repo, kind: task.threadKind, number: task.threadNumber, threadNodeId: thread?.nodeId });
  const throttle = new ProgressThrottle(async () => {
    if (!gh || !agent || !task.progressCommentId) return;
    await editComment(gh, target(), task.progressCommentId, renderProgress(agent, task, state)).catch((error) =>
      log.warn("Could not update progress comment", { task: task.id, error: errorMessage(error) }),
    );
  });

  const onEvent = (kind: EventKind, message: string) => {
    emit(task.id, kind, message);
    if (kind === "tool" || kind === "error") state.steps.push(message);
    if (kind === "text") state.latestText = message.slice(0, 200);
    if (kind !== "stderr") throttle.markDirty();
  };

  try {
    if (!agent) throw new Error(`Agent "${task.agent}" no longer exists`);
    emit(task.id, "status", `Started ${agent.name}`);
    gh = await installationClient(task.installationId);
    thread = await fetchThread(gh, task.owner, task.repo, task.threadKind, task.threadNumber);
    task = patch(task.id, { threadTitle: thread.title, threadUrl: thread.url });

    const comment = await postComment(gh, target(), renderProgress(agent, task, state));
    task = patch(task.id, { progressCommentId: comment.id });
    throttle.start();

    emit(task.id, "status", "Preparing workspace");
    const workspace = await prepareWorkspace(task, agent, thread);
    task = patch(task.id, { branch: workspace.branch, baseBranch: workspace.baseBranch });
    onEvent("system", `Checked out \`${workspace.branch}\``);

    const history = threadHistory(ref, agent.name, task.id);
    if (history.length) onEvent("system", `Loaded ${history.length} earlier run${history.length === 1 ? "" : "s"} as context`);
    const prompt = buildPrompt({ agent, task, thread, history, workspace });
    task = patch(task.id, { prompt });

    const promptFile = join(config.dataDir, "prompts", `task-${task.id}.md`);
    mkdirSync(dirname(promptFile), { recursive: true });
    mkdirSync(config.agentHome, { recursive: true });
    writeFileSync(promptFile, prompt);

    const token = agent.exposeGithubToken ? await installationToken(task.installationId) : null;
    const env = agentEnv(agent, task, workspace, promptFile, token);
    const sessionId = agent.resumeArgs.length ? lastSessionId(ref, agent.name) : null;

    state.phase = "working";
    throttle.markDirty();
    const attempt = (resume: boolean) => {
      const template = resume ? agent.resumeArgs : agent.args;
      const values = {
        prompt,
        prompt_file: promptFile,
        session_id: sessionId ?? "",
        workdir: workspace.dir,
        branch: workspace.branch,
        repo: `${task.owner}/${task.repo}`,
        task_id: String(task.id),
      };
      const args = template.map((arg) => expand(arg, values));
      const usesPromptArg = template.some((arg) => arg.includes("{prompt}") || arg.includes("{prompt_file}"));
      emit(task.id, "status", `Running ${agent.command}${resume ? " (resuming the previous session)" : ""}`);
      return runAgentProcess(agent, task, args, workspace, env, usesPromptArg ? null : prompt, signal, onEvent);
    };

    let outcome = await attempt(Boolean(sessionId));
    if (sessionId && !outcome.cancelled && !outcome.timedOut && (outcome.exitCode !== 0 || outcome.isError) && outcome.toolEvents === 0) {
      onEvent("system", "Could not resume the previous session; starting a fresh one");
      outcome = await attempt(false);
    }
    task = patch(task.id, { exitCode: outcome.exitCode, sessionId: outcome.sessionId, costUsd: outcome.costUsd, resultText: outcome.result });

    if (outcome.cancelled) {
      if (signal.reason === "shutdown") {
        await finish("failed", outcome.result, "The orchestrator stopped while this was running. Mention the agent again to retry.");
      } else {
        await finish("cancelled", outcome.result, "Cancelled from the admin UI.");
      }
      return;
    }
    if (outcome.timedOut || outcome.exitCode !== 0 || outcome.isError) {
      const reason = outcome.timedOut
        ? `Timed out after ${agent.timeoutMinutes ?? config.defaultTimeoutMinutes} minutes.`
        : outcome.exitCode === null
          ? `Could not start \`${agent.command}\`: ${outcome.stderrTail.at(-1) ?? "unknown error"}`
          : `\`${agent.command}\` exited with code ${outcome.exitCode}.`;
      const tail = outcome.stderrTail.slice(-15).join("\n").replace(/```/g, "ʼʼʼ");
      await finish("failed", outcome.result, reason, tail ? `<details><summary>Last error output</summary>\n\n\`\`\`text\n${tail}\n\`\`\`\n</details>` : "");
      return;
    }

    let commits = 0;
    let details = "";
    if (workspace.willPush) {
      state.phase = "publishing";
      await throttle.flush(true);
      const published = await publishChanges(gh, task, agent, thread, workspace, outcome.result);
      commits = published.commits;
      if (published.pr) {
        state.prNumber = published.pr.number;
        state.prUrl = thread.kind === "pull" ? null : published.pr.url;
        task = patch(task.id, { prNumber: published.pr.number, prUrl: published.pr.url, commits });
        onEvent("system", thread.kind === "pull" ? `Pushed ${commits} commit${commits === 1 ? "" : "s"} to this PR` : `Pull request #${published.pr.number} is ready`);
      } else {
        task = patch(task.id, { commits: 0 });
        onEvent("system", "No file changes to push");
      }
      if (published.files.length) {
        const list = published.files.slice(0, 30).map((file) => `- \`${file}\``).join("\n");
        details = `<details><summary>Changed files (${published.files.length})</summary>\n\n${list}${published.files.length > 30 ? "\n- …" : ""}\n</details>`;
      }
    } else if (!workspace.canPush) {
      const dirty = await git(workspace.dir, ["status", "--porcelain"]);
      if (dirty) onEvent("system", "Changes were made locally but this PR is from a fork, so they were not pushed");
    }
    await finish("succeeded", outcome.result, "", details, commits);
  } catch (error) {
    const message = errorMessage(error);
    log.error("Task failed", { task: task.id, error: message });
    onEvent("error", message);
    await finish("failed", task.resultText ?? "", message);
  }

  async function finish(status: "succeeded" | "failed" | "cancelled", text: string, reason: string, details = "", commits = 0) {
    state.phase = status;
    state.finishedAt = Date.now();
    state.note = status === "succeeded" ? "" : reason;
    task = patch(task.id, {
      status,
      finishedAt: new Date(state.finishedAt).toISOString(),
      error: status === "succeeded" ? null : reason,
      resultText: text || task.resultText,
    });
    emit(task.id, "status", status === "succeeded" ? "Finished" : status === "cancelled" ? "Cancelled" : `Failed: ${reason}`);
    await throttle.flush(true);
    await throttle.stop();
    if (!gh || !agent) return;
    const body = renderResult(agent, task, {
      ok: status === "succeeded",
      text: status === "succeeded" ? text : [reason, text ? `\n**Last reply from the agent:**\n\n${text}` : ""].join("\n"),
      durationMs: state.finishedAt - startedAt,
      prUrl: state.prUrl,
      prNumber: state.prNumber && task.threadKind !== "pull" ? state.prNumber : null,
      commits,
      details,
    });
    if (status === "cancelled" && !task.progressCommentId) return;
    await postComment(gh, target(), body).catch((error) => log.warn("Could not post result comment", { task: task.id, error: errorMessage(error) }));
  }
}

/** Marks a task interrupted by a restart as failed, and says so on GitHub. */
export async function markInterrupted(task: Task): Promise<void> {
  const updated = patch(task.id, { status: "failed", finishedAt: new Date().toISOString(), error: "Interrupted because the orchestrator restarted" });
  emit(task.id, "error", "Interrupted because the orchestrator restarted");
  const agent = getAgent(task.agent);
  if (!agent || !task.progressCommentId) return;
  try {
    const gh = await installationClient(task.installationId);
    const startedAt = task.startedAt ? Date.parse(task.startedAt) : Date.now();
    const state: ProgressState = {
      phase: "failed",
      steps: [],
      latestText: "",
      startedAt,
      finishedAt: Date.now(),
      note: "The orchestrator restarted while this was running. Mention the agent again to retry.",
      prNumber: null,
      prUrl: null,
    };
    await editComment(gh, { owner: task.owner, repo: task.repo, kind: task.threadKind }, task.progressCommentId, renderProgress(agent, updated, state));
  } catch (error) {
    log.warn("Could not update interrupted task's comment", { task: task.id, error: errorMessage(error) });
  }
}
