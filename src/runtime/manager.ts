import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { takeInbox } from "../runner/inbox.ts";
import { errorMessage, log } from "../log.ts";
import type { Effort, Library, Profile } from "../profiles/types.ts";
import type { Task } from "../types.ts";
import { createGithubServer, type ToolContext } from "./github-tools.ts";
import { buildOptions, PER_TASK_ENV } from "./options.ts";
import { testRunHooks } from "./evidence.ts";
import { loadBoards } from "../boards/loader.ts";
import { hasCardFields } from "../boards/rules.ts";
import { AgentSession, type EventSink, type TurnOutcome } from "./session.ts";
import type { Workspace } from "./workspace.ts";

interface Entry {
  key: string;
  agent: string;
  owner: string;
  repo: string;
  threadKind: Task["threadKind"];
  threadNumber: number;
  configHash: string;
  session: AgentSession;
  /** The GitHub tools read the active task from here. */
  context: { current: ToolContext | null };
  live: boolean;
  busy: boolean;
  turns: number;
  lastUsedAt: number;
}

export interface SessionView {
  key: string;
  agent: string;
  owner: string;
  repo: string;
  threadKind: Task["threadKind"];
  threadNumber: number;
  sessionId: string | null;
  busy: boolean;
  turns: number;
  startedAt: string;
  lastUsedAt: string;
  closesAt: string | null;
}

export interface RunTurnOptions {
  task: Task;
  profile: Profile;
  library: Library;
  workspace: Workspace;
  env: Record<string, string>;
  resumeSessionId: string | null;
  /** The full prompt for a fresh session, and the shorter one for a session that already knows the thread. */
  prompts: { full: string; followUp: string };
  context: ToolContext;
  /** Board column overrides for this turn. */
  model?: string | null;
  effort?: Effort | null;
  onEvent: EventSink;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface RunTurnOutcome extends TurnOutcome {
  prompt: string;
  live: boolean;
}

/**
 * Hooks that hand the agent what people did on GitHub while it works: after each round of tool
 * calls, and when it's about to finish (so it continues and deals with it instead of stopping).
 * Subagents don't get it; their parent does, once they report back.
 */
function inboxHooks(context: Entry["context"]): Options["hooks"] {
  const hand = (event: "PostToolBatch" | "Stop"): HookCallback => async (input) => {
    if (input.agent_id) return {};
    const task = context.current?.task;
    const text = task ? takeInbox(task.id) : null;
    if (!text) return {};
    return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  };
  return { PostToolBatch: [{ hooks: [hand("PostToolBatch")] }], Stop: [{ hooks: [hand("Stop")] }] };
}

/** Does any board track start/end dates or estimates? Then agents get set_card_fields. */
function anyBoardTracksFields(): boolean {
  try {
    return loadBoards().boards.some((board) => hasCardFields(board.fields));
  } catch {
    return false;
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function sessionKey(task: Pick<Task, "agent" | "owner" | "repo" | "threadKind" | "threadNumber">): string {
  return `${task.agent}|${task.owner}/${task.repo}|${task.threadKind}#${task.threadNumber}`.toLowerCase();
}

/** Runs agent turns, keeping live sessions open between tasks on the same thread. */
class Sessions {
  private entries = new Map<string, Entry>();
  private reaper: NodeJS.Timeout | null = null;

  get idleMinutes(): number {
    const stored = Number(getSetting("live_idle_minutes"));
    return Number.isFinite(stored) && stored > 0 ? stored : config.liveIdleMinutes;
  }

  get maxLive(): number {
    const stored = Number(getSetting("max_live_sessions"));
    return Number.isFinite(stored) && stored > 0 ? stored : config.maxLiveSessions;
  }

  configure(settings: { idleMinutes?: number; maxLive?: number }): void {
    if (settings.idleMinutes) setSetting("live_idle_minutes", String(Math.max(1, Math.min(1440, Math.floor(settings.idleMinutes)))));
    if (settings.maxLive) setSetting("max_live_sessions", String(Math.max(1, Math.min(64, Math.floor(settings.maxLive)))));
    bus.publish({ type: "settings" });
  }

  start(): void {
    this.reaper ??= setInterval(() => this.reap(), 30_000);
    this.reaper.unref();
  }

  list(): SessionView[] {
    const idleMs = this.idleMinutes * 60_000;
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      agent: entry.agent,
      owner: entry.owner,
      repo: entry.repo,
      threadKind: entry.threadKind,
      threadNumber: entry.threadNumber,
      sessionId: entry.session.sessionId,
      busy: entry.busy,
      turns: entry.turns,
      startedAt: new Date(entry.session.startedAt).toISOString(),
      lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      closesAt: entry.busy ? null : new Date(entry.lastUsedAt + idleMs).toISOString(),
    }));
  }

