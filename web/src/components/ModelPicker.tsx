import { useEffect, useState } from "react";
import { Button, Grid, HStack, Selector } from "@astryxdesign/core";
import { api, EFFORTS, type Effort } from "../api.ts";
import { ErrorText, Meta, SuggestInput } from "./ui.tsx";

export const SUGGESTED_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "opus", "sonnet", "haiku"];

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
    <>
      <Grid columns={{ minWidth: 260 }} gap={4}>
        <SuggestInput
          label="Model"
          suggestions={SUGGESTED_MODELS}
          placeholder={defaultModel ? `default: ${defaultModel}` : "default model"}
          value={nextModel}
          onChange={(value) => (setNextModel(value), setSaved(false))}
          description="Any name your model service accepts. Empty uses ANTHROPIC_MODEL."
        />
        <Selector
          label="Effort"
          description="How hard the model thinks. Board columns can override both."
          options={[{ value: "", label: "Model default" }, ...EFFORTS.map((level) => ({ value: level, label: level, description: EFFORT_HELP[level] }))]}
          value={nextEffort}
          placeholder="Model default"
          onChange={(value) => (setNextEffort(value ?? ""), setSaved(false))}
        />
      </Grid>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button label="Save model and effort" size="sm" variant="primary" isDisabled={!dirty} onClick={() => void save()} />
        {saved && !dirty && <Meta>Saved to agent.md</Meta>}
        {error && <ErrorText>{error}</ErrorText>}
      </HStack>
    </>
  );
}
