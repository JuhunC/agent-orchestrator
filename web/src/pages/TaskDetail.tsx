import { useEffect, useRef, useState } from "react";
import { api, duration, KIND_LABEL, useNow, useStream, type Task, type TaskEvent } from "../api.ts";
import { Empty, Panel, StatusPill, who } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";

/** A task in a chain of agents starting each other. */
interface ChainNode {
  id: number;
  agent: string;
  owner: string;
  repo: string;
  threadKind: Task["threadKind"];
  threadNumber: number;
  threadTitle: string;
  triggerKind: Task["triggerKind"];
  status: Task["status"];
  board: string | null;
  boardColumn: string | null;
  started?: ChainNode[];
}

function ChainRow({ node, depth, current }: { node: ChainNode; depth: number; current?: boolean }) {
  return (
    <>
      <div className="chain-row" style={{ paddingLeft: depth * 18 }}>
        <StatusPill status={node.status} />{" "}
        {current ? <b>this task</b> : <a href={href(`/tasks/${node.id}`)}>task #{node.id}</a>} · {node.agent} on {node.owner}/{node.repo}#{node.threadNumber}
        {node.threadTitle ? ` "${node.threadTitle}"` : ""}
        <span className="meta">
          {" "}
          · {node.triggerKind === "agent" ? "started by an agent" : node.triggerKind === "schedule" ? "scheduled run" : node.triggerKind === "board" ? `board stage${node.boardColumn ? ` (${node.boardColumn})` : ""}` : node.triggerKind}
        </span>
      </div>
      {node.started?.map((child) => <ChainRow key={child.id} node={child} depth={depth + 1} />)}
    </>
  );
}

/** Who started whom: the tasks that led to this one, and those it started. */
function Chain({ task, chain }: { task: Task; chain: { ancestors: ChainNode[]; started: ChainNode[] } }) {
  if (!chain.ancestors.length && !chain.started.length) return null;
  return (
    <Panel title="Chain" hint="agents starting agents on related issues, and board stages their moves started">
      <div className="chain">
        {chain.ancestors.map((node, index) => (
          <ChainRow key={node.id} node={node} depth={index} />
        ))}
        <ChainRow node={{ ...task, started: chain.started }} depth={chain.ancestors.length} current />
      </div>
    </Panel>
  );
}

export function TaskDetail({ id }: { id: number }) {
  const [task, setTask] = useState<Task | null>(null);
  const [chain, setChain] = useState<{ ancestors: ChainNode[]; started: ChainNode[] } | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showStderr, setShowStderr] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  useEffect(() => {
    setTask(null);
    setEvents([]);
    api
      .get<{ task: Task; events: TaskEvent[]; chain?: { ancestors: ChainNode[]; started: ChainNode[] } }>(`/api/tasks/${id}`)
      .then((data) => {
        setTask(data.task);
        setEvents(data.events);
        setChain(data.chain ?? null);
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

  useStream((message) => {
    if (message.type === "task" && message.task.id === id) setTask(message.task);
    if (message.type === "event" && message.event.taskId === id) {
      setEvents((current) => (current.some((event) => event.id === message.event.id) ? current : [...current, message.event]));
    }
  });

  const visible = events.filter((event) => showStderr || event.kind !== "stderr");
  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visible.length, follow]);

  if (error) return <div className="banner error">{error}</div>;
  if (!task) return <Empty>Loading…</Empty>;

  const active = task.status === "running" || task.status === "queued";
  const cancel = () => confirm("Stop this agent?") && void api.post(`/api/tasks/${task.id}/cancel`);
  const retry = async () => {
    const created = await api.post<Task>(`/api/tasks/${task.id}/retry`);
    navigate(`/tasks/${created.id}`);
  };
  const replay = async () => {
    const created = await api.post<Task>(`/api/tasks/${task.id}/replay`);
    navigate(`/tasks/${created.id}`);
  };
  const stderrCount = events.filter((event) => event.kind === "stderr").length;

  return (
    <div className="stack">
      <div className="page-head">
        <StatusPill status={task.status} />
        <h1>
          {task.agent} · {task.owner}/{task.repo}#{task.threadNumber}
        </h1>
        <span className="spacer" />
        {active ? (
          <button className="danger" onClick={cancel}>
            {task.status === "queued" ? "Remove from queue" : "Stop agent"}
          </button>
        ) : (
          <>
            <button onClick={retry}>Run again</button>
            {!task.dryRun && (
              <button onClick={() => void replay()} title="Run the same request with the agent's current profile, without changing anything on GitHub">
                Dry run
              </button>
            )}
          </>
        )}
      </div>

      {task.dryRun && (
        <div className="banner info">
          <span className="grow">
            <b>Dry run{task.retryOf ? <> of <a href={href(`/tasks/${task.retryOf}`)}>task #{task.retryOf}</a></> : null}.</b> The agent worked with its current profile in a checkout of its own, and nothing was changed on GitHub: what it would have posted, pushed or moved is in the log as "Dry run: would …". Compare its reply with the original's to judge a profile change.
          </span>
        </div>
      )}

      {task.error && task.status !== "succeeded" && <div className="banner error">{task.error}</div>}
      {task.status === "queued" && task.retryAt && (
        <div className="banner">
          <span className="grow">
            <b>Waiting for the usage limit to reset.</b> It continues automatically at {new Date(task.retryAt).toLocaleString()} (attempt {task.attempts + 1}).
          </span>
          <button onClick={() => void api.post(`/api/tasks/${task.id}/run-now`)}>Run now</button>
        </div>
      )}

      {chain && <Chain task={task} chain={chain} />}

      <div className="grid-2">
        <Panel title="Request">
          <div className="stack" style={{ gap: 10 }}>
            <div>
              <span className="badge">{KIND_LABEL[task.threadKind]}</span>{" "}
              {task.threadUrl ? (
                <a href={task.threadUrl} target="_blank" rel="noreferrer">
                  {task.threadTitle || `${task.owner}/${task.repo}#${task.threadNumber}`} ↗
                </a>
              ) : (
                task.threadTitle
              )}
            </div>
            <blockquote>{task.requestText}</blockquote>
            <div className="meta">
              {who(task.requestedBy)} · {task.triggerKind}
              {task.requestUrl && (
                <>
                  {" · "}
                  <a href={task.requestUrl} target="_blank" rel="noreferrer">
                    view on GitHub ↗
                  </a>
                </>
              )}
              {task.retryOf && (
                <>
                  {task.dryRun ? " · dry run of " : " · retry of "}
                  <a href={href(`/tasks/${task.retryOf}`)}>#{task.retryOf}</a>
                </>
              )}
              {task.profileVersion && (
                <span title="The version of the agent's profile that ran this task (see the agent's page for outcomes by version)">
                  {" · profile "}
                  <code>{task.profileVersion}</code>
                  {task.profileCommit ? ` (commit ${task.profileCommit})` : ""}
                </span>
              )}
              {task.scheduleId && (
                <>
                  {" · "}
                  <a href={href(`/schedules`)}>schedule #{task.scheduleId}</a>
                </>
              )}
              {task.startedByTask && (
                <>
                  {" · started by task "}
                  <a href={href(`/tasks/${task.startedByTask}`)}>#{task.startedByTask}</a>
                </>
              )}
            </div>
          </div>
        </Panel>
        <Panel title="Details">
          <dl className="kv">
            <dt>Task</dt>
            <dd>#{task.id}</dd>
            <dt>Duration</dt>
            <dd>{duration(task.startedAt, task.finishedAt, now)}</dd>
            <dt>Branch</dt>
            <dd className="mono">{task.branch ? `${task.branch}${task.baseBranch && task.baseBranch !== task.branch ? ` → ${task.baseBranch}` : ""}` : "—"}</dd>
            <dt>Pull request</dt>
            <dd>
              {task.prUrl ? (
                <a href={task.prUrl} target="_blank" rel="noreferrer">
                  #{task.prNumber} ↗
                </a>
              ) : (
                "—"
              )}
              {task.commits ? <span className="meta"> · {task.commits} commit{task.commits === 1 ? "" : "s"}</span> : null}
            </dd>
            <dt>Session</dt>
            <dd className="mono">{task.sessionId ?? "—"}</dd>
            <dt>Exit code</dt>
            <dd>{task.exitCode ?? "—"}</dd>
            {task.costUsd !== null && (
              <>
                <dt>Cost</dt>
                <dd>${task.costUsd.toFixed(4)}</dd>
              </>
            )}
            <dt>Thread history</dt>
            <dd>
              <a href={href(`/history/${task.owner}/${task.repo}/${task.threadKind}/${task.threadNumber}`)}>All runs on this thread</a>
            </dd>
          </dl>
        </Panel>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Activity</h2>
          <span className="hint">{active ? "live" : `${events.length} events`}</span>
          <span className="spacer" />
          <label className="check">
            <input type="checkbox" checked={showStderr} onChange={(event) => setShowStderr(event.target.checked)} style={{ width: "auto" }} /> stderr ({stderrCount})
          </label>
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} style={{ width: "auto" }} /> Follow
          </label>
        </div>
        <div className="log" ref={logRef}>
          {visible.length === 0 && <div className="line">{task.status === "queued" ? "Waiting for a free slot…" : "No activity yet."}</div>}
          {visible.map((event) => (
            <div key={event.id} className={`line k-${event.kind}`}>
              <span className="ts">{event.ts.slice(11, 19)}</span>
              <span className="kind">{event.kind}</span>
              <span className="msg">{event.message}</span>
            </div>
          ))}
        </div>
      </section>

      {task.resultText && (
        <Panel title="Agent reply">
          <div className="prose">{task.resultText}</div>
        </Panel>
      )}

      {task.prompt && (
        <Panel
          title="Prompt"
          hint="what the agent was given, including its history"
          actions={
            <button className="small" onClick={() => setShowPrompt((value) => !value)}>
              {showPrompt ? "Hide" : "Show"}
            </button>
          }
        >
          {showPrompt ? <pre className="block">{task.prompt}</pre> : <span className="meta">{task.prompt.length.toLocaleString()} characters</span>}
        </Panel>
      )}
    </div>
  );
}
