import { useState } from "react";
import { Button, Code, Grid, HStack, StackItem, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, TextInput, VStack } from "@astryxdesign/core";
import { api, useApi, type Agent, type AgentsResponse } from "../api.ts";
import { DuplicateDialog } from "../components/DuplicateDialog.tsx";
import { RunAgentDialog } from "../components/RunAgentDialog.tsx";
import { Chips, DataTable, Dialog, Empty, ErrorText, Lines, LinkButton, Meta, Notice, Panel, Pill, Switch, Tag } from "../components/ui.tsx";
import { navigate } from "../router.ts";

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
          <Button label="Cancel" onClick={onClose} />
          <Button label="Create" variant="primary" isDisabled={!name.trim() || handle.length < 2} onClick={() => void create()} />
        </>
      }
    >
      <Grid columns={{ minWidth: 220 }} gap={4}>
        <TextInput label="Name" placeholder="frontend" value={name} onChange={setName} description="Folder name and branch prefix: agent/<name>/…" />
        <TextInput label="GitHub handle" value={handle} onChange={setHandle} description="What people @-mention. Pick a login nobody owns." />
      </Grid>
      <Meta block>This creates profiles/agents/{name || "<name>"}/agent.md from a template; you'll edit its role, skills and tools next.</Meta>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}

export function Agents() {
  const { data, reload } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents" || message.type === "task");
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<Agent | null>(null);

  const toggle = async (agent: Agent, enabled: boolean) => {
    await api.post(`/api/agents/${encodeURIComponent(agent.name)}/enabled`, { enabled });
    void reload();
  };

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <Text color="secondary">
            Each agent is a folder in <Code size="inherit">{`${data?.profilesDir ?? "profiles"}/agents`}</Code>: a role, skills, MCP servers and subagents. Mention its handle on GitHub to start it.
          </Text>
        </StackItem>
        <HStack gap={2} wrap="wrap">
          <LinkButton to="/groups" label="Groups" />
          <LinkButton to="/library" label="Shared library" />
          <Button label="New agent" variant="primary" onClick={() => setCreating(true)} />
        </HStack>
      </HStack>
      {data?.errors.length ? (
        <Notice tone="error" title="Some agent files have problems">
          <Lines items={data.errors} />
        </Notice>
      ) : null}
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.agents.length === 0 ? (
          <Empty>No agents yet. Create one, or add a folder under profiles/agents.</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>On</TableHeaderCell>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableHeaderCell>Groups</TableHeaderCell>
                <TableHeaderCell>Skills</TableHeaderCell>
                <TableHeaderCell>MCP</TableHeaderCell>
                <TableHeaderCell>Subagents</TableHeaderCell>
                <TableHeaderCell>Runs</TableHeaderCell>
                <TableHeaderCell>
                  <span />
                </TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.agents.map((agent) => (
                <TableRow key={agent.name} className="ao-clickable" onClick={() => navigate(`/agents/${agent.name}`)}>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <Switch checked={agent.enabled} disabled={!agent.enabledInFile} onChange={(value) => void toggle(agent, value)} label={`Turn ${agent.name} ${agent.enabled ? "off" : "on"}`} />
                  </TableCell>
                  <TableCell>
                    <VStack gap={0.5}>
                      <HStack gap={1.5} vAlign="center" wrap="wrap">
                        <Text weight="semibold">{agent.name}</Text>
                        {agent.live && <Tag accent>live</Tag>}
                        {agent.triage && (
                          <span title="The triage agent (Settings → Routing): new issues that name no agent come to it, and it passes each to the agent that fits">
                            <Tag accent>triage</Tag>
                          </span>
                        )}
                        {agent.replicas ? <Tag>{`×${agent.replicas}`}</Tag> : null}
                        {agent.errors.length > 0 && (
                          <Pill tone="failed">
                            {agent.errors.length} problem{agent.errors.length === 1 ? "" : "s"}
                          </Pill>
                        )}
                      </HStack>
                      <Meta>
                        @{agent.handle}
                        {agent.account?.login && agent.account.login.toLowerCase() !== agent.handle.toLowerCase() && ` · acts as @${agent.account.login}`}
                        {agent.account?.login && agent.account.login.toLowerCase() === agent.handle.toLowerCase() && " · own GitHub account"}
                        {agent.model && ` · ${agent.model}`}
                        {agent.description && ` · ${agent.description}`}
                      </Meta>
                    </VStack>
                  </TableCell>
                  <TableCell>
                    <Chips items={agent.groups} />
                  </TableCell>
                  <TableCell>
                    <Chips items={[...agent.skills, ...agent.ownSkills.map((skill) => skill.name)]} />
                  </TableCell>
                  <TableCell>
                    <Chips items={["github", ...agent.mcp, ...agent.ownMcp]} />
                  </TableCell>
                  <TableCell>
                    <Chips items={agent.subagents} />
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" textWrap="nowrap">
                      {agent.stats ? `${agent.stats.succeeded} done · ${agent.stats.failed} failed` : "—"}
                    </Text>
                  </TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <HStack gap={2}>
                      <Button label="Run…" size="sm" isDisabled={!agent.enabled || agent.errors.length > 0} onClick={() => setRunning(agent.name)} />
                      <Button label="Duplicate" size="sm" onClick={() => setDuplicating(agent)} />
                    </HStack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>
      {creating && <NewAgentDialog onClose={() => setCreating(false)} />}
      {running && data && <RunAgentDialog agents={data.agents} initialAgent={running} onClose={() => setRunning(null)} />}
      {duplicating && data && (
        <DuplicateDialog
          agent={duplicating}
          groups={data.groups}
          onClose={() => setDuplicating(null)}
          onDone={(created) => (created.length === 1 ? navigate(`/agents/${created[0]}`) : void reload())}
        />
      )}
    </VStack>
  );
}
