import { useEffect, useRef, useState } from "react";
import { Code, Collapsible, Grid, Heading, HStack, ProgressBar, SegmentedControl, SegmentedControlItem, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, VStack } from "@astryxdesign/core";
import { useApi, type AgentOutcome, type OutcomeReport, type UsageReport, type UsageTotals } from "../api.ts";
import { A, Columns, DataTable, Empty, Meta, Panel, StatGrid, StatTile, Tag } from "./ui.tsx";

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
    <SegmentedControl label="Time range" size="sm" value={String(days)} onChange={(value) => choose(Number(value))}>
      {RANGES.map((value) => (
        <SegmentedControlItem key={value} value={String(value)} label={`${value}d`} />
      ))}
    </SegmentedControl>
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
    <VStack gap={2}>
      <span aria-live="polite">
        <Text type="supporting">
          {shown ? (
            <>
              <b>{dayLabel(shown.day)}</b> · {formatUsd(shown.costUsd)} · {formatTokens(shown.tokens)} tokens
            </>
          ) : (
            <>
              {byCost ? "Spend" : "Tokens"} per day · peak {format(value(peak))} on {dayLabel(peak.day)} · total {format(total)}
            </>
          )}
        </Text>
      </span>
      <div ref={ref} className="ao-usage-plot" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${byCost ? "Spend" : "Tokens"} per day over ${daily.length} days`}>
            {[0, max].map((tick) => (
              <g key={tick}>
                <line x1={left} x2={width} y1={y(tick)} y2={y(tick)} className="ao-usage-grid" />
                <text x={left - 6} y={y(tick) + 4} textAnchor="end" className="ao-usage-axis">
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
                      className={`ao-usage-bar${hover === index ? " hover" : ""}`}
                      d={`M${x},${y(0)} V${barTop + r} Q${x},${barTop} ${x + r},${barTop} H${x + bar - r} Q${x + bar},${barTop} ${x + bar},${barTop + r} V${y(0)} Z`}
                    />
                  )}
                </g>
              );
            })}
            {ticks.map((index) => (
              <text key={index} x={left + index * slot + slot / 2} y={height - 4} textAnchor={index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"} className="ao-usage-axis">
                {dayLabel(daily[index]!.day)}
              </text>
            ))}
          </svg>
        )}
      </div>
      <Collapsible trigger={<Meta>Daily numbers</Meta>} defaultIsOpen={false}>
        <DataTable>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Day</TableHeaderCell>
              <TableHeaderCell>Spend</TableHeaderCell>
              <TableHeaderCell>Tokens</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...daily]
              .reverse()
              .filter((day) => day.costUsd || day.tokens)
              .map((day) => (
                <TableRow key={day.day}>
                  <TableCell>{dayLabel(day.day)}</TableCell>
                  <TableCell>
                    <Num>{formatUsd(day.costUsd)}</Num>
                  </TableCell>
                  <TableCell>
                    <Num>{formatTokens(day.tokens)}</Num>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </DataTable>
      </Collapsible>
    </VStack>
  );
}

/** A number in a table column: tabular figures, on one line. */
function Num({ children }: { children: React.ReactNode }) {
  return (
    <Text hasTabularNumbers textWrap="nowrap">
      {children}
    </Text>
  );
}

/** "62% (5/8)": a rate with the counts behind it. */
function Rate({ rate, done, of }: { rate: number | null; done: number; of: number }) {
  return (
    <Num>
      {percent(rate)}{" "}
      <Meta>
        ({done}/{of})
      </Meta>
    </Num>
  );
}

function Tiles({ totals }: { totals: UsageTotals }) {
  return (
    <StatGrid>
      <StatTile label="Spend (estimated)" value={formatUsd(totals.costUsd)} sub={totals.tasks ? `${formatUsd(totals.costUsd / totals.tasks)} per task` : "no tasks"} />
      <StatTile label="Tokens" value={formatTokens(tokens(totals))} sub={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`} />
      <StatTile label="Cache" value={formatTokens(totals.cacheReadTokens)} sub={`read · ${formatTokens(totals.cacheWriteTokens)} written`} />
      <StatTile label="Tasks" value={totals.tasks} sub="with recorded usage" />
    </StatGrid>
  );
}

const NOTE = "Claude Code's estimates at list prices; with your own model service they may not match its bill.";

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

function useOutcomes(days: number, agent?: string) {
  return useApi<OutcomeReport>(`/api/outcomes?days=${days}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`, (message) => message.type === "task" || message.type === "settings").data;
}

