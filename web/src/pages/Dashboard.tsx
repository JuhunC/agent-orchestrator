import { useEffect, useState } from "react";
import { Button, Card, Divider, Grid, HStack, StackItem, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, VStack } from "@astryxdesign/core";
import { ago, api, duration, useApi, useNow, useStream, type Agent, type Overview, type Task, type TaskEvent } from "../api.ts";
import { RunAgentDialog } from "../components/RunAgentDialog.tsx";
import { A, DataTable, Empty, LinkButton, Meta, Notice, Panel, Pill, StatGrid, StatTile, StatusPill, StepText, Switch, ThreadCell, who, Columns } from "../components/ui.tsx";
import { navigate } from "../router.ts";
import { UsageSummary } from "../components/Usage.tsx";

function AgentCard({ agent, running, onRun, onToggle }: { agent: Agent; running: number; onRun: () => void; onToggle: (enabled: boolean) => void }) {
  const stats = agent.stats;
  let state = <Pill tone="cancelled">Idle</Pill>;
  if (!agent.enabled) state = <Pill tone="off">Off</Pill>;
  else if (agent.errors.length) state = <Pill tone="failed">Profile has problems</Pill>;
  else if (running) state = <Pill tone="running">Working on {running}</Pill>;
  else if (stats?.queued) state = <Pill tone="queued">{stats.queued} queued</Pill>;
  const config = [agent.model ?? "default model", agent.effort ? `effort ${agent.effort}` : null, `${agent.skills.length + agent.ownSkills.length} skills`, `${agent.mcp.length + agent.ownMcp.length + 1} MCP`, agent.live ? "live" : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card variant={agent.enabled ? "default" : "muted"}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="start">
          <StackItem size="fill">
            <VStack gap={0.5}>
              <Text weight="semibold" maxLines={1}>
                <A to={`/agents/${agent.name}`}>{agent.name}</A>
              </Text>
              <Meta>@{agent.handle}</Meta>
            </VStack>
          </StackItem>
          <Switch checked={agent.enabled} onChange={onToggle} label={`Turn ${agent.name} ${agent.enabled ? "off" : "on"}`} />
        </HStack>
        <HStack>{state}</HStack>
        <span title={agent.description}>
          <Text type="supporting" maxLines={1} display="block">
            {config}
          </Text>
        </span>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Meta>
              <b>{stats?.succeeded ?? 0}</b> done · <b>{stats?.failed ?? 0}</b> failed
            </Meta>
          </StackItem>
          <Button label="Run…" size="sm" isDisabled={!agent.enabled} onClick={onRun} />
        </HStack>
      </VStack>
    </Card>
  );
}

function RunningTask({ task, events, now }: { task: Task; events: TaskEvent[]; now: number }) {
  const steps = events.filter((event) => event.kind !== "stderr" && event.kind !== "text").slice(-6);
  const lastText = [...events].reverse().find((event) => event.kind === "text");
  const cancel = () => {
    if (confirm(`Stop ${task.agent} on ${task.owner}/${task.repo}#${task.threadNumber}?`)) void api.post(`/api/tasks/${task.id}/cancel`);
  };
  return (
    <VStack gap={2} padding={4}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <StatusPill status={task.status} />
        <Text weight="semibold">{task.agent}</Text>
        <Meta>for {who(task.requestedBy)}</Meta>
        <StackItem size="fill">
          <span />
        </StackItem>
        <Text type="supporting" hasTabularNumbers>
          {duration(task.startedAt, null, now)}
        </Text>
        <LinkButton to={`/tasks/${task.id}`} label="Open log" size="sm" />
        <Button label="Stop" size="sm" variant="destructive" onClick={cancel} />
      </HStack>
      <ThreadCell task={task} />
      <ul className="ao-steps">
        {steps.length === 0 && <li>Starting…</li>}
        {steps.map((event) => (
          <li key={event.id}>
            <span className="ao-steps-time">{event.ts.slice(11, 19)}</span>
            <span>
              <StepText text={event.message} />
            </span>
          </li>
        ))}
      </ul>
      {lastText && (
        <Text type="supporting" maxLines={1} display="block">
          💬 {lastText.message}
        </Text>
      )}
    </VStack>
  );
}

