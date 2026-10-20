import { useState } from "react";
import { api, useApi, type Agent, type AgentsResponse } from "../api.ts";
import { RunAgentDialog } from "../components/RunAgentDialog.tsx";
import { Dialog, Empty, Panel, Pill, Switch } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";

function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("aorch-");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    try {
      await api.post("/api/agents", { name: name.trim(), handle: handle.trim().replace(/^@/, "") });
      onClose();
      navigate(`/agents/${name.trim()}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      title="New agent"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim() || handle.length < 2} onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="new-name">Name</label>
          <input id="new-name" placeholder="frontend" value={name} onChange={(event) => setName(event.target.value)} />
          <span className="help">Folder name and branch prefix: agent/&lt;name&gt;/…</span>
        </div>
        <div className="field">
          <label htmlFor="new-handle">GitHub handle</label>
          <input id="new-handle" value={handle} onChange={(event) => setHandle(event.target.value)} />
          <span className="help">What people @-mention. Pick a login nobody owns.</span>
        </div>
      </div>
      <p className="meta">This creates profiles/agents/{name || "<name>"}/agent.md from a template; you'll edit its role, skills and tools next.</p>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}

export function Chips({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="meta">{empty}</span>;
  return (
    <div className="row" style={{ gap: 4 }}>
      {items.map((item) => (
        <span key={item} className="badge">
          {item}
        </span>
      ))}
    </div>
  );
}

export function Agents() {
  const { data, reload } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents" || message.type === "task");
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  const toggle = async (agent: Agent, enabled: boolean) => {
    await api.post(`/api/agents/${encodeURIComponent(agent.name)}/enabled`, { enabled });
    void reload();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <span className="sub">
          Each agent is a folder in <code>{data?.profilesDir ?? "profiles"}/agents</code>: a role, skills, MCP servers and subagents. Mention its handle on GitHub
          to start it.
        </span>
        <span className="spacer" />
        <a className="button" href={href("/library")}>
          Shared library
        </a>
        <button className="primary" onClick={() => setCreating(true)}>
          New agent
        </button>
      </div>
      {data?.errors.length ? (
        <div className="banner error">
          <span>
            {data.errors.map((error) => (
              <div key={error}>{error}</div>
            ))}
          </span>
        </div>
      ) : null}
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.agents.length === 0 ? (
          <Empty>No agents yet. Create one, or add a folder under profiles/agents.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>On</th>
                  <th>Agent</th>
                  <th>Skills</th>
                  <th>MCP</th>
                  <th>Subagents</th>
                  <th>Runs</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.agents.map((agent) => (
                  <tr key={agent.name} className="clickable" onClick={() => navigate(`/agents/${agent.name}`)}>
                    <td onClick={(event) => event.stopPropagation()}>
                      <Switch checked={agent.enabled} disabled={!agent.enabledInFile} onChange={(value) => void toggle(agent, value)} label={`Turn ${agent.name} ${agent.enabled ? "off" : "on"}`} />
                    </td>
                    <td>
                      <div className="title">
                        {agent.name} {agent.live && <span className="badge accent">live</span>} {agent.errors.length > 0 && <Pill tone="failed">{agent.errors.length} problem{agent.errors.length === 1 ? "" : "s"}</Pill>}
                      </div>
                      <div className="meta">
                        @{agent.handle}
                        {agent.model && ` · ${agent.model}`}
                        {agent.description && ` · ${agent.description}`}
                      </div>
                    </td>
                    <td>
                      <Chips items={[...agent.skills, ...agent.ownSkills.map((skill) => skill.name)]} />
                    </td>
                    <td>
                      <Chips items={["github", ...agent.mcp, ...agent.ownMcp]} />
                    </td>
                    <td>
                      <Chips items={agent.subagents} />
                    </td>
                    <td className="num meta">{agent.stats ? `${agent.stats.succeeded} done · ${agent.stats.failed} failed` : "—"}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <button className="small" disabled={!agent.enabled || agent.errors.length > 0} onClick={() => setRunning(agent.name)}>
                        Run…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {creating && <NewAgentDialog onClose={() => setCreating(false)} />}
      {running && data && <RunAgentDialog agents={data.agents} initialAgent={running} onClose={() => setRunning(null)} />}
    </div>
  );
}
