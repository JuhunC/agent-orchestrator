import { config } from "../config.ts";
import { PROGRESS_MARKER, RESULT_MARKER } from "../github/threads.ts";
import type { Agent, Task } from "../types.ts";

export type ProgressPhase = "queued" | "starting" | "working" | "publishing" | "succeeded" | "failed" | "cancelled";

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
  publishing: "📤 is pushing its changes",
  succeeded: "✅ finished",
  failed: "❌ stopped with an error",
  cancelled: "⏹️ was cancelled",
};

/** The single comment that's edited as the agent works. */
export function renderProgress(agent: Agent, task: Task, state: ProgressState, now = Date.now()): string {
  const done = state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled";
  const elapsed = formatDuration((state.finishedAt ?? now) - state.startedAt);
  const lines = [
    PROGRESS_MARKER,
    `**🤖 ${agent.name}** ${HEADLINE[state.phase]}${done ? ` in ${elapsed}` : ""} · requested by ${mention(task.requestedBy)}`,
  ];
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
  const head = outcome.ok
    ? `${mention(task.requestedBy)} **${agent.name}** finished ✅${outcome.prNumber ? ` · #${outcome.prNumber}` : ""}`
    : `${mention(task.requestedBy)} **${agent.name}** couldn't finish ❌`;
  const meta = [
    `[task #${task.id}](${taskAdminUrl(task.id)})`,
    formatDuration(outcome.durationMs),
    task.branch && outcome.commits ? `${outcome.commits} commit${outcome.commits === 1 ? "" : "s"} on \`${task.branch}\`` : "",
    task.costUsd ? `$${task.costUsd.toFixed(2)}` : "",
  ].filter(Boolean);
  const parts = [RESULT_MARKER, head, "", outcome.text.trim() || "_The agent finished without a reply._"];
  if (outcome.details) parts.push("", outcome.details);
  parts.push("", `<sub>${meta.join(" · ")}</sub>`);
  return parts.join("\n");
}

/** Edits the progress comment at most every PROGRESS_UPDATE_SECONDS, and only when something changed. */
export class ProgressThrottle {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private inFlight: Promise<void> = Promise.resolve();
  private flushFn: () => Promise<void>;

  constructor(flush: () => Promise<void>) {
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
    this.inFlight = this.inFlight.then(() => this.flushFn()).catch(() => undefined);
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
