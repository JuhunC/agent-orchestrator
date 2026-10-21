import { useState } from "react";
import { ago, api, duration, useApi, useNow, type AgentsResponse, type Task } from "../api.ts";
import { Empty, Panel, StatusPill, ThreadCell, who } from "../components/ui.tsx";
import { navigate } from "../router.ts";

const PAGE = 50;

export function Tasks() {
  const [status, setStatus] = useState("");
  const [agent, setAgent] = useState("");
  const [repo, setRepo] = useState("");
  const [older, setOlder] = useState<Task[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (status) query.set("status", status);
  if (agent) query.set("agent", agent);
  if (/^[^/\s]+\/[^/\s]+$/.test(repo)) query.set("repo", repo);
  const path = `/api/tasks?${query}`;
  const { data } = useApi<Task[]>(path, (message) => message.type === "task");
  const agents = useApi<AgentsResponse>("/api/agents").data?.agents ?? [];
  const now = useNow(5000);

  const tasks = [...(data ?? []), ...older.filter((task) => !(data ?? []).some((current) => current.id === task.id))];

  const loadMore = async () => {
    const last = tasks.at(-1);
    if (!last) return;
    const next = await api.get<Task[]>(`${path}&before=${last.id}`);
    setOlder((current) => [...current, ...next]);
    if (next.length < PAGE) setExhausted(true);
  };

  const resetPaging = () => {
    setOlder([]);
    setExhausted(false);
  };

  return (
    <div className="stack">
      <div className="filters">
        <select aria-label="Status" value={status} onChange={(event) => (setStatus(event.target.value), resetPaging())}>
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="queued">Queued</option>
          <option value="succeeded">Done</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select aria-label="Agent" value={agent} onChange={(event) => (setAgent(event.target.value), resetPaging())}>
          <option value="">All agents</option>
          {agents.map((candidate) => (
            <option key={candidate.name}>{candidate.name}</option>
          ))}
        </select>
        <input aria-label="Repository" placeholder="owner/repo" value={repo} onChange={(event) => (setRepo(event.target.value.trim()), resetPaging())} style={{ maxWidth: 220 }} />
      </div>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : tasks.length === 0 ? (
          <Empty>No tasks match.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Status</th>
                  <th>Agent</th>
                  <th>Thread</th>
                  <th>Requested by</th>
                  <th>Took</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} className="clickable" onClick={() => navigate(`/tasks/${task.id}`)}>
                    <td className="num meta">{task.id}</td>
                    <td>
                      <StatusPill status={task.status} />
                    </td>
                    <td>{task.agent}</td>
                    <td style={{ maxWidth: 380 }}>
                      <ThreadCell task={task} />
                    </td>
                    <td>
                      {who(task.requestedBy)}
                      <div className="meta">{task.triggerKind}</div>
                    </td>
                    <td className="num">{duration(task.startedAt, task.finishedAt, now)}</td>
                    <td className="num meta">{ago(task.createdAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {data && tasks.length >= PAGE && !exhausted && (
        <div className="row" style={{ justifyContent: "center" }}>
          <button onClick={loadMore}>Load older tasks</button>
        </div>
      )}
    </div>
  );
}
