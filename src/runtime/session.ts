import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { detectUsageLimit, type DetectedLimit } from "../runner/limits.ts";
import type { EventKind, TaskUsage } from "../types.ts";
import { describeTool, makeRelative, short } from "./describe.ts";
import { saveTotals, savedTotals, toTotals, turnUsage, type SessionTotals } from "./usage.ts";

export type EventSink = (kind: EventKind, message: string) => void;

export interface TurnOutcome {
  /** The agent's final reply. */
  result: string;
  sessionId: string | null;
  /** What this turn cost and the tokens it used (not the session's running totals). */
  costUsd: number | null;
  usage: TaskUsage | null;
  isError: boolean;
  /** Why it failed, for the person reading the GitHub comment. */
  error: string | null;
  cancelled: boolean;
  timedOut: boolean;
  /** The process ended before the turn finished. */
  exited: boolean;
  toolEvents: number;
  limit: DetectedLimit | null;
  /** The model service failed to answer (server error, overload, dropped connection); worth retrying. */
  serverError: string | null;
}

const SERVER_ERROR = /API Error: (5\d\d|529)|overloaded_error|api_error|Internal server error|Service Unavailable|Bad Gateway|Gateway Time-?out|Connection error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|Request timed out|network error|premature close/i;

/** Why a failed turn looks like the model service's fault (and so worth retrying), or null. */
export function serverErrorOf(text: string, apiErrors: string[]): string | null {
  if (apiErrors.includes("server_error") || apiErrors.includes("overloaded")) {
    return text.split("\n").find((line) => SERVER_ERROR.test(line))?.trim().slice(0, 200) || `The model service returned ${apiErrors.find((error) => error === "server_error" || error === "overloaded")}`;
  }
  const line = text.split("\n").find((candidate) => SERVER_ERROR.test(candidate));
  return line ? line.trim().slice(0, 200) : null;
}

/** Messages for the agent, delivered one per task; the SDK reads it as an async iterable. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

interface CurrentTurn {
  onEvent: EventSink;
  toolEvents: number;
  lastText: string;
  apiErrors: string[];
  finish: (outcome: Partial<TurnOutcome>) => void;
}

/**
 * One Claude Code session started through the Agent SDK. It takes a prompt per turn and stays
 * running between turns until closed, so a live session keeps its context and MCP connections.
 */
export class AgentSession {
  private queue = new MessageQueue();
  private q: Query;
  private current: CurrentTurn | null = null;
  private rejectedUntil: number | null = null;
  private done = false;
  /** The session's running totals after the previous turn (from an earlier run, when resumed). */
  private totals: SessionTotals | null;
  private readonly rel: (path: unknown) => string;
  sessionId: string | null;
  readonly resumed: boolean;
  readonly startedAt = Date.now();
  stderrTail: string[] = [];

  constructor(options: Options) {
    this.sessionId = options.resume ?? null;
    this.resumed = Boolean(options.resume);
    this.totals = options.resume ? savedTotals(options.resume) : null;
    this.rel = makeRelative(options.cwd ?? "");
    this.q = query({
      prompt: this.queue,
      options: {
        ...options,
        stderr: (data: string) => {
          for (const line of data.split("\n").filter((item) => item.trim())) {
            this.stderrTail.push(line.slice(0, 500));
            if (this.stderrTail.length > 30) this.stderrTail.shift();
          }
        },
      },
    });
    void this.pump();
  }

  get alive(): boolean {
    return !this.done;
  }

