import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { getSetting, setSetting } from "../db.ts";
import type { ModelTokens, TaskUsage } from "../types.ts";

/**
 * Claude Code reports cost and tokens as running totals for the whole session (every turn of a
 * live session, and earlier runs of a resumed one). These helpers turn them into what each task
 * used, so per-task numbers add up instead of counting earlier tasks again.
 */
export interface SessionTotals {
  costUsd: number;
  models: Record<string, ModelTokens>;
}

const ZERO: ModelTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

export function toTotals(costUsd: number | undefined, modelUsage: Record<string, ModelUsage> | undefined): SessionTotals {
  const models: Record<string, ModelTokens> = {};
  for (const [model, usage] of Object.entries(modelUsage ?? {})) {
    models[model] = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
      costUsd: usage.costUSD ?? 0,
    };
  }
  return { costUsd: costUsd ?? 0, models };
}

const tokens = (usage: ModelTokens) => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

function sum(models: Record<string, ModelTokens>): TaskUsage {
  const total: TaskUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models };
  for (const usage of Object.values(models)) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
  }
  return total;
}

/**
 * What one turn used: the current totals minus the previous ones. When the totals went down, the
 * session started counting again (a resumed session whose transcript had no totals), so all of it is new.
 */
export function turnUsage(previous: SessionTotals | null, current: SessionTotals): { costUsd: number; usage: TaskUsage } {
  const restarted =
    !previous ||
    current.costUsd + 1e-9 < previous.costUsd ||
    Object.entries(previous.models).some(([model, usage]) => tokens(current.models[model] ?? ZERO) < tokens(usage));
  if (restarted) return { costUsd: current.costUsd, usage: sum(current.models) };
  const models: Record<string, ModelTokens> = {};
  for (const [model, usage] of Object.entries(current.models)) {
    const before = previous.models[model] ?? ZERO;
    const delta: ModelTokens = {
      inputTokens: usage.inputTokens - before.inputTokens,
      outputTokens: usage.outputTokens - before.outputTokens,
      cacheReadTokens: usage.cacheReadTokens - before.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens - before.cacheWriteTokens,
      costUsd: Math.max(0, usage.costUsd - before.costUsd),
    };
    if (tokens(delta) > 0 || delta.costUsd > 0) models[model] = delta;
  }
  return { costUsd: Math.max(0, current.costUsd - previous.costUsd), usage: sum(models) };
}

/** Two tasks' (or attempts') usage together. */
export function addUsage(a: TaskUsage | null, b: TaskUsage | null): TaskUsage | null {
  if (!a || !b) return a ?? b;
  const models: Record<string, ModelTokens> = { ...a.models };
  for (const [model, usage] of Object.entries(b.models)) {
    const before = models[model] ?? ZERO;
    models[model] = {
      inputTokens: before.inputTokens + usage.inputTokens,
      outputTokens: before.outputTokens + usage.outputTokens,
      cacheReadTokens: before.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: before.cacheWriteTokens + usage.cacheWriteTokens,
      costUsd: before.costUsd + usage.costUsd,
    };
  }
  return sum(models);
}

/** A session's totals after its last turn, so a later resume only counts what's new. */
export function savedTotals(sessionId: string): SessionTotals | null {
  try {
    return JSON.parse(getSetting(`session_totals:${sessionId}`) ?? "null") as SessionTotals | null;
  } catch {
    return null;
  }
}

export function saveTotals(sessionId: string, totals: SessionTotals): void {
  setSetting(`session_totals:${sessionId}`, JSON.stringify(totals));
}