/** What each agent's work came to: did its tasks succeed, were its pull requests merged. */
function OutcomeTable({ rows }: { rows: AgentOutcome[] }) {
  return (
    <DataTable>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Agent</TableHeaderCell>
          <TableHeaderCell>
            <span title="succeeded / (succeeded + failed)">Tasks OK</span>
          </TableHeaderCell>
          <TableHeaderCell>
            <span title="merged / (merged + closed without merging)">PRs merged</span>
          </TableHeaderCell>
          <TableHeaderCell>Open PRs</TableHeaderCell>
          <TableHeaderCell>
            <span title="cards the agent moved to the board's needs-human column">To a person</span>
          </TableHeaderCell>
          <TableHeaderCell>
            <span title="spend in this period / pull requests merged">Per merged PR</span>
          </TableHeaderCell>
          <TableHeaderCell>Avg task</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.agent}>
            <TableCell>
              <A to={`/agents/${row.agent}`}>{row.agent}</A>
            </TableCell>
            <TableCell>
              <span title={`${row.tasks.succeeded} succeeded, ${row.tasks.failed} failed, ${row.tasks.cancelled} cancelled`}>
                <Rate rate={row.successRate} done={row.tasks.succeeded} of={row.tasks.succeeded + row.tasks.failed} />
              </span>
            </TableCell>
            <TableCell>
              <span title={`${row.pulls.merged} merged, ${row.pulls.closed} closed without merging`}>
                <Rate rate={row.mergeRate} done={row.pulls.merged} of={row.pulls.merged + row.pulls.closed} />
              </span>
            </TableCell>
            <TableCell>
              <Num>{row.pulls.open}</Num>
            </TableCell>
            <TableCell>
              <Num>{row.needsHuman}</Num>
            </TableCell>
            <TableCell>
              <Num>{row.costPerMergedPull === null ? "—" : formatUsd(row.costPerMergedPull)}</Num>
            </TableCell>
            <TableCell>
              <Num>{row.avgTaskMinutes === null ? "—" : `${row.avgTaskMinutes.toFixed(1)} min`}</Num>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  );
}

/** Dashboard: outcomes per agent, over the same period as the usage above. */
function OutcomeSummary({ days }: { days: number }) {
  const data = useOutcomes(days);
  if (!data?.agents.length) return null;
  return (
    <VStack gap={2}>
      <Heading level={3}>Outcomes</Heading>
      <OutcomeTable rows={data.agents} />
      <Meta block>
        Pull requests count once merged or closed; tasks once they succeed or fail. A low merge rate, many failed tasks or many cards sent to a person say an agent's role or tools need work.
      </Meta>
    </VStack>
  );
}

