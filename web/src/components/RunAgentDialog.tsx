import { useEffect, useState } from "react";
import { Button, Code, Grid, GridSpan, Selector, TextArea, TextInput, VStack } from "@astryxdesign/core";
import { api, type Agent, type BaseChoice, type Installation } from "../api.ts";
import { navigate } from "../router.ts";
import { Dialog, ErrorText, Meta, SuggestInput } from "./ui.tsx";

export function RunAgentDialog({ agents, initialAgent, onClose }: { agents: Agent[]; initialAgent?: string; onClose: () => void }) {
  const enabled = agents.filter((agent) => agent.enabled);
  const [agent, setAgent] = useState(initialAgent ?? enabled[0]?.name ?? "");
  const [repo, setRepo] = useState("");
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState("auto");
  const [instruction, setInstruction] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [priority, setPriority] = useState("normal");
  const [usual, setUsual] = useState<BaseChoice | null>(null);
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

  // What a pull request would go into without a base branch here (boards aren't involved in a run started here).
  useEffect(() => {
    if (!agent || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return setUsual(null);
    let current = true;
    api
      .get<BaseChoice>(`/api/base-branches/resolve?agent=${encodeURIComponent(agent)}&repo=${encodeURIComponent(repo)}`)
      .then((choice) => current && setUsual(choice))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [agent, repo]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.post<{ id: number }>("/api/tasks", { agent, repo, number: Number(number), kind, instruction, baseBranch: baseBranch || null, priority });
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
      width={640}
      onClose={onClose}
      footer={
        <>
          <Button label="Cancel" onClick={onClose} />
          <Button label={busy ? "Starting…" : "Start agent"} variant="primary" isDisabled={!valid || busy} onClick={() => void submit()} />
        </>
      }
    >
      <Grid columns={{ minWidth: 230 }} gap={4}>
        <Selector label="Agent" options={enabled.map((candidate) => ({ value: candidate.name, label: `${candidate.name} (@${candidate.handle})` }))} value={agent} onChange={(value) => setAgent(value ?? "")} />
        <SuggestInput label="Repository" placeholder="owner/repo" suggestions={repos} value={repo} onChange={(value) => setRepo(value.trim())} />
        <TextInput label="Issue, PR or discussion number" placeholder="42" value={number} onChange={(value) => setNumber(value.replace(/\D/g, ""))} />
        <Selector
          label="Type"
          options={[
            { value: "auto", label: "Issue or PR (detect)" },
            { value: "discussion", label: "Discussion" },
          ]}
          value={kind}
          onChange={(value) => setKind(value ?? "auto")}
        />
        <VStack gap={1}>
          <TextInput label="Base branch" isOptional placeholder={usual?.branch ?? "the repository's default branch"} value={baseBranch} onChange={(value) => setBaseBranch(value.trim())} />
          <Meta block>
            Where a pull request from this run goes.{" "}
            {usual?.branch ? (
              <>
                Left empty: <Code size="inherit">{usual.branch}</Code> (set {usual.from}).
              </>
            ) : (
              "Left empty: the repository's default branch."
            )}{" "}
            A pull request you start it on keeps its own base.
          </Meta>
        </VStack>
        <VStack gap={1}>
          <Selector
            label="Priority"
            options={[
              { value: "high", label: "High" },
              { value: "normal", label: "Normal" },
              { value: "low", label: "Low" },
            ]}
            value={priority}
            onChange={(value) => setPriority(value ?? "normal")}
          />
          <Meta block>When agents are busy: high starts before everything else that's waiting, low after it.</Meta>
        </VStack>
        <GridSpan columns="full">
          <TextArea
            label="Instruction"
            rows={5}
            placeholder="What should the agent do?"
            value={instruction}
            onChange={setInstruction}
            description="The agent posts its progress and reply on the thread, as if it had been mentioned there."
          />
        </GridSpan>
      </Grid>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
