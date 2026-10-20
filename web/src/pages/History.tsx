import { api, ago, duration, KIND_LABEL, useApi, type Task, type ThreadKind, type ThreadSummary } from "../api.ts";
import { Empty, Panel, StatusPill, who } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";

export function History() {
  const { data } = useApi<ThreadSummary[]>("/api/threads", (message) => message.type === "task");
  return (
    <div className="stack">
      <div className="page-head">
        <span className="sub">
          Everything agents have done, per issue, pull request and discussion. When an agent is mentioned again on a thread, its earlier runs here (and on linked
          PRs) are given to it as context.
        </span>
      </div>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.length === 0 ? (
          <Empty>No agent has worked on anything yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Thread</th>
                  <th>Agents</th>
                  <th>Runs</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {data.map((thread) => (
                  <tr
                    key={`${thread.owner}/${thread.repo}/${thread.threadKind}/${thread.threadNumber}`}
                    className="clickable"
                    onClick={() => navigate(`/history/${thread.owner}/${thread.repo}/${thread.threadKind}/${thread.threadNumber}`)}
                  >
                    <td style={{ maxWidth: 460 }}>
                      <div className="title ellipsis">{thread.threadTitle || "(untitled)"}</div>
                      <div className="meta">
                        <span className="badge">{KIND_LABEL[thread.threadKind]}</span> {thread.owner}/{thread.repo}#{thread.threadNumber}
                      </div>
                    </td>
                    <td>
                      <div className="row">
                        {thread.agents.map((agent) => (
                          <span key={agent} className="badge accent">
                            {agent}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="num">{thread.taskCount}</td>
                    <td className="num meta">{ago(thread.lastActivity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

interface ThreadDetailData {
  ref: { owner: string; repo: string; kind: ThreadKind; number: number };
  tasks: Task[];
  links: { owner: string; repo: string; kind: ThreadKind; number: number }[];
  workspaces: { agent: string; exists: boolean }[];
}

export function ThreadDetail({ owner, repo, kind, number }: { owner: string; repo: string; kind: string; number: string }) {
  const base = `/api/threads/${owner}/${repo}/${kind}/${number}`;
  const { data, reload } = useApi<ThreadDetailData>(base, (message) => message.type === "task");
  if (!data) return <Empty>Loading…</Empty>;

  const title = data.tasks.find((task) => task.threadTitle)?.threadTitle ?? "";
  const url = data.tasks.find((task) => task.threadUrl)?.threadUrl;
  const agents = [...new Set(data.tasks.map((task) => task.agent))];

  const setMemory = async (agent: string, forgotten: boolean) => {
    await api.post(`${base}/memory`, { agent, forgotten });
    void reload();
  };
  const resetWorkspace = async (agent: string) => {
    if (!confirm(`Delete ${agent}'s checkout for this thread? The next run starts from a fresh clone.`)) return;
    try {
      await api.del(`${base}/workspace?agent=${encodeURIComponent(agent)}`);
      void reload();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <span className="badge">{KIND_LABEL[data.ref.kind]}</span>
        <h1 className="grow">
          {title || `${owner}/${repo}#${number}`} <span className="meta">{`${owner}/${repo}#${number}`}</span>
        </h1>
        {url && (
          <a className="button" href={url} target="_blank" rel="noreferrer">
            Open on GitHub ↗
          </a>
        )}
      </div>

      {data.links.length > 0 && (
        <div className="banner info">
          <span>
            Linked:{" "}
            {data.links.map((link, index) => (
              <span key={`${link.kind}${link.number}`}>
                {index > 0 && ", "}
                <a href={href(`/history/${link.owner}/${link.repo}/${link.kind}/${link.number}`)}>
                  {KIND_LABEL[link.kind]} #{link.number}
                </a>
              </span>
            ))}
            . Agents see their runs on linked threads too.
          </span>
        </div>
      )}

      <Panel title="Agent memory" hint="what each agent remembers about this thread">
        <div className="stack" style={{ gap: 10 }}>
          {agents.map((agent) => {
            const runs = data.tasks.filter((task) => task.agent === agent);
            const remembered = runs.filter((task) => !task.forgotten && task.status !== "queued" && task.status !== "running").length;
            const workspace = data.workspaces.find((entry) => entry.agent === agent);
            return (
              <div key={agent} className="row">
                <span className="badge accent">{agent}</span>
                <span className="grow meta">
                  remembers {remembered} of {runs.length} run{runs.length === 1 ? "" : "s"}
                  {workspace?.exists ? " · has a checkout" : ""}
                </span>
                {remembered > 0 ? (
                  <button className="small" onClick={() => void setMemory(agent, true)}>
                    Forget
                  </button>
                ) : (
                  <button className="small" onClick={() => void setMemory(agent, false)}>
                    Remember again
                  </button>
                )}
                <button className="small" disabled={!workspace?.exists} onClick={() => void resetWorkspace(agent)}>
                  Reset checkout
                </button>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="Runs" hint={`${data.tasks.length} total, oldest first`} tight>
        <div className="timeline">
          {data.tasks.map((task) => (
            <div key={task.id} className={`entry${task.forgotten ? " forgotten" : ""}`}>
              <div className="row">
                <StatusPill status={task.status} />
                <b>{task.agent}</b>
                <span className="meta">
                  for {who(task.requestedBy)} · {new Date(task.createdAt).toLocaleString()} · {duration(task.startedAt, task.finishedAt)}
                </span>
                {task.forgotten && <span className="badge">forgotten</span>}
                <span className="grow" />
                {task.prUrl && (
                  <a className="button small" href={task.prUrl} target="_blank" rel="noreferrer">
                    PR #{task.prNumber} ↗
                  </a>
                )}
                <a className="button small" href={href(`/tasks/${task.id}`)}>
                  Task #{task.id}
                </a>
              </div>
              <blockquote>{task.requestText.slice(0, 600)}</blockquote>
              {(task.resultText || task.error) && <div className="prose">{(task.resultText || task.error || "").slice(0, 1200)}</div>}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
