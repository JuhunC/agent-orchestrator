import { useEffect, useState } from "react";
import { api, type Agent, type Installation } from "../api.ts";
import { navigate } from "../router.ts";
import { Dialog } from "./ui.tsx";

export function RunAgentDialog({ agents, initialAgent, onClose }: { agents: Agent[]; initialAgent?: string; onClose: () => void }) {
  const enabled = agents.filter((agent) => agent.enabled);
  const [agent, setAgent] = useState(initialAgent ?? enabled[0]?.name ?? "");
  const [repo, setRepo] = useState("");
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState("auto");
  const [instruction, setInstruction] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Installation[]>("/api/installations")
      .then((installations) => {
        const all = installations.flatMap((installation) => installation.repositories).sort();
        setRepos(all);
        if (all.length === 1) setRepo(all[0]!);
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.post<{ id: number }>("/api/tasks", { agent, repo, number: Number(number), kind, instruction });
      onClose();
      navigate(`/tasks/${id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const valid = agent && /^[^/\s]+\/[^/\s]+$/.test(repo) && Number(number) > 0 && instruction.trim();

  return (
    <Dialog
      title="Run an agent"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Starting…" : "Start agent"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="run-agent">Agent</label>
          <select id="run-agent" value={agent} onChange={(event) => setAgent(event.target.value)}>
            {enabled.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} (@{candidate.handle})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="run-repo">Repository</label>
          <input id="run-repo" list="run-repos" placeholder="owner/repo" value={repo} onChange={(event) => setRepo(event.target.value.trim())} />
          <datalist id="run-repos">
            {repos.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="run-number">Issue, PR or discussion number</label>
          <input id="run-number" inputMode="numeric" placeholder="42" value={number} onChange={(event) => setNumber(event.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="field">
          <label htmlFor="run-kind">Type</label>
          <select id="run-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="auto">Issue or PR (detect)</option>
            <option value="discussion">Discussion</option>
          </select>
        </div>
        <div className="field full">
          <label htmlFor="run-instruction">Instruction</label>
          <textarea id="run-instruction" rows={5} placeholder="What should the agent do?" value={instruction} onChange={(event) => setInstruction(event.target.value)} />
          <span className="help">The agent posts its progress and reply on the thread, as if it had been mentioned there.</span>
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}
