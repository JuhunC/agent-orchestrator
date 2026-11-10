import { useState } from "react";
import { Button, CheckboxInput, Code, Field, Grid, Heading, HStack, Selector, StackItem, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, TextInput, VStack } from "@astryxdesign/core";
import { api, EFFORTS, useApi, type AgentsResponse, type Group } from "../api.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { SUGGESTED_MODELS } from "../components/ModelPicker.tsx";
import { Chips, DataTable, Dialog, Empty, ErrorText, LinkButton, Meta, Notice, Panel, Pill, SuggestInput } from "../components/ui.tsx";
import { navigate } from "../router.ts";

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
          <Button label="Cancel" onClick={onClose} />
          <Button label="Create" variant="primary" isDisabled={!name} onClick={() => void create()} />
        </>
      }
    >
      <TextInput
        label="Name"
        placeholder="developers"
        value={name}
        onChange={(value) => setName(value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())}
        description={`Use it in a board column as group:${name || "<name>"}`}
      />
      <Field label="Members" inputID="group-members" isGroupLabel>
        <HStack gap={4} wrap="wrap">
          {agents.map((agent) => (
            <CheckboxInput
              key={agent}
              label={agent}
              value={members.includes(agent)}
              onChange={(checked) => setMembers((current) => (checked ? [...current, agent] : current.filter((member) => member !== agent)))}
            />
          ))}
        </HStack>
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}

export function Groups() {
  const { data } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents");
  const [creating, setCreating] = useState(false);
  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <Text color="secondary">
            Groups bundle agents: members inherit the group's defaults (model, effort, skills, MCP servers, subagents), a board column can take a whole group, and you can change every member at once.
          </Text>
        </StackItem>
        <Button label="New group" variant="primary" onClick={() => setCreating(true)} />
      </HStack>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.groups.length === 0 ? (
          <Empty>No groups yet.</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Group</TableHeaderCell>
                <TableHeaderCell>Members</TableHeaderCell>
                <TableHeaderCell>Defaults</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.groups.map((group) => (
                <TableRow key={group.name} className="ao-clickable" onClick={() => navigate(`/groups/${group.name}`)}>
                  <TableCell>
                    <VStack gap={0.5}>
                      <HStack gap={1.5} vAlign="center">
                        <Text weight="semibold">{group.name}</Text>
                        {group.errors.length > 0 && <Pill tone="failed">problems</Pill>}
                      </HStack>
                      <Meta>{group.description}</Meta>
                    </VStack>
                  </TableCell>
                  <TableCell>
                    <Chips items={group.members} empty="none" />
                  </TableCell>
                  <TableCell>
                    <Meta>{defaultsText(group)}</Meta>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>
      {creating && data && <NewGroupDialog agents={data.agents.map((agent) => agent.name)} onClose={() => setCreating(false)} />}
    </VStack>
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
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>{group.name}</Heading>
            <Meta>use as group:{group.name}</Meta>
          </HStack>
        </StackItem>
        <LinkButton to="/groups" label="All groups" />
      </HStack>
      {group.errors.length > 0 && <Notice tone="error" title={group.errors.join(" · ")} />}

      <Panel title="Members" hint={`${members.length} agent${members.length === 1 ? "" : "s"}`} tight>
        {members.length === 0 ? (
          <Empty>No members. Add agent names under members in the file below.</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableHeaderCell>Model · effort</TableHeaderCell>
                <TableHeaderCell>On</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((agent) => (
                <TableRow key={agent.name} className="ao-clickable" onClick={() => navigate(`/agents/${agent.name}`)}>
                  <TableCell>
                    <VStack gap={0.5}>
                      <Text weight="semibold">{agent.name}</Text>
                      <Meta>@{agent.handle}</Meta>
                    </VStack>
                  </TableCell>
                  <TableCell>
                    <Meta>
                      {agent.model ?? "default"}
                      {agent.modelFrom === "group" && " (group)"} · {agent.effort ?? "default"}
                      {agent.effortFrom === "group" && " (group)"}
                    </Meta>
                  </TableCell>
                  <TableCell>{agent.enabled ? <Pill tone="succeeded">on</Pill> : <Pill tone="off">off</Pill>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>

      <Panel title="Change every member at once" hint="writes each member's agent.md">
        <Grid columns={{ minWidth: 240 }} gap={4}>
          <SuggestInput label="Model" placeholder="e.g. claude-sonnet-5-5 (empty clears it)" suggestions={SUGGESTED_MODELS} value={model} onChange={setModel} />
          <Selector
            label="Effort"
            options={[{ value: "", label: "Model default (clears it)" }, ...EFFORTS.map((level) => ({ value: level, label: level }))]}
            value={effort}
            placeholder="Model default (clears it)"
            onChange={(value) => setEffort(value ?? "")}
          />
        </Grid>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button label="Apply model and effort to all" size="sm" variant="primary" onClick={() => void apply({ model: model.trim() || null, effort: effort || null }, "Set model and effort")} />
          <Button label="Turn all on" size="sm" onClick={() => void apply({ enabled: true }, "Turned on")} />
          <Button label="Turn all off" size="sm" variant="destructive" onClick={() => void apply({ enabled: false }, "Turned off")} />
          {status && <Meta>{status}</Meta>}
          {error && <ErrorText>{error}</ErrorText>}
        </HStack>
        <Meta block>
          To make members inherit instead (so later members get it too), set it under <Code size="inherit">defaults</Code> in the group file; an agent's own setting still wins.
        </Meta>
      </Panel>

      <Panel title={`groups/${group.name}.yaml`} hint="members and shared defaults">
        <FileEditor path={`groups/${group.name}.yaml`} rows={14} onSaved={() => void reload()} onDeleted={() => navigate("/groups")} deleteLabel="Delete group" />
        <Meta block>
          Example: <Code size="inherit">{"members: [coder, coder-2]"}</Code> and <Code size="inherit">{"defaults: { model: sonnet, effort: high, skills: [shipping-changes] }"}</Code>
        </Meta>
      </Panel>
    </VStack>
  );
}