  private async pump(): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of this.q) this.handle(message);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.done = true;
      const turn = this.current;
      if (turn) {
        this.current = null;
        const reason = failure ?? this.stderrTail.at(-1) ?? "The agent process ended unexpectedly";
        turn.finish({ isError: true, exited: true, error: reason, result: turn.lastText });
      }
    }
  }

  private handle(message: SDKMessage): void {
    if ("session_id" in message && message.session_id) this.sessionId = message.session_id;
    const turn = this.current;
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && turn) {
          turn.onEvent("system", `Session started (${message.model})`);
          for (const server of message.mcp_servers) {
            if (server.status === "failed" || server.status === "needs-auth") turn.onEvent("error", `MCP server ${server.name}: ${server.status}`);
          }
        }
        return;
      case "rate_limit_event":
        if (message.rate_limit_info.status === "rejected" && message.rate_limit_info.resetsAt) {
          const at = message.rate_limit_info.resetsAt;
          this.rejectedUntil = at > 1e12 ? at : at * 1000;
        }
        return;
      case "assistant": {
        if (!turn || message.parent_tool_use_id) return;
        if (message.error) turn.apiErrors.push(message.error);
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            turn.lastText = block.text;
            turn.onEvent("text", short(block.text, 300));
          } else if (block.type === "tool_use") {
            turn.toolEvents++;
            turn.onEvent("tool", describeTool(block.name, (block.input ?? {}) as Record<string, any>, this.rel));
          }
        }
        return;
      }
      case "result": {
        if (!turn) return;
        this.current = null;
        const success = message.subtype === "success";
        const text = success ? message.result : turn.lastText;
        const errors = success ? [] : message.errors;
        const error = success
          ? message.is_error
            ? text || "The agent reported an error"
            : null
          : message.subtype === "error_max_turns"
            ? `Stopped after the maximum number of turns (${message.num_turns}).`
            : message.subtype === "error_max_budget_usd"
              ? "Stopped at the spending limit (max_budget_usd)."
              : errors.join("\n") || "The agent stopped with an error.";
        const totals = toTotals(message.total_cost_usd, message.modelUsage);
        const used = turnUsage(this.totals, totals);
        this.totals = totals;
        if (this.sessionId) saveTotals(this.sessionId, totals);
        turn.finish({ result: text, costUsd: used.costUsd, usage: used.usage, isError: !success || message.is_error, error });
        return;
      }
      default:
        return;
    }
  }

  /** Sends one prompt and resolves when Claude finishes that turn. */
  turn(prompt: string, onEvent: EventSink, signal: AbortSignal, timeoutMs: number): Promise<TurnOutcome> {
    if (this.done) {
      return Promise.resolve(this.outcome({ isError: true, exited: true, error: this.stderrTail.at(-1) ?? "The agent session has ended" }, 0, []));
    }
    if (this.current) throw new Error("This session is already working on a task");
    return new Promise((resolve) => {
      let ended: Partial<TurnOutcome> = {};
      const interrupt = () => {
        void this.q.interrupt().catch(() => undefined);
        // If it doesn't stop on its own, end the process.
        setTimeout(() => this.current === turn && this.close(), 15_000).unref();
      };
      const timer = setTimeout(() => {
        ended = { timedOut: true };
        onEvent("error", `Timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
        interrupt();
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        ended = { cancelled: true };
        interrupt();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const turn: CurrentTurn = {
        onEvent,
        toolEvents: 0,
        lastText: "",
        apiErrors: [],
        finish: (outcome) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(this.outcome({ ...outcome, ...ended }, turn.toolEvents, turn.apiErrors));
        },
      };
      this.current = turn;
      this.rejectedUntil = null;
      this.queue.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null } as SDKUserMessage);
      if (signal.aborted) onAbort();
    });
  }

  private outcome(partial: Partial<TurnOutcome>, toolEvents: number, apiErrors: string[]): TurnOutcome {
    const isError = partial.isError ?? false;
    let limit: DetectedLimit | null = null;
    let serverError: string | null = null;
    if (isError && !partial.cancelled && !partial.timedOut) {
      const text = [partial.error ?? "", partial.result ?? "", ...this.stderrTail].join("\n");
      limit = detectUsageLimit(text);
      if (this.rejectedUntil) limit = { resetAt: new Date(this.rejectedUntil), message: limit?.message ?? "Usage limit reached" };
      else if (!limit && apiErrors.includes("rate_limit")) limit = { resetAt: new Date(Date.now() + 5 * 60_000), message: "The model service is rate limiting requests" };
      if (!limit) serverError = serverErrorOf(text, apiErrors);
    }
    return {
      result: partial.result ?? "",
      sessionId: this.sessionId,
      costUsd: partial.costUsd ?? null,
      usage: partial.usage ?? null,
      isError,
      error: partial.error ?? null,
      cancelled: partial.cancelled ?? false,
      timedOut: partial.timedOut ?? false,
      exited: partial.exited ?? false,
      toolEvents,
      limit,
      serverError,
    };
  }

  /** Ends the session: no more turns; the Claude Code process exits. */
  close(): void {
    if (this.done) return;
    this.queue.end();
    try {
      this.q.close();
    } catch {
      // already closed
    }
  }
}
