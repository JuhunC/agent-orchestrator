import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { PROGRESS_MARKER, RESULT_MARKER } from "../github/threads.ts";
import type { Task, WaitFor } from "../types.ts";
import { githubThrottled } from "../github/app.ts";

type Agent = { name: string };

export type ProgressPhase = "queued" | "starting" | "working" | "waiting" | "parked" | "retrying" | "publishing" | "succeeded" | "failed" | "cancelled";

export interface ProgressState {
  phase: ProgressPhase;
  steps: string[];
  latestText: string;
  startedAt: number;
  finishedAt: number | null;
  note: string;
  prNumber: number | null;
  prUrl: string | null;
}

const MAX_STEPS = 15;

/** Live activity for agents that don't set github.live_activity: the Settings switch, else LIVE_ACTIVITY (off). */
export function liveActivityDefault(): boolean {
  const stored = getSetting("live_activity");
  return stored === null ? config.liveActivity : stored === "true";
}

export function setLiveActivityDefault(on: boolean): void {
  setSetting("live_activity", String(on));
  bus.publish({ type: "settings" });
}

/** Does this agent post a progress comment and edit it as it works? Otherwise it only posts its result. */
export function liveActivityFor(profile: { github: { liveActivity: boolean | null } }): boolean {
  return profile.github.liveActivity ?? liveActivityDefault();
}

/** `@login` for GitHub users; plain text for admin-UI names that would otherwise ping a stranger. */
export function mention(login: string): string {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login) && login !== "dev" ? `@${login}` : login;
}