export function Dashboard() {
  const { data, reload, error } = useApi<Overview>("/api/overview", (message) => message.type !== "event" && message.type !== "delivery");
  const [events, setEvents] = useState<Record<number, TaskEvent[]>>({});
  const [runFor, setRunFor] = useState<string | null>(null);
  const now = useNow();

  // Load recent events for tasks that are already running when the page opens.
  const runningIds = data?.running.map((task) => task.id).join(",") ?? "";
  useEffect(() => {
    for (const id of runningIds.split(",").filter(Boolean).map(Number)) {
      if (events[id]) continue;
      api.get<{ events: TaskEvent[] }>(`/api/tasks/${id}`).then(({ events: loaded }) => setEvents((current) => ({ ...current, [id]: loaded.slice(-40) })));
    }
  }, [runningIds]);

  useStream((message) => {
    if (message.type !== "event") return;
    setEvents((current) => ({ ...current, [message.event.taskId]: [...(current[message.event.taskId] ?? []), message.event].slice(-40) }));
  });

  if (error) return <Notice tone="error" title={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  const totals = data.agents.reduce(
    (sum, agent) => ({ succeeded: sum.succeeded + (agent.stats?.succeeded ?? 0), failed: sum.failed + (agent.stats?.failed ?? 0) }),
    { succeeded: 0, failed: 0 },
  );
  const runningByAgent = (name: string) => data.running.filter((task) => task.agent === name).length;
  const toggle = async (agent: Agent, enabled: boolean) => {
    await api.post(`/api/agents/${encodeURIComponent(agent.name)}/enabled`, { enabled });
    void reload();
  };

  return (
    <VStack gap={4}>
      {!data.configured && (
        <Notice tone="info" title="Connect a GitHub App to start." action={<LinkButton to="/settings" label="Set up GitHub App" variant="primary" />}>
          Agents run when they're mentioned on GitHub, which needs the app installed on your repositories.
        </Notice>
      )}
      {data.settings.paused && <Notice title="The queue is paused.">Running agents finish, but nothing new starts.</Notice>}

      {data.settings.spendBlocked ? (
        <Notice tone="error" title="Spending limit reached." action={<LinkButton to="/settings" label="Limits" />}>
          {data.settings.spendBlocked}
        </Notice>
      ) : data.settings.spend.warning ? (
        <Notice title="Near the spending limit.">{data.settings.spend.warning}</Notice>
      ) : null}

      {data.model.limit && (
        <Notice title={`Usage limit reached (${data.model.limit.reason}).`} action={<Button label="Try now" onClick={() => void api.del("/api/limit")} />}>
          Agents continue automatically at {new Date(data.model.limit.until).toLocaleTimeString()}.
        </Notice>
      )}

      <StatGrid>
        <StatTile label="Working now" value={<>{data.running.length} <Meta>/ {data.settings.maxConcurrent}</Meta></>} />
        <StatTile label="Queued" value={data.queued.length} />
        <StatTile label="Finished" value={totals.succeeded} />
        <StatTile label="Failed" value={totals.failed} />
      </StatGrid>

      {data.incidents.length > 0 && (
        <Panel title="Recent problems" hint="last 7 days · set ALERT_WEBHOOK_URL to get them in chat" tight>
          <DataTable>
            <TableBody>
              {data.incidents.slice(0, 8).map((incident) => (
                <TableRow key={incident.id}>
                  <TableCell>
                    <Pill tone={incident.severity === "critical" ? "failed" : incident.severity === "warning" ? "queued" : "cancelled"}>{incident.severity}</Pill>
                  </TableCell>
                  <TableCell>
                    {incident.message}{" "}
                    {incident.taskId ? <A to={`/tasks/${incident.taskId}`}>task #{incident.taskId}</A> : incident.url ? <A to={incident.url} external>on GitHub</A> : null}
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" textWrap="nowrap">
                      {new Date(incident.ts).toLocaleString()}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        </Panel>
      )}

      <Panel title="Agents" hint={`${data.agents.filter((agent) => agent.enabled).length} of ${data.agents.length} on`} actions={<LinkButton to="/agents" label="Manage" size="sm" />}>
        {data.agents.length === 0 ? (
          <Empty>
            No agents yet. Add one on the <A to="/agents">Agents</A> page or in agents.yaml.
          </Empty>
        ) : (
          <Grid columns={{ minWidth: 230 }} gap={3}>
            {data.agents.map((agent) => (
              <AgentCard key={agent.name} agent={agent} running={runningByAgent(agent.name)} onRun={() => setRunFor(agent.name)} onToggle={(value) => void toggle(agent, value)} />
            ))}
          </Grid>
        )}
      </Panel>

      <UsageSummary />

      <Columns>
        <Panel title="Working now" hint={data.running.length ? "live" : undefined} tight>
          {data.running.length === 0 ? (
            <Empty>No agents are running. Mention one on GitHub, or use “Run…”.</Empty>
          ) : (
            <VStack gap={0}>
              {data.running.map((task, index) => (
                <VStack key={task.id} gap={0}>
                  {index > 0 && <Divider />}
                  <RunningTask task={task} events={events[task.id] ?? []} now={now} />
                </VStack>
              ))}
            </VStack>
          )}
        </Panel>

        <Panel title="Queue" hint={data.queued.length ? `${data.queued.length} waiting` : undefined} tight>
          {data.queued.length === 0 ? (
            <Empty>Nothing waiting.</Empty>
          ) : (
            <DataTable hover>
              <TableBody>
                {data.queued.map((task) => (
                  <TableRow key={task.id} className="ao-clickable" onClick={() => navigate(`/tasks/${task.id}`)}>
                    <TableCell>
                      <VStack gap={0.5}>
                        <Text weight="semibold">{task.agent}</Text>
                        <Meta>{ago(task.createdAt, now)}</Meta>
                      </VStack>
                    </TableCell>
                    <TableCell>
                      <ThreadCell task={task} />
                    </TableCell>
                    <TableCell>
                      <Button
                        label="Remove"
                        size="sm"
                        variant="destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          void api.post(`/api/tasks/${task.id}/cancel`);
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          )}
        </Panel>
      </Columns>

      <Panel title="Agent sessions" hint={data.sessions.length ? `${data.sessions.length} open · kept ${data.settings.liveIdleMinutes} min after the last task` : undefined} tight>
        {data.sessions.length === 0 ? (
          <Empty>No open sessions. Live agents keep their Claude session open between tasks on the same thread.</Empty>
        ) : (
          <DataTable>
            <TableBody>
              {data.sessions.map((session) => (
                <TableRow key={session.key}>
                  <TableCell>
                    <VStack gap={0.5}>
                      <Text weight="semibold">{session.agent}</Text>
                      {session.busy ? (
                        <HStack>
                          <Pill tone="running">working</Pill>
                        </HStack>
                      ) : (
                        <Meta>idle, closes at {new Date(session.closesAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Meta>
                      )}
                    </VStack>
                  </TableCell>
                  <TableCell>
                    <VStack gap={0.5}>
                      <A to={`/history/${session.owner}/${session.repo}/${session.threadKind}/${session.threadNumber}`}>
                        {session.owner}/{session.repo}#{session.threadNumber}
                      </A>
                      <Text type="code" color="secondary">
                        {session.sessionId?.slice(0, 8) ?? "starting"}
                      </Text>
                    </VStack>
                  </TableCell>
                  <TableCell>
                    <Meta>
                      {session.turns} task{session.turns === 1 ? "" : "s"}
                    </Meta>
                  </TableCell>
                  <TableCell>
                    <Button label="Close" size="sm" isDisabled={session.busy} onClick={() => void api.del(`/api/sessions/${encodeURIComponent(session.key)}`)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>

      <Panel title="Recently finished" tight actions={<LinkButton to="/tasks" label="All tasks" size="sm" />}>
        {data.recent.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableHeaderCell>Thread</TableHeaderCell>
                <TableHeaderCell>Result</TableHeaderCell>
                <TableHeaderCell>Took</TableHeaderCell>
                <TableHeaderCell>Finished</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recent.map((task) => (
                <TableRow key={task.id} className="ao-clickable" onClick={() => navigate(`/tasks/${task.id}`)}>
                  <TableCell>
                    <StatusPill status={task.status} />
                  </TableCell>
                  <TableCell>
                    <Text textWrap="nowrap">{task.agent}</Text>
                  </TableCell>
                  <TableCell>
                    <ThreadCell task={task} />
                  </TableCell>
                  <TableCell>
                    {task.prUrl ? (
                      <A to={task.prUrl} external>
                        PR #{task.prNumber}
                      </A>
                    ) : (
                      <VStack maxWidth={320}>
                        <Text type="supporting" maxLines={1} display="block">
                          {task.error ?? task.resultText?.slice(0, 120) ?? "—"}
                        </Text>
                      </VStack>
                    )}
                  </TableCell>
                  <TableCell>
                    <Text hasTabularNumbers textWrap="nowrap">
                      {duration(task.startedAt, task.finishedAt)}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" textWrap="nowrap">
                      {ago(task.finishedAt, now)}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>

      {runFor !== null && <RunAgentDialog agents={data.agents} initialAgent={runFor} onClose={() => setRunFor(null)} />}
    </VStack>
  );
}
