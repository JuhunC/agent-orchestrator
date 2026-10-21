import { useState } from "react";
import { api, EFFORTS, useApi, type AgentsResponse, type Group } from "../api.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Dialog, Empty, Panel, Pill } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";
import { Chips } from "./Agents.tsx";

function NewGroupDialog({ agents, onClose }: { agents: string[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    try {
      await api.post(`/api/groups/${encodeURIComponent(name)}/members`, { agents: members });
      onClose();
      navigate(`/groups/${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      title="New group"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name} onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="group-name">Name</label>
          <input id="group-name" placeholder="developers" value={name} onChange={(event) => setName(event.target.value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
          <span className="help">Use it in a board column as group:{name || "<name>"}</span>
        </div>
        <div className="field">
          <label>Members</label>
          <div className="row">
            {agents.map((agent) => (
              <label key={agent} className="check">
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={members.includes(agent)}
                  onChange={(event) => setMembers((current) => (event.target.checked ? [...current, agent] : current.filter((member) => member !== agent)))}
                />
                {agent}
              </label>
            ))}
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    </Dialog>
  );
}

export function Groups() {
  const { data } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents");
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <div className="page-head">
        <span className="sub">
          Groups bundle agents: members inherit the group's defaults (model, effort, skills, MCP servers, subagents), a board column can take a whole group, and you can change
          every member at once.
        </span>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          New group
        </button>
      </div>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.groups.length === 0 ? (
          <Empty>No groups yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Members</th>
                  <th>Defaults</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <tr key={group.name} className="clickable" onClick={() => navigate(`/groups/${group.name}`)}>
                    <td>
                      <div className="title">
                        {group.name} {group.errors.length > 0 && <Pill tone="failed">problems</Pill>}
                      </div>
                      <div className="meta">{group.description}</div>
                    </td>
                    <td>
                      <Chips items={group.members} empty="none" />
                    </td>
                    <td className="meta">{defaultsText(group)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {creating && data && <NewGroupDialog agents={data.agents.map((agent) => agent.name)} onClose={() => setCreating(false)} />}
    </div>
  );
}

function defaultsText(group: Group): string {
  const parts = [
    group.defaults.model && `model ${group.defaults.model}`,
    group.defaults.effort && `effort ${group.defaults.effort}`,
    group.defaults.skills.length && `skills: ${group.defaults.skills.join(", ")}`,
    group.defaults.mcp.length && `MCP: ${group.defaults.mcp.join(", ")}`,
    group.defaults.subagents.length && `subagents: ${group.defaults.subagents.join(", ")}`,
  ].filter(Boolean);
  return parts.join(" · ") || "none";
}

export function GroupDetail({ name }: { name: string }) {
  const { data, reload } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return <Empty>Loading…</Empty>;
  const group = data.groups.find((candidate) => candidate.name === name);
  if (!group) return <Empty>No group called {name}.</Empty>;
  const members = data.agents.filter((agent) => group.members.includes(agent.name));

  const apply = async (body: Record<string, unknown>, done: string) => {
    setError(null);
    setStatus(null);
    try {
      const result = await api.post<{ members: string[] }>(`/api/groups/${encodeURIComponent(group.name)}/apply`, body);
      setStatus(`${done} for ${result.members.length} agent${result.members.length === 1 ? "" : "s"}`);
      void reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="grow">
          {group.name} <span className="meta">use as group:{group.name}</span>
        </h1>
        <a className="button" href={href("/groups")}>
          All groups
        </a>
      </div>
      {group.errors.length > 0 && <div className="banner error">{group.errors.join(" · ")}</div>}

      <Panel title="Members" hint={`${members.length} agent${members.length === 1 ? "" : "s"}`} tight>
        {members.length === 0 ? (
          <Empty>No members. Add agent names under members in the file below.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Model · effort</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {members.map((agent) => (
                  <tr key={agent.name} className="clickable" onClick={() => navigate(`/agents/${agent.name}`)}>
                    <td>
                      <div className="title">{agent.name}</div>
                      <div className="meta">@{agent.handle}</div>
                    </td>
                    <td className="meta">
                      {agent.model ?? "default"}
                      {agent.modelFrom === "group" && " (group)"} · {agent.effort ?? "default"}
                      {agent.effortFrom === "group" && " (group)"}
                    </td>
                    <td>{agent.enabled ? <Pill tone="succeeded">on</Pill> : <Pill tone="off">off</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Change every member at once" hint="writes each member's agent.md">
        <div className="stack" style={{ gap: 12 }}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="group-model">Model</label>
              <input id="group-model" list="model-suggestions" placeholder="e.g. claude-sonnet-5-5 (empty clears it)" value={model} onChange={(event) => setModel(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="group-effort">Effort</label>
              <select id="group-effort" value={effort} onChange={(event) => setEffort(event.target.value)}>
                <option value="">Model default (clears it)</option>
                {EFFORTS.map((level) => (
                  <option key={level}>{level}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <button className="primary small" onClick={() => void apply({ model: model.trim() || null, effort: effort || null }, "Set model and effort")}>
              Apply model and effort to all
            </button>
            <button className="small" onClick={() => void apply({ enabled: true }, "Turned on")}>
              Turn all on
            </button>
            <button className="small danger" onClick={() => void apply({ enabled: false }, "Turned off")}>
              Turn all off
            </button>
            {status && <span className="meta">{status}</span>}
            {error && <span className="error-text">{error}</span>}
          </div>
          <p className="meta" style={{ margin: 0 }}>
            To make members inherit instead (so later members get it too), set it under <code>defaults</code> in the group file; an agent's own setting still wins.
          </p>
        </div>
      </Panel>

      <Panel title={`groups/${group.name}.yaml`} hint="members and shared defaults">
        <FileEditor path={`groups/${group.name}.yaml`} rows={14} onSaved={() => void reload()} onDeleted={() => navigate("/groups")} deleteLabel="Delete group" />
        <p className="meta">
          Example: <code>{"members: [coder, coder-2]"}</code> and <code>{"defaults: { model: sonnet, effort: high, skills: [shipping-changes] }"}</code>
        </p>
      </Panel>
    </div>
  );
}
