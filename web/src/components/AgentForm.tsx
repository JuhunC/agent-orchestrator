import { useState } from "react";
import { api, type Agent, type OutputFormat } from "../api.ts";
import { Dialog, Switch } from "./ui.tsx";

interface Draft {
  name: string;
  handle: string;
  description: string;
  command: string;
  args: string;
  resumeArgs: string;
  output: OutputFormat;
  env: string;
  timeoutMinutes: string;
  openPullRequest: boolean;
  exposeGithubToken: boolean;
  enabled: boolean;
}

const PRESETS: Record<string, Partial<Draft>> = {
  "Custom command (text)": { command: "myClaude", args: "-p\n{prompt}", resumeArgs: "", output: "text" },
  "Claude Code": {
    command: "claude",
    args: "-p\n--output-format\nstream-json\n--verbose\n--dangerously-skip-permissions",
    resumeArgs: "-p\n--resume\n{session_id}\n--output-format\nstream-json\n--verbose\n--dangerously-skip-permissions",
    output: "claude-stream-json",
  },
  "Cursor CLI": {
    command: "agent",
    args: "-p\n--force\n--output-format\nstream-json\n{prompt}",
    resumeArgs: "-p\n--force\n--output-format\nstream-json\n--resume\n{session_id}\n{prompt}",
    output: "claude-stream-json",
  },
  "OpenAI Codex": {
    command: "codex",
    args: "exec\n--json\n--skip-git-repo-check\n--dangerously-bypass-approvals-and-sandbox\n-",
    resumeArgs: "exec\nresume\n--json\n--skip-git-repo-check\n--dangerously-bypass-approvals-and-sandbox\n{session_id}\n-",
    output: "codex-json",
  },
  "Gemini CLI": {
    command: "gemini",
    args: "--yolo\n--output-format\nstream-json\n-p\nCarry out the task described above.",
    resumeArgs: "--yolo\n--output-format\nstream-json\n--resume\nlatest\n-p\nCarry out the task described above.",
    output: "gemini-stream-json",
  },
};

