import { useState } from "react";
import { api, type Agent, type Group } from "../api.ts";
import { Dialog } from "./ui.tsx";

/** Copies an agent: one named copy to edit, or several identical numbered copies. */
export function DuplicateDialog({ agent, groups, onClose, onDone }: { agent: Agent; groups: Group[]; onClose: () => void; onDone: (created: string[]) => void }) {
  const [mode, setMode] = useState<"one" | "many">("one");
  const [name, setName] = useState(`${agent.name}-copy`);
  const [handle, setHandle] = useState(`${agent.handle}-copy`.slice(0, 39));
  const [count, setCount] = useState("2");
  const [group, setGroup] = useState(agent.groups[0] ?? "");
  const [newGroup, setNewGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const targetGroup = group === "__new" ? newGroup.trim() : group;
      const body = mode === "one" ? { name: name.trim(), handle: handle.trim(), group: targetGroup || undefined } : { count: Number(count), group: targetGroup || undefined };
      const { created } = await api.post<{ created: string[] }>(`/api/agents/${encodeURIComponent(agent.name)}/duplicate`, body);
      onDone(created);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Duplicate ${agent.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || (mode === "one" ? !name.trim() || !handle.trim() : !(Number(count) >= 1))} onClick={submit}>
            {busy ? "Creating…" : mode === "one" ? "Create copy" : `Create ${count} copies`}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="row">
          <label className="check">
            <input type="radio" name="dup-mode" checked={mode === "one"} onChange={() => setMode("one")} style={{ width: "auto" }} /> One copy to customise
          </label>
          <label className="check">
            <input type="radio" name="dup-mode" checked={mode === "many"} onChange={() => setMode("many")} style={{ width: "auto" }} /> Several identical copies
          </label>
        </div>
        {mode === "one" ? (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="dup-name">Name</label>
              <input id="dup-name" value={name} onChange={(event) => setName(event.target.value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
            </div>
            <div className="field">
              <label htmlFor="dup-handle">GitHub handle</label>
              <input id="dup-handle" value={handle} onChange={(event) => setHandle(event.target.value.replace(/^@/, ""))} />
            </div>
          </div>
        ) : (
          <div className="field" style={{ maxWidth: 240 }}>
            <label htmlFor="dup-count">How many</label>
            <input id="dup-count" inputMode="numeric" value={count} onChange={(event) => setCount(event.target.value.replace(/\D/g, ""))} />
            <span className="help">
              Named {agent.name.replace(/-\d+$/, "")}-2, -3, … with handles @{agent.handle.replace(/-\d+$/, "")}-2, -3, …
            </span>
          </div>
        )}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="dup-group">Add to group</label>
            <select id="dup-group" value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="">No group</option>
              {groups.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </option>
              ))}
              <option value="__new">New group…</option>
            </select>
          </div>
          {group === "__new" && (
            <div className="field">
              <label htmlFor="dup-new-group">New group name</label>
              <input id="dup-new-group" value={newGroup} onChange={(event) => setNewGroup(event.target.value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
            </div>
          )}
        </div>
        <p className="meta" style={{ margin: 0 }}>
          Copies get everything: role, skills, MCP servers, subagents, model and effort. To run identical copies without separate folders, set <code>replicas: N</code> in agent.md instead.
        </p>
        {error && <p className="error-text">{error}</p>}
      </div>
    </Dialog>
  );
}
