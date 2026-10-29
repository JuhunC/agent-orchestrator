import { usageRows, type UsageRow } from "../db.ts";

/** Spend and tokens over a set of tasks. */
export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tasks: number;
}

const empty = (): UsageTotals => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tasks: 0 });

function add(total: UsageTotals, row: Pick<UsageRow, "costUsd" | "usage">): void {
  total.costUsd += row.costUsd;
  total.inputTokens += row.usage?.inputTokens ?? 0;
  total.outputTokens += row.usage?.outputTokens ?? 0;
  total.cacheReadTokens += row.usage?.cacheReadTokens ?? 0;
  total.cacheWriteTokens += row.usage?.cacheWriteTokens ?? 0;
  total.tasks += 1;
}

export interface UsageReport {
  days: number;
  /** Start of the first day counted (UTC). */
  since: string;
  totals: UsageTotals;
  /** Per agent, most expensive first. */
  agents: (UsageTotals & { agent: string })[];
  /** One entry per UTC day, oldest first, including days with no spend. */
  daily: { day: string; costUsd: number; tokens: number; byAgent: Record<string, number> }[];
  /** Per model, most expensive first. */
  models: (Omit<UsageTotals, "tasks"> & { model: string })[];
  /** The most expensive tasks. */
  topTasks: (Pick<UsageRow, "id" | "agent" | "owner" | "repo" | "threadKind" | "threadNumber" | "threadTitle" | "status" | "at" | "costUsd"> & { tokens: number })[];
}

const tokensOf = (row: Pick<UsageRow, "usage">) => (row.usage ? row.usage.inputTokens + row.usage.outputTokens + row.usage.cacheReadTokens + row.usage.cacheWriteTokens : 0);

/** Spend and token use over the last `days` days (today included), for one agent or all. */
export function usageReport(days: number, agent?: string): UsageReport {
  const span = Math.max(1, Math.min(366, Math.floor(days)));
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (span - 1));
  const rows = usageRows(start.toISOString(), agent);

  const totals = empty();
  const agents = new Map<string, UsageTotals>();
  const models = new Map<string, Omit<UsageTotals, "tasks">>();
  const daily = new Map<string, UsageReport["daily"][number]>();
  for (let i = 0; i < span; i++) {
    const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    daily.set(day, { day, costUsd: 0, tokens: 0, byAgent: {} });
  }
  for (const row of rows) {
    add(totals, row);
    if (!agents.has(row.agent)) agents.set(row.agent, empty());
    add(agents.get(row.agent)!, row);
    const day = daily.get(row.at.slice(0, 10));
    if (day) {
      day.costUsd += row.costUsd;
      day.tokens += tokensOf(row);
      day.byAgent[row.agent] = (day.byAgent[row.agent] ?? 0) + row.costUsd;
    }
    for (const [model, usage] of Object.entries(row.usage?.models ?? {})) {
      const total = models.get(model) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      total.costUsd += usage.costUsd;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cacheReadTokens += usage.cacheReadTokens;
      total.cacheWriteTokens += usage.cacheWriteTokens;
      models.set(model, total);
    }
  }
  return {
    days: span,
    since: start.toISOString(),
    totals,
    agents: [...agents].map(([name, total]) => ({ agent: name, ...total })).sort((a, b) => b.costUsd - a.costUsd || a.agent.localeCompare(b.agent)),
    daily: [...daily.values()],
    models: [...models].map(([model, total]) => ({ model, ...total })).sort((a, b) => b.costUsd - a.costUsd),
    topTasks: [...rows]
      .sort((a, b) => b.costUsd - a.costUsd || tokensOf(b) - tokensOf(a))
      .slice(0, 10)
      .map(({ usage, ...row }) => ({ ...row, tokens: tokensOf({ usage }) })),
  };
}