  private changed(): void {
    bus.publish({ type: "sessions" });
  }

  close(key: string, reason: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    log.info("Closing agent session", { key, reason });
    entry.session.close();
    this.changed();
    return true;
  }

  closeAll(reason = "shutting down"): void {
    for (const key of [...this.entries.keys()]) this.close(key, reason);
  }

  private reap(): void {
    const cutoff = Date.now() - this.idleMinutes * 60_000;
    for (const entry of [...this.entries.values()]) {
      if (!entry.session.alive) this.close(entry.key, "process ended");
      else if (!entry.busy && entry.lastUsedAt < cutoff) this.close(entry.key, `idle for ${this.idleMinutes} minutes`);
    }
  }

  private makeRoom(): void {
    const live = [...this.entries.values()].filter((entry) => !entry.busy);
    while (this.entries.size >= this.maxLive && live.length) {
      const oldest = live.sort((a, b) => a.lastUsedAt - b.lastUsedAt).shift()!;
      this.close(oldest.key, "making room for another session");
    }
  }

  private open(options: RunTurnOptions, key: string, configHash: string, resume: string | null): Entry {
    const { task, profile, library, workspace, env } = options;
    this.makeRoom();
    const context: Entry["context"] = { current: null };
    const github = createGithubServer(profile, () => context.current, { cardFields: anyBoardTracksFields() });
    const session = new AgentSession(
      buildOptions({
        profile,
        library,
        workspace,
        env,
        github,
        resume,
        stateDir: join(config.dataDir, "sessions", hash(key)),
        model: options.model,
        effort: options.effort,
        hooks: { ...inboxHooks(context), ...testRunHooks(() => context.current) },
      }),
    );
    const entry: Entry = {
      key,
      agent: profile.name,
      owner: task.owner,
      repo: task.repo,
      threadKind: task.threadKind,
      threadNumber: task.threadNumber,
      configHash,
      session,
      context,
      live: profile.live,
      busy: false,
      turns: 0,
      lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.changed();
    return entry;
  }

  async run(options: RunTurnOptions): Promise<RunTurnOutcome> {
    const { task, profile, env, prompts, context, onEvent, signal, timeoutMs } = options;
    const key = sessionKey(task);
    const stableEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !PER_TASK_ENV.has(name)));
    const configHash = hash({
      profile: { ...profile, enabled: undefined, enabledInFile: undefined },
      library: options.library,
      env: stableEnv,
      cwd: options.workspace.dir,
      model: options.model ?? null,
      effort: options.effort ?? null,
      cardFields: anyBoardTracksFields(),
    });

    let entry = this.entries.get(key);
    if (entry && (!entry.session.alive || entry.configHash !== configHash)) {
      this.close(key, entry.session.alive ? "the agent's profile changed" : "process ended");
      entry = undefined;
    }
    const reused = Boolean(entry);
    if (!entry) {
      entry = this.open(options, key, configHash, options.resumeSessionId);
      onEvent("system", options.resumeSessionId ? "Resuming the agent's previous session" : "Starting a new agent session");
    } else {
      onEvent("system", `Continuing the live session (turn ${entry.turns + 1})`);
    }

    entry.busy = true;
    entry.context.current = context;
    this.changed();
    try {
      let prompt = reused || entry.session.resumed ? prompts.followUp : prompts.full;
      let outcome = await entry.session.turn(prompt, onEvent, signal, timeoutMs);

      // A resumed session that fails at once usually means the old conversation is gone.
      const failedFast = outcome.isError && !outcome.cancelled && !outcome.timedOut && !outcome.limit && outcome.toolEvents === 0;
      if (failedFast && !reused && entry.session.resumed) {
        onEvent("system", `Couldn't resume the previous session (${outcome.error ?? "unknown error"}); starting a new one`);
        this.close(key, "resume failed");
        entry = this.open(options, key, configHash, null);
        entry.busy = true;
        entry.context.current = context;
        prompt = prompts.full;
        outcome = await entry.session.turn(prompt, onEvent, signal, timeoutMs);
      }
      entry.turns++;
      return { ...outcome, prompt, live: profile.live };
    } catch (error) {
      return {
        result: "",
        sessionId: entry.session.sessionId,
        costUsd: null,
        usage: null,
        isError: true,
        error: errorMessage(error),
        cancelled: false,
        timedOut: false,
        exited: false,
        toolEvents: 0,
        limit: null,
        serverError: null,
        prompt: prompts.full,
        live: profile.live,
      };
    } finally {
      entry.busy = false;
      entry.context.current = null;
      entry.lastUsedAt = Date.now();
      // One-off agents and dead processes don't stay around.
      if (!entry.live || !entry.session.alive) this.close(key, entry.live ? "process ended" : "task finished");
      this.changed();
    }
  }
}

export const sessions = new Sessions();
