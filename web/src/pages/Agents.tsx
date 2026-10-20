import { useState } from "react";
import { api, useApi, type Agent } from "../api.ts";
import { AgentForm } from "../components/AgentForm.tsx";
import { RunAgentDialog } from "../components/RunAgentDialog.tsx";
import { Empty, Panel, Pill, Switch } from "../components/ui.tsx";

export function Agents() {
  const { data, reload } = useApi<Agent[]>("/api/agents", (message) => message.type === "agents" || message.type === "task");
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const toggle = async (agent: Agent, enabled: boolean) => {
    await api.post(`/api/agents/${encodeURIComponent(agent.name)}/enabled`, { enabled });
    void reload();
  };
  const remove = async (agent: Agent) => {
    if (!confirm(`Delete ${agent.name}? Its task history is kept.`)) return;
    await api.del(`/api/agents/${encodeURIComponent(agent.name)}`);
    void reload();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <span className="sub">Mention an agent's handle on an issue, PR or discussion, or assign it, to start it.</span>
        <span className="spacer" />
        <button className="primary" onClick={() => setEditing("new")}>
          New agent
        </button>
      </div>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.length === 0 ? (
          <Empty>No agents yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>On</th>
                  <th>Agent</th>
                  <th>Command</th>
                  <th>Output</th>
                  <th>Runs</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((agent) => (
                  <tr key={agent.name}>
                    <td>
                      <Switch checked={agent.enabled} onChange={(value) => void toggle(agent, value)} label={`Turn ${agent.name} ${agent.enabled ? "off" : "on"}`} />
                    </td>
                    <td>
                      <div className="title">
                        {agent.name} {agent.source === "file" && <span className="badge">agents.yaml</span>}
                      </div>
                      <div className="meta">
                        @{agent.handle}
                        {agent.description && ` · ${agent.description}`}
                      </div>
                    </td>
                    <td style={{ maxWidth: 360 }}>
                      <div className="mono ellipsis" title={[agent.command, ...agent.args].join(" ")}>
                        {agent.command} {agent.args.join(" ")}
                      </div>
                      <div className="row" style={{ marginTop: 4 }}>
                        {agent.installed ? <Pill tone="succeeded">installed</Pill> : <Pill tone="failed">not found on PATH</Pill>}
                        {agent.resumeArgs.length > 0 && <span className="badge">resumes sessions</span>}
                        {!agent.openPullRequest && <span className="badge">read-only</span>}
                        {agent.exposeGithubToken && <span className="badge">GitHub token</span>}
                      </div>
                    </td>
                    <td className="mono meta">{agent.output}</td>
                    <td className="num meta">
                      {agent.stats ? `${agent.stats.succeeded} done · ${agent.stats.failed} failed` : "—"}
                      {agent.stats?.running ? <div>{agent.stats.running} running</div> : null}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        <button className="small" disabled={!agent.enabled} onClick={() => setRunning(agent.name)}>
                          Run…
                        </button>
                        <button className="small" onClick={() => setEditing(agent)}>
                          {agent.source === "file" ? "View" : "Edit"}
                        </button>
                        {agent.source === "ui" && (
                          <button className="small danger" onClick={() => void remove(agent)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {editing && <AgentForm agent={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {running && data && <RunAgentDialog agents={data} initialAgent={running} onClose={() => setRunning(null)} />}
    </div>
  );
}