function toDraft(agent?: Agent): Draft {
  return {
    name: agent?.name ?? "",
    handle: agent?.handle ?? "",
    description: agent?.description ?? "",
    command: agent?.command ?? "",
    args: agent?.args.join("\n") ?? "",
    resumeArgs: agent?.resumeArgs.join("\n") ?? "",
    output: agent?.output ?? "text",
    env: Object.entries(agent?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    timeoutMinutes: agent?.timeoutMinutes ? String(agent.timeoutMinutes) : "",
    openPullRequest: agent?.openPullRequest ?? true,
    exposeGithubToken: agent?.exposeGithubToken ?? false,
    enabled: agent?.enabled ?? true,
  };
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function AgentForm({ agent, onClose, onSaved }: { agent?: Agent; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readOnly = agent?.source === "file";
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    const env: Record<string, string> = {};
    for (const line of lines(draft.env)) {
      const at = line.indexOf("=");
      if (at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const body = {
      name: draft.name.trim(),
      handle: draft.handle.trim() || draft.name.trim(),
      description: draft.description,
      command: draft.command.trim(),
      args: lines(draft.args),
      resume_args: lines(draft.resumeArgs),
      output: draft.output,
      env,
      timeout_minutes: draft.timeoutMinutes ? Number(draft.timeoutMinutes) : null,
      open_pull_request: draft.openPullRequest,
      expose_github_token: draft.exposeGithubToken,
      enabled: draft.enabled,
    };
    try {
      if (agent) await api.put(`/api/agents/${encodeURIComponent(agent.name)}`, body);
      else await api.post("/api/agents", body);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={readOnly ? `${agent!.name} (from agents.yaml)` : agent ? `Edit ${agent.name}` : "New agent"}
      onClose={onClose}
      footer={
        readOnly ? (
          <button onClick={onClose}>Close</button>
        ) : (
          <>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy || !draft.name || !draft.command} onClick={save}>
              {busy ? "Saving…" : "Save agent"}
            </button>
          </>
        )
      }
    >
      {readOnly && <div className="banner info">This agent is defined in agents.yaml. Edit that file and restart the orchestrator to change it.</div>}
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          {!agent && (
            <div className="field full">
              <label htmlFor="preset">Start from</label>
              <select id="preset" defaultValue="" onChange={(event) => event.target.value && setDraft((current) => ({ ...current, ...PRESETS[event.target.value] }))}>
                <option value="">Choose a preset…</option>
                {Object.keys(PRESETS).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="agent-name">Name</label>
            <input id="agent-name" value={draft.name} disabled={Boolean(agent)} placeholder="my-claude" onChange={(event) => set("name", event.target.value)} />
            <span className="help">Used in branch names and labels.</span>
          </div>
          <div className="field">
            <label htmlFor="agent-handle">GitHub handle</label>
            <input id="agent-handle" value={draft.handle} placeholder="aorch-my-claude" onChange={(event) => set("handle", event.target.value.replace(/^@/, ""))} />
            <span className="help">People @-mention or assign this login.</span>
          </div>
          <div className="field full">
            <label htmlFor="agent-description">Description</label>
            <input id="agent-description" value={draft.description} onChange={(event) => set("description", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="agent-command">Command</label>
            <input id="agent-command" className="mono" value={draft.command} placeholder="myClaude" onChange={(event) => set("command", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="agent-output">Output format</label>
            <select id="agent-output" value={draft.output} onChange={(event) => set("output", event.target.value as OutputFormat)}>
              <option value="text">Plain text</option>
              <option value="claude-stream-json">Claude / Cursor stream-json</option>
              <option value="codex-json">Codex JSONL</option>
              <option value="gemini-stream-json">Gemini stream-json</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="agent-args">Arguments (one per line)</label>
            <textarea id="agent-args" className="mono" rows={6} value={draft.args} onChange={(event) => set("args", event.target.value)} />
            <span className="help">
              {"{prompt}"}, {"{prompt_file}"}, {"{workdir}"}, {"{branch}"}, {"{repo}"}. Without {"{prompt}"} the prompt goes to stdin.
            </span>
          </div>
          <div className="field">
            <label htmlFor="agent-resume">Resume arguments (optional)</label>
            <textarea id="agent-resume" className="mono" rows={6} value={draft.resumeArgs} onChange={(event) => set("resumeArgs", event.target.value)} />
            <span className="help">Used instead when the agent already has a session on the thread. {"{session_id}"} is filled in.</span>
          </div>
          <div className="field">
            <label htmlFor="agent-env">Environment (KEY=value per line)</label>
            <textarea id="agent-env" className="mono" rows={3} value={draft.env} placeholder={"ANTHROPIC_API_KEY=${MY_KEY}"} onChange={(event) => set("env", event.target.value)} />
            <span className="help">{"${NAME}"} is read from the orchestrator's environment.</span>
          </div>
          <div className="field">
            <label htmlFor="agent-timeout">Timeout (minutes)</label>
            <input id="agent-timeout" inputMode="numeric" value={draft.timeoutMinutes} placeholder="Default" onChange={(event) => set("timeoutMinutes", event.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="field full">
            <div className="check">
              <Switch checked={draft.openPullRequest} onChange={(value) => set("openPullRequest", value)} label="Push and open pull requests" />
              Push changes and open or update a pull request
            </div>
            <div className="check">
              <Switch checked={draft.exposeGithubToken} onChange={(value) => set("exposeGithubToken", value)} label="Give the agent a GitHub token" />
              Give the agent a GitHub token (GH_TOKEN) for this repository
            </div>
            <div className="check">
              <Switch checked={draft.enabled} onChange={(value) => set("enabled", value)} label="Enabled" />
              Enabled
            </div>
          </div>
        </div>
      </fieldset>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}
