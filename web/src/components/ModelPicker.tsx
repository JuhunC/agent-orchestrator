import { useEffect, useState } from "react";
import { api, EFFORTS, type Effort } from "../api.ts";

const SUGGESTED_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "opus", "sonnet", "haiku"];

const EFFORT_HELP: Record<Effort, string> = {
  low: "fast and cheap; simple tasks",
  medium: "balanced",
  high: "thorough; most coding work",
  xhigh: "very thorough; hard problems",
  max: "maximum reasoning; costs the most",
};

/** Chooses the model and effort an agent runs with; saved into its agent.md. */
export function ModelPicker({ agent, model, effort, defaultModel, onSaved }: { agent: string; model: string | null; effort: Effort | null; defaultModel: string | null; onSaved: () => void }) {
  const [nextModel, setNextModel] = useState(model ?? "");
  const [nextEffort, setNextEffort] = useState<string>(effort ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setNextModel(model ?? "");
    setNextEffort(effort ?? "");
  }, [model, effort]);
  const dirty = nextModel.trim() !== (model ?? "") || nextEffort !== (effort ?? "");

  const save = async () => {
    setError(null);
    try {
      await api.patch(`/api/agents/${encodeURIComponent(agent)}`, { model: nextModel.trim() || null, effort: nextEffort || null });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`model-${agent}`}>Model</label>
          <input
            id={`model-${agent}`}
            list="model-suggestions"
            placeholder={defaultModel ? `default: ${defaultModel}` : "default model"}
            value={nextModel}
            onChange={(event) => (setNextModel(event.target.value), setSaved(false))}
          />
          <datalist id="model-suggestions">
            {SUGGESTED_MODELS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <span className="help">Any name your model service accepts. Empty uses ANTHROPIC_MODEL.</span>
        </div>
        <div className="field">
          <label htmlFor={`effort-${agent}`}>Effort</label>
          <select id={`effort-${agent}`} value={nextEffort} onChange={(event) => (setNextEffort(event.target.value), setSaved(false))}>
            <option value="">Model default</option>
            {EFFORTS.map((level) => (
              <option key={level} value={level}>
                {level} — {EFFORT_HELP[level]}
              </option>
            ))}
          </select>
          <span className="help">How hard the model thinks. Board columns can override both.</span>
        </div>
      </div>
      <div className="row">
        <button className="primary small" disabled={!dirty} onClick={save}>
          Save model and effort
        </button>
        {saved && !dirty && <span className="meta">Saved to agent.md</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
