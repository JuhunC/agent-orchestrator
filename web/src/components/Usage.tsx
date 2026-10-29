import { useEffect, useRef, useState } from "react";
import { useApi, type UsageReport, type UsageTotals } from "../api.ts";
import { href } from "../router.ts";
import { Empty, Panel } from "./ui.tsx";

const RANGES = [7, 30, 90];
const RANGE_KEY = "ao.usage.days";

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

const tokens = (totals: Pick<UsageTotals, "inputTokens" | "outputTokens">) => totals.inputTokens + totals.outputTokens;

function readRange(): number {
  try {
    const stored = Number(localStorage.getItem(RANGE_KEY));
    return RANGES.includes(stored) ? stored : 30;
  } catch {
    return 30;
  }
}

/** The usage report for the chosen range, refreshed as tasks finish. */
function useUsage(agent?: string) {
  const [days, setDays] = useState(readRange);
  const query = `/api/usage?days=${days}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`;
  const { data } = useApi<UsageReport>(query, (message) => message.type === "task" && ["succeeded", "failed", "cancelled"].includes(message.task.status));
  const choose = (value: number) => {
    setDays(value);
    try {
      localStorage.setItem(RANGE_KEY, String(value));
    } catch {
      // private window: the choice lasts for this page only
    }
  };
  const picker = (
    <div className="segmented" role="group" aria-label="Time range">
      {RANGES.map((value) => (
        <button key={value} className={`small${value === days ? " active" : ""}`} aria-pressed={value === days} onClick={() => choose(value)}>
          {value}d
        </button>
      ))}
    </div>
  );
  return { data, days, picker };
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A clean axis maximum above `value`: 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((step) => step * power).find((candidate) => candidate >= value)!;
}

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Spend per day as columns; hovering a day shows its numbers. Falls back to tokens when there's no cost. */
function DailyColumns({ daily, byCost }: { daily: UsageReport["daily"]; byCost: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 132;
  const top = 8;
  const bottom = 20;
  const left = 44;
  const value = (day: UsageReport["daily"][number]) => (byCost ? day.costUsd : day.tokens);
  const max = niceMax(Math.max(...daily.map(value)));
  const plot = Math.max(0, width - left);
  const slot = daily.length ? plot / daily.length : 0;
  const bar = Math.max(2, Math.min(24, slot - 2));
  const y = (amount: number) => top + (height - top - bottom) * (1 - amount / max);
  const format = (amount: number) => (byCost ? formatUsd(amount) : formatTokens(Math.round(amount)));
  const shown = hover !== null ? daily[hover]! : null;
  const total = daily.reduce((sum, day) => sum + value(day), 0);
  const peak = daily.reduce((best, day) => (value(day) > value(best) ? day : best), daily[0]!);
  const ticks = [0, Math.floor(daily.length / 2), daily.length - 1].filter((index, position, all) => all.indexOf(index) === position);
  return (
    <div className="usage-chart">
      <div className="usage-readout" aria-live="polite">
        {shown ? (
          <>
            <b>{dayLabel(shown.day)}</b> · {formatUsd(shown.costUsd)} · {formatTokens(shown.tokens)} tokens
          </>
        ) : (
          <>
            {byCost ? "Spend" : "Tokens"} per day · peak {format(value(peak))} on {dayLabel(peak.day)} · total {format(total)}
          </>
        )}
      </div>
      <div ref={ref} className="usage-plot" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${byCost ? "Spend" : "Tokens"} per day over ${daily.length} days`}>
            {[0, max].map((tick) => (
              <g key={tick}>
                <line x1={left} x2={width} y1={y(tick)} y2={y(tick)} className="usage-grid" />
                <text x={left - 6} y={y(tick) + 4} textAnchor="end" className="usage-axis">
                  {format(tick)}
                </text>
              </g>
            ))}
            {daily.map((day, index) => {
              const amount = value(day);
              const x = left + index * slot + (slot - bar) / 2;
              const barTop = y(amount);
              const h = Math.max(0, y(0) - barTop);
              const r = Math.min(4, bar / 2, h);
              return (
                <g key={day.day} onMouseEnter={() => setHover(index)}>
                  <rect x={left + index * slot} y={top} width={slot} height={height - top - bottom} fill="transparent" />
                  {h > 0 && (
                    <path
                      className={`usage-bar${hover === index ? " hover" : ""}`}
                      d={`M${x},${y(0)} V${barTop + r} Q${x},${barTop} ${x + r},${barTop} H${x + bar - r} Q${x + bar},${barTop} ${x + bar},${barTop + r} V${y(0)} Z`}
                    />
                  )}
                </g>
              );
            })}
            {ticks.map((index) => (
              <text key={index} x={left + index * slot + slot / 2} y={height - 4} textAnchor={index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"} className="usage-axis">
                {dayLabel(daily[index]!.day)}
              </text>
            ))}
          </svg>
        )}
      </div>
      <details className="usage-table">
        <summary>Daily numbers</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Spend</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {[...daily].reverse().filter((day) => day.costUsd || day.tokens).map((day) => (
                <tr key={day.day}>
                  <td>{dayLabel(day.day)}</td>
                  <td className="num">{formatUsd(day.costUsd)}</td>
                  <td className="num">{formatTokens(day.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Tiles({ totals }: { totals: UsageTotals }) {
  return (
    <div className="stats">
      <div className="panel stat">
        <div className="label">Spend (estimated)</div>
        <div className="value">{formatUsd(totals.costUsd)}</div>
        <div className="meta">{totals.tasks ? `${formatUsd(totals.costUsd / totals.tasks)} per task` : "no tasks"}</div>
      </div>
      <div className="panel stat">
        <div className="label">Tokens</div>
        <div className="value">{formatTokens(tokens(totals))}</div>
        <div className="meta">
          {formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out
        </div>
      </div>
      <div className="panel stat">
        <div className="label">Cache</div>
        <div className="value">{formatTokens(totals.cacheReadTokens)}</div>
        <div className="meta">read · {formatTokens(totals.cacheWriteTokens)} written</div>
      </div>
      <div className="panel stat">
        <div className="label">Tasks</div>
        <div className="value">{totals.tasks}</div>
        <div className="meta">with recorded usage</div>
      </div>
    </div>
  );
}

const NOTE = "Claude Code's estimates at list prices; with your own model service they may not match its bill.";

/** Dashboard: spend across all agents, and per agent. */
export function UsageSummary() {
  const { data, days, picker } = useUsage();
  const byCost = Boolean(data && data.totals.costUsd > 0);
  const top = data ? Math.max(...data.agents.map((agent) => (byCost ? agent.costUsd : tokens(agent))), 0) : 0;
  return (
    <Panel title="Token usage" hint={`last ${days} days`} actions={picker}>
      {!data ? (
        <Empty>Loading…</Empty>
      ) : data.totals.tasks === 0 ? (
        <Empty>No usage recorded in the last {days} days.</Empty>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <Tiles totals={data.totals} />
          <DailyColumns daily={data.daily} byCost={byCost} />
          <div className="usage-agents">
            {data.agents.map((agent) => {
              const amount = byCost ? agent.costUsd : tokens(agent);
              return (
                <div key={agent.agent} className="usage-agent">
                  <a href={href(`/agents/${agent.agent}`)} className="usage-name">
                    {agent.agent}
                  </a>
                  <div className="usage-track" title={`${agent.agent}: ${formatUsd(agent.costUsd)}, ${formatTokens(tokens(agent))} tokens, ${agent.tasks} tasks`}>
                    <div className="usage-fill" style={{ width: `${top ? Math.max(1, (amount / top) * 100) : 0}%` }} />
                  </div>
                  <span className="usage-value">
                    <b>{byCost ? formatUsd(agent.costUsd) : formatTokens(tokens(agent))}</b>
                    <span className="meta">
                      {" "}
                      · {byCost ? `${formatTokens(tokens(agent))} tokens` : formatUsd(agent.costUsd)} · {agent.tasks} task{agent.tasks === 1 ? "" : "s"}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="meta" style={{ margin: 0 }}>
            {NOTE}
          </p>
        </div>
      )}
    </Panel>
  );
}

/** Agent page: this agent's spend, by day and model, and its most expensive tasks. */
export function AgentUsage({ agent }: { agent: string }) {
  const { data, days, picker } = useUsage(agent);
  const byCost = Boolean(data && data.totals.costUsd > 0);
  return (
    <Panel title="Token usage" hint={`last ${days} days`} actions={picker}>
      {!data ? (
        <Empty>Loading…</Empty>
      ) : data.totals.tasks === 0 ? (
        <Empty>
          No usage recorded for {agent} in the last {days} days.
        </Empty>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <Tiles totals={data.totals} />
          <DailyColumns daily={data.daily} byCost={byCost} />
          <div className="grid-2">
            <div>
              <h3 style={{ marginBottom: 8 }}>By model</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Spend</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Cache read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.map((model) => (
                      <tr key={model.model}>
                        <td className="mono">{model.model}</td>
                        <td className="num">{formatUsd(model.costUsd)}</td>
                        <td className="num">{formatTokens(model.inputTokens)}</td>
                        <td className="num">{formatTokens(model.outputTokens)}</td>
                        <td className="num">{formatTokens(model.cacheReadTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 style={{ marginBottom: 8 }}>Most expensive tasks</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Spend</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topTasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <a href={href(`/tasks/${task.id}`)} className="ellipsis" style={{ display: "block", maxWidth: 260 }}>
                            #{task.id} {task.threadTitle || `${task.owner}/${task.repo}#${task.threadNumber}`}
                          </a>
                          <div className="meta">
                            {task.owner}/{task.repo}#{task.threadNumber} · {task.status}
                          </div>
                        </td>
                        <td className="num">{formatUsd(task.costUsd)}</td>
                        <td className="num">{formatTokens(task.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <p className="meta" style={{ margin: 0 }}>
            {NOTE}
          </p>
        </div>
      )}
    </Panel>
  );
}