/** Agent page: outcomes per version of its profile, to see whether a change helped. */
function VersionTable({ versions }: { versions: NonNullable<OutcomeReport["versions"]> }) {
  if (versions.length < 1) return null;
  return (
    <VStack gap={2}>
      <Heading level={3}>By profile version</Heading>
      <DataTable>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Version</TableHeaderCell>
            <TableHeaderCell>Used</TableHeaderCell>
            <TableHeaderCell>Tasks OK</TableHeaderCell>
            <TableHeaderCell>PRs merged</TableHeaderCell>
            <TableHeaderCell>Per merged PR</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((row, index) => (
            <TableRow key={row.version}>
              <TableCell>
                <HStack gap={1.5} vAlign="center" wrap="wrap">
                  <Code size="inherit">{row.version}</Code>
                  {row.commit && <Meta>· commit {row.commit}</Meta>}
                  {index === 0 && <Tag accent>latest</Tag>}
                </HStack>
              </TableCell>
              <TableCell>
                <Text type="supporting" textWrap="nowrap">
                  {new Date(row.firstUsed).toLocaleDateString()} – {new Date(row.lastUsed).toLocaleDateString()}
                </Text>
              </TableCell>
              <TableCell>
                <Rate rate={row.successRate} done={row.tasks.succeeded} of={row.tasks.succeeded + row.tasks.failed} />
              </TableCell>
              <TableCell>
                <Rate rate={row.mergeRate} done={row.pulls.merged} of={row.pulls.merged + row.pulls.closed} />
              </TableCell>
              <TableCell>
                <Num>{row.costPerMergedPull === null ? "—" : formatUsd(row.costPerMergedPull)}</Num>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      <Meta block>
        A new version starts whenever the agent's prompt, model, tools, skills, subagents or permissions change. Compare a version with the one before to see whether the change helped.
      </Meta>
    </VStack>
  );
}

/** Agent page: its outcome numbers as tiles. */
function OutcomeTiles({ days, agent }: { days: number; agent: string }) {
  const report = useOutcomes(days, agent);
  const row = report?.agents[0];
  if (!row) return null;
  return (
    <>
      <StatGrid>
        <StatTile label="Tasks that succeeded" value={percent(row.successRate)} sub={`${row.tasks.succeeded} ok · ${row.tasks.failed} failed · ${row.tasks.cancelled} cancelled`} />
        <StatTile label="Pull requests merged" value={percent(row.mergeRate)} sub={`${row.pulls.merged} merged · ${row.pulls.closed} closed · ${row.pulls.open} open`} />
        <StatTile label="Per merged PR" value={row.costPerMergedPull === null ? "—" : formatUsd(row.costPerMergedPull)} sub="spend ÷ merged pull requests" />
        <StatTile label="Sent to a person" value={row.needsHuman} sub="cards moved to needs-human" />
      </StatGrid>
      {report?.versions && report.versions.length > 0 && <VersionTable versions={report.versions} />}
    </>
  );
}

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
        <VStack gap={4}>
          <Tiles totals={data.totals} />
          <DailyColumns daily={data.daily} byCost={byCost} />
          <Grid columns={{ minWidth: 300 }} gap={3}>
            {data.agents.map((agent) => {
              const amount = byCost ? agent.costUsd : tokens(agent);
              return (
                <VStack key={agent.agent} gap={1}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text weight="medium">
                      <A to={`/agents/${agent.agent}`}>{agent.agent}</A>
                    </Text>
                    <Text weight="semibold" hasTabularNumbers>
                      {byCost ? formatUsd(agent.costUsd) : formatTokens(tokens(agent))}
                    </Text>
                    <Meta>
                      {byCost ? `${formatTokens(tokens(agent))} tokens` : formatUsd(agent.costUsd)} · {agent.tasks} task{agent.tasks === 1 ? "" : "s"}
                    </Meta>
                  </HStack>
                  <span title={`${agent.agent}: ${formatUsd(agent.costUsd)}, ${formatTokens(tokens(agent))} tokens, ${agent.tasks} tasks`}>
                    <ProgressBar label={`${agent.agent}'s share of the top agent's ${byCost ? "spend" : "tokens"}`} isLabelHidden value={top ? Math.max(1, (amount / top) * 100) : 0} />
                  </span>
                </VStack>
              );
            })}
          </Grid>
          <OutcomeSummary days={days} />
          <Meta block>{NOTE}</Meta>
        </VStack>
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
        <VStack gap={4}>
          <Tiles totals={data.totals} />
          <OutcomeTiles days={days} agent={agent} />
          <DailyColumns daily={data.daily} byCost={byCost} />
          <Columns min={360}>
            <VStack gap={2}>
              <Heading level={3}>By model</Heading>
              <DataTable>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Model</TableHeaderCell>
                    <TableHeaderCell>Spend</TableHeaderCell>
                    <TableHeaderCell>In</TableHeaderCell>
                    <TableHeaderCell>Out</TableHeaderCell>
                    <TableHeaderCell>Cache read</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.models.map((model) => (
                    <TableRow key={model.model}>
                      <TableCell>
                        <Code size="inherit">{model.model}</Code>
                      </TableCell>
                      <TableCell>
                        <Num>{formatUsd(model.costUsd)}</Num>
                      </TableCell>
                      <TableCell>
                        <Num>{formatTokens(model.inputTokens)}</Num>
                      </TableCell>
                      <TableCell>
                        <Num>{formatTokens(model.outputTokens)}</Num>
                      </TableCell>
                      <TableCell>
                        <Num>{formatTokens(model.cacheReadTokens)}</Num>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </VStack>
            <VStack gap={2}>
              <Heading level={3}>Most expensive tasks</Heading>
              <DataTable>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Task</TableHeaderCell>
                    <TableHeaderCell>Spend</TableHeaderCell>
                    <TableHeaderCell>Tokens</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topTasks.map((task) => (
                    <TableRow key={task.id}>
                      <TableCell>
                        <VStack gap={0.5}>
                          <Text maxLines={1}>
                            <A to={`/tasks/${task.id}`}>
                              #{task.id} {task.threadTitle || `${task.owner}/${task.repo}#${task.threadNumber}`}
                            </A>
                          </Text>
                          <Meta>
                            {task.owner}/{task.repo}#{task.threadNumber} · {task.status}
                          </Meta>
                        </VStack>
                      </TableCell>
                      <TableCell>
                        <Num>{formatUsd(task.costUsd)}</Num>
                      </TableCell>
                      <TableCell>
                        <Num>{formatTokens(task.tokens)}</Num>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </VStack>
          </Columns>
          <Meta block>{NOTE}</Meta>
        </VStack>
      )}
    </Panel>
  );
}
