import { useEffect, useRef, useState } from "react";
import { api, duration, KIND_LABEL, useNow, useStream, type Task, type TaskEvent } from "../api.ts";
import { Empty, Panel, StatusPill, who } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";

export function TaskDetail({ id }: { id: number }) {
  const [task, setTask] = useState<Task | null>(null);
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
      .get<{ task: Task; events: TaskEvent[] }>(`/api/tasks/${id}`)
      .then((data) => {
        setTask(data.task);
        setEvents(data.events);
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
          <button onClick={retry}>Run again</button>
        )}
      </div>

      {task.error && task.status !== "succeeded" && <div className="banner error">{task.error}</div>}
      {task.status === "queued" && task.retryAt && (
        <div className="banner">
          <span className="grow">
            <b>Waiting for the usage limit to reset.</b> It continues automatically at {new Date(task.retryAt).toLocaleString()} (attempt {task.attempts + 1}).
          </span>
          <button onClick={() => void api.post(`/api/tasks/${task.id}/run-now`)}>Run now</button>
        </div>
      )}

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
                  {" · retry of "}
                  <a href={href(`/tasks/${task.retryOf}`)}>#{task.retryOf}</a>
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
