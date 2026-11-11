import { useEffect, useState } from "react";
import { Button, Code, Grid, HStack, Selector, TextInput, VStack } from "@astryxdesign/core";
import { api, useApi, type AgentsResponse, type Settings } from "../api.ts";
import { A, Chips, ErrorText, KV, Meta, Notice, Panel } from "./ui.tsx";

const NOBODY = "(nobody)";
const repoList = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** Settings → Routing: the triage agent for new issues that name no agent, and where it triages. */
export function RoutingPanel({ routing, onSaved }: { routing: Settings["routing"]; onSaved: () => void }) {
  const agents = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents").data?.agents ?? [];
  const [agent, setAgent] = useState(routing.agent ?? NOBODY);
  const [repos, setRepos] = useState(routing.repos.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAgent(routing.agent ?? NOBODY);
    setRepos(routing.repos.join(", "));
  }, [routing.agent, routing.repos.join(",")]);

  const dirty = agent !== (routing.agent ?? NOBODY) || repoList(repos).join(",").toLowerCase() !== routing.repos.join(",");
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put("/api/settings", { routing: { agent: agent === NOBODY ? null : agent, repos: repoList(repos) } });
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  // An agent that was deleted stays in the list until another is chosen, so the choice is visible.
  const names = [...new Set([...agents.map((candidate) => candidate.name), ...(routing.agent ? [routing.agent] : [])])];
  const others = agents.filter((candidate) => candidate.enabled && !candidate.errors.length && candidate.name !== routing.agent);
  const passers = agents.filter((candidate) => candidate.github.route && candidate.name !== routing.agent).map((candidate) => candidate.name);

  return (
    <Panel title="Routing" hint={routing.agent ? `new issues that name no agent go to ${routing.agent}` : "new issues that name no agent start nobody"}>
      <VStack gap={3}>
        {routing.problem && <Notice tone="warning" title={routing.problem} />}
        <Grid columns={{ minWidth: 220 }} gap={4}>
          <Selector
            label="Triage agent"
            options={[{ value: NOBODY, label: "Nobody (off)" }, ...names.map((name) => ({ value: name, label: name }))]}
            value={agent}
            onChange={(value) => setAgent(value ?? NOBODY)}
          />
          <TextInput label="Only in these repositories" isOptional placeholder="all repositories" value={repos} onChange={setRepos} />
        </Grid>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Button label={busy ? "Saving…" : "Save"} isDisabled={!dirty || busy} onClick={() => void save()} />
          <Meta>
            Repositories as <Code size="inherit">owner/name</Code> or <Code size="inherit">owner/*</Code>, separated by commas.
          </Meta>
        </HStack>
        {error && <ErrorText>{error}</ErrorText>}
        <Meta block>
          When someone opens an issue without mentioning or assigning an agent, the triage agent reads it and passes it to the agent whose kind of work it is, with its reason in a comment. It chooses by
          each agent's <Code size="inherit">description</Code> and by how busy each one is, so keep the descriptions on the <A to="/agents">agents' pages</A> exact. An issue it can't place stays with
          a person, and shows under Tasks as blocked.
        </Meta>
        {routing.agent && (
          <KV
            items={[
              ["Can receive work", <Chips items={others.map((candidate) => candidate.name)} empty="no other agent is switched on" />],
              ["May also pass work on", <Chips items={passers} empty="no agent has github.route" />],
            ]}
          />
        )}
      </VStack>
    </Panel>
  );
}
