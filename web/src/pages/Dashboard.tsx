import { useEffect, useState } from "react";
import { ago, api, duration, useApi, useNow, useStream, type Agent, type Overview, type Task, type TaskEvent } from "../api.ts";
import { RunAgentDialog } from "../components/RunAgentDialog.tsx";
import { Empty, Panel, Pill, StatusPill, StepText, Switch, ThreadCell, who } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";
import { UsageSummary } from "../components/Usage.tsx";

function AgentCard({ agent, running, onRun, onToggle }: { agent: Agent; running: number; onRun: () => void; onToggle: (enabled: boolean) => void }) {
  const stats = agent.stats;
  let state = <Pill tone="cancelled">Idle</Pill>;
  if (!agent.enabled) state = <Pill tone="off">Off</Pill>;
  else if (agent.errors.length) state = <Pill tone="failed">Profile has problems</Pill>;
  else if (running) state = <Pill tone="running">Working on {running}</Pill>;
  else if (stats?.queued) state = <Pill tone="queued">{stats.queued} queued</Pill>;
  return (
    <div className={`panel agent-card${agent.enabled ? "" : " off"}`}>
      <div className="row">
        <div className="grow">
          <div className="name">{agent.name}</div>
          <div className="handle">@{agent.handle}</div>
        </div>
        <Switch checked={agent.enabled} onChange={onToggle} label={`Turn ${agent.name} ${agent.enabled ? "off" : "on"}`} />
      </div>
      <div className="row">{state}</div>
      <div className="cmd" title={agent.description}>
        {[agent.model ?? "default model", agent.effort ? `effort ${agent.effort}` : null, `${agent.skills.length + agent.ownSkills.length} skills`, `${agent.mcp.length + agent.ownMcp.length + 1} MCP`, agent.live ? "live" : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
      <div className="row">
        <div className="counts grow">
          <span>
            <b>{stats?.succeeded ?? 0}</b> done
          </span>
          <span>
            <b>{stats?.failed ?? 0}</b> failed
          </span>
        </div>
        <button className="small" disabled={!agent.enabled} onClick={onRun}>
          Run…
        </button>
      </div>
    </div>
  );
}

function RunningTask({ task, events, now }: { task: Task; events: TaskEvent[]; now: number }) {
  const steps = events.filter((event) => event.kind !== "stderr" && event.kind !== "text").slice(-6);
  const lastText = [...events].reverse().find((event) => event.kind === "text");
  const cancel = () => {
    if (confirm(`Stop ${task.agent} on ${task.owner}/${task.repo}#${task.threadNumber}?`)) void api.post(`/api/tasks/${task.id}/cancel`);
  };
  return (
    <div className="run-card">
      <div className="row">
        <StatusPill status={task.status} />
        <b>{task.agent}</b>
        <span className="meta">for {who(task.requestedBy)}</span>
        <span className="grow" />
        <span className="meta mono">{duration(task.startedAt, null, now)}</span>
        <a className="button small" href={href(`/tasks/${task.id}`)}>
          Open log
        </a>
        <button className="small danger" onClick={cancel}>
          Stop
        </button>
      </div>
      <ThreadCell task={task} />
      <ul className="steps">
        {steps.length === 0 && <li>Starting…</li>}
        {steps.map((event) => (
          <li key={event.id}>
            <span className="t">{event.ts.slice(11, 19)}</span>
            <span className="msg">
              <StepText text={event.message} />
            </span>
          </li>
        ))}
      </ul>
      {lastText && <div className="meta ellipsis">💬 {lastText.message}</div>}
    </div>
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

  if (error) return <div className="banner error">{error}</div>;
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
    <div className="stack">
      {!data.configured && (
        <div className="banner">
          <span className="grow">
            <b>Connect a GitHub App to start.</b> Agents run when they're mentioned on GitHub, which needs the app installed on your repositories.
          </span>
          <a className="button primary" href={href("/settings")}>
            Set up GitHub App
          </a>
        </div>
      )}
      {data.settings.paused && (
        <div className="banner">
          <span className="grow">
            <b>The queue is paused.</b> Running agents finish, but nothing new starts.
          </span>
        </div>
      )}

      {data.settings.spendBlocked ? (
        <div className="banner error">
          <span className="grow">
            <b>Spending limit reached.</b> {data.settings.spendBlocked}
          </span>
          <a className="button" href={href("/settings")}>
            Limits
          </a>
        </div>
      ) : data.settings.spend.warning ? (
        <div className="banner">
          <span className="grow">
            <b>Near the spending limit.</b> {data.settings.spend.warning}
          </span>
        </div>
      ) : null}

      {data.model.limit && (
        <div className="banner">
          <span className="grow">
            <b>Usage limit reached</b> ({data.model.limit.reason}). Agents continue automatically at {new Date(data.model.limit.until).toLocaleTimeString()}.
          </span>
          <button onClick={() => void api.del("/api/limit")}>Try now</button>
        </div>
      )}

      <div className="stats">
        <div className="panel stat">
          <div className="label">Working now</div>
          <div className="value">
            {data.running.length}
            <span className="meta"> / {data.settings.maxConcurrent}</span>
          </div>
        </div>
        <div className="panel stat">
          <div className="label">Queued</div>
          <div className="value">{data.queued.length}</div>
        </div>
        <div className="panel stat">
          <div className="label">Finished</div>
          <div className="value">{totals.succeeded}</div>
        </div>
        <div className="panel stat">
          <div className="label">Failed</div>
          <div className="value">{totals.failed}</div>
        </div>
      </div>

      <Panel
        title="Agents"
        hint={`${data.agents.filter((agent) => agent.enabled).length} of ${data.agents.length} on`}
        actions={
          <a className="button small" href={href("/agents")}>
            Manage
          </a>
        }
      >
        {data.agents.length === 0 ? (
          <Empty>
            No agents yet. Add one on the <a href={href("/agents")}>Agents</a> page or in agents.yaml.
          </Empty>
        ) : (
          <div className="grid-cards">
            {data.agents.map((agent) => (
              <AgentCard key={agent.name} agent={agent} running={runningByAgent(agent.name)} onRun={() => setRunFor(agent.name)} onToggle={(value) => void toggle(agent, value)} />
            ))}
          </div>
        )}
      </Panel>

      <UsageSummary />

      <div className="grid-2">
        <Panel title="Working now" hint={data.running.length ? "live" : undefined} tight>
          {data.running.length === 0 ? (
            <Empty>No agents are running. Mention one on GitHub, or use “Run…”.</Empty>
          ) : (
            data.running.map((task) => <RunningTask key={task.id} task={task} events={events[task.id] ?? []} now={now} />)
          )}
        </Panel>

        <Panel title="Queue" hint={data.queued.length ? `${data.queued.length} waiting` : undefined} tight>
          {data.queued.length === 0 ? (
            <Empty>Nothing waiting.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {data.queued.map((task) => (
                    <tr key={task.id} className="clickable" onClick={() => navigate(`/tasks/${task.id}`)}>
                      <td>
                        <b>{task.agent}</b>
                        <div className="meta">{ago(task.createdAt, now)}</div>
                      </td>
                      <td style={{ maxWidth: 320 }}>
                        <ThreadCell task={task} />
                      </td>
                      <td>
                        <button
                          className="small danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            void api.post(`/api/tasks/${task.id}/cancel`);
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Agent sessions" hint={data.sessions.length ? `${data.sessions.length} open · kept ${data.settings.liveIdleMinutes} min after the last task` : undefined} tight>
        {data.sessions.length === 0 ? (
          <Empty>No open sessions. Live agents keep their Claude session open between tasks on the same thread.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {data.sessions.map((session) => (
                  <tr key={session.key}>
                    <td>
                      <b>{session.agent}</b>
                      <div className="meta">{session.busy ? <Pill tone="running">working</Pill> : `idle, closes at ${new Date(session.closesAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</div>
                    </td>
                    <td>
                      <a href={href(`/history/${session.owner}/${session.repo}/${session.threadKind}/${session.threadNumber}`)}>
                        {session.owner}/{session.repo}#{session.threadNumber}
                      </a>
                      <div className="meta mono">{session.sessionId?.slice(0, 8) ?? "starting"}</div>
                    </td>
                    <td className="num meta">
                      {session.turns} task{session.turns === 1 ? "" : "s"}
                    </td>
                    <td>
                      <button
                        className="small"
                        disabled={session.busy}
                        onClick={() => void api.del(`/api/sessions/${encodeURIComponent(session.key)}`)}
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Recently finished"
        tight
        actions={
          <a className="button small" href={href("/tasks")}>
            All tasks
          </a>
        }
      >
        {data.recent.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Agent</th>
                  <th>Thread</th>
                  <th>Result</th>
                  <th>Took</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((task) => (
                  <tr key={task.id} className="clickable" onClick={() => navigate(`/tasks/${task.id}`)}>
                    <td>
                      <StatusPill status={task.status} />
                    </td>
                    <td>{task.agent}</td>
                    <td style={{ maxWidth: 320 }}>
                      <ThreadCell task={task} />
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      {task.prUrl ? (
                        <a href={task.prUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                          PR #{task.prNumber}
                        </a>
                      ) : (
                        <span className="meta ellipsis" style={{ display: "block" }}>
                          {task.error ?? task.resultText?.slice(0, 120) ?? "—"}
                        </span>
                      )}
                    </td>
                    <td className="num">{duration(task.startedAt, task.finishedAt)}</td>
                    <td className="num meta">{ago(task.finishedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {runFor !== null && <RunAgentDialog agents={data.agents} initialAgent={runFor} onClose={() => setRunFor(null)} />}
    </div>
  );
}