export function taskAdminUrl(taskId: number): string {
  return `${config.publicUrl}/#/tasks/${taskId}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + " UTC";
}

const HEADLINE: Record<ProgressPhase, string> = {
  queued: "⏳ is queued",
  starting: "🔄 is getting ready",
  working: "🔄 is working on this",
  waiting: "⏸️ is paused until its usage limit resets",
  parked: "⏳ paused this until other work is done",
  retrying: "🔁 will try again shortly",
  publishing: "📤 is pushing its changes",
  succeeded: "✅ finished",
  failed: "❌ stopped with an error",
  cancelled: "⏹️ was cancelled",
};

/** For a task that ended without an error but whose agent said it didn't do all of it (report_outcome). */
const REPORTED: Record<string, { headline: string; result: string }> = {
  partial: { headline: "⚠️ finished part of this", result: "finished part of this ⚠️" },
  blocked: { headline: "🚧 is blocked and needs someone", result: "is blocked and needs someone 🚧" },
  gave_up: { headline: "🏳️ couldn't do this", result: "couldn't do this 🏳️" },
};
const reportedBy = (task: Task) => (task.outcome && task.outcomeNote ? REPORTED[task.outcome] : undefined);

/** The single comment that's edited as the agent works. */
export function renderProgress(agent: Agent, task: Task, state: ProgressState, now = Date.now()): string {
  const done = state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled";
  const elapsed = formatDuration((state.finishedAt ?? now) - state.startedAt);
  const lines = [
    PROGRESS_MARKER,
    `**🤖 ${agent.name}** ${(state.phase === "succeeded" && reportedBy(task)?.headline) || HEADLINE[state.phase]}${done ? ` in ${elapsed}` : ""} · requested by ${mention(task.requestedBy)}`,
  ];
  if (state.phase === "succeeded" && reportedBy(task)) lines.push("", `**Why:** ${task.outcomeNote}`);
  if (state.prUrl) lines.push(`Pull request: ${state.prUrl}`);
  if (state.note) lines.push("", state.note);

  const steps = state.steps;
  if (steps.length || state.latestText) {
    const hidden = Math.max(0, steps.length - MAX_STEPS);
    const visible = steps.slice(-MAX_STEPS).map((step, index, all) => {
      const current = !done && index === all.length - 1;
      return `- ${current ? "⏳ " : ""}${step}`;
    });
    lines.push(
      "",
      `<details${done ? "" : " open"}><summary>Activity (${steps.length} step${steps.length === 1 ? "" : "s"})</summary>`,
      "",
      ...(hidden ? [`- …${hidden} earlier step${hidden === 1 ? "" : "s"}`] : []),
      ...visible,
    );
    if (!done && state.latestText) lines.push("", `💬 _${state.latestText.replace(/[_*`]/g, "")}_`);
    lines.push("", "</details>");
  }

  lines.push(
    "",
    `<sub>${done ? "Ran" : "Started"} ${clock(state.startedAt)} · ${done ? elapsed : `${elapsed} so far`} · [task #${task.id}](${taskAdminUrl(task.id)})</sub>`,
  );
  return lines.join("\n");
}

/** The comment posted when the agent finishes, so the requester gets notified. */
export function renderResult(
  agent: Agent,
  task: Task,
  outcome: { ok: boolean; text: string; durationMs: number; prUrl: string | null; prNumber: number | null; commits: number; details?: string },
): string {
  const reported = outcome.ok ? reportedBy(task) : undefined;
  const head = outcome.ok
    ? `${mention(task.requestedBy)} **${agent.name}** ${reported?.result ?? "finished ✅"}${outcome.prNumber ? ` · #${outcome.prNumber}` : ""}`
    : `${mention(task.requestedBy)} **${agent.name}** couldn't finish ❌`;
  const meta = [
    `[task #${task.id}](${taskAdminUrl(task.id)})`,
    formatDuration(outcome.durationMs),
    task.branch && outcome.commits ? `${outcome.commits} commit${outcome.commits === 1 ? "" : "s"} on \`${task.branch}\`` : "",
    task.costUsd ? `$${task.costUsd.toFixed(2)}` : "",
  ].filter(Boolean);
  const parts = [RESULT_MARKER, head, ...(reported ? ["", `**Why:** ${task.outcomeNote}`] : []), "", outcome.text.trim() || "_The agent finished without a reply._"];
  if (outcome.details) parts.push("", outcome.details);
  parts.push("", `<sub>${meta.join(" · ")}</sub>`);
  return parts.join("\n");
}

/** `2026-03-01 14:30 UTC` */
export function stamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The comment posted when an agent pauses its task (wait_for): what it waits for, and where things
 * stand. The result comment follows when the task is resumed and finishes.
 */
export function renderWaiting(agent: Agent, task: Task, pause: { text: string; wait: WaitFor; waitingFor: string; details?: string }): string {
  const until = pause.wait.until === "time" ? `it carries on at **${pause.waitingFor}**` : `it carries on when **${pause.waitingFor}**, or at the latest ${stamp(pause.wait.deadline)}`;
  const parts = [RESULT_MARKER, `${mention(task.requestedBy)} **${agent.name}** paused this task ⏳ — ${until}.`, "", `**Why:** ${pause.wait.note}`];
  if (pause.text.trim()) parts.push("", pause.text.trim());
  if (pause.details) parts.push("", pause.details);
  parts.push("", `<sub>Mention it here to wake it sooner · [task #${task.id}](${taskAdminUrl(task.id)})</sub>`);
  return parts.join("\n");
}

/** A paused task was cancelled before it resumed: its "paused" comment on the thread would otherwise promise it carries on. */
export function renderPauseCancelled(agent: Agent, task: Task, reason: string): string {
  return [RESULT_MARKER, `${mention(task.requestedBy)} **${agent.name}**'s paused task was cancelled ⏹️ and won't carry on.`, "", reason, "", `<sub>Mention it here to start it again · [task #${task.id}](${taskAdminUrl(task.id)})</sub>`].join("\n");
}

/** When progress comments were edited in the last hour, by any task (PROGRESS_EDITS_PER_HOUR). */
const recentEdits: number[] = [];

/**
 * May a task edit its progress comment now? Edits are optional (the comment is completed when the
 * task ends anyway), so they stop when all tasks together have used the hour's budget, or while
 * GitHub is asking the orchestrator to slow down. Takes a slot from the budget when it says yes.
 */
export function progressEditAllowed(now = Date.now()): boolean {
  if (config.progressEditsPerHour <= 0 || githubThrottled(now)) return false;
  while (recentEdits.length && now - recentEdits[0]! > 3_600_000) recentEdits.shift();
  if (recentEdits.length >= config.progressEditsPerHour) return false;
  recentEdits.push(now);
  return true;
}

/** Edits the progress comment at most every PROGRESS_UPDATE_SECONDS, and only when something changed. */
export class ProgressThrottle {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private inFlight: Promise<void> = Promise.resolve();
  private flushFn: (force: boolean) => Promise<void>;

  /** `flush` gets `force` for updates that must go out (phase changes, the end), not optional ones. */
  constructor(flush: (force: boolean) => Promise<void>) {
    this.flushFn = flush;
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), Math.max(5, config.progressUpdateSeconds) * 1000);
    this.timer.unref();
  }

  markDirty(): void {
    this.dirty = true;
  }

  flush(force = false): Promise<void> {
    if (!this.dirty && !force) return this.inFlight;
    this.dirty = false;
    this.inFlight = this.inFlight.then(() => this.flushFn(force)).catch(() => undefined);
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
