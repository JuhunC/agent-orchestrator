import { useState } from "react";
import { Button, Code, HStack, StackItem, Text, TextInput, VStack } from "@astryxdesign/core";
import { useApi, type AgentsResponse } from "../api.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Empty, Meta, Panel } from "../components/ui.tsx";

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: When agents should use this skill
---
# ${name}

Instructions, conventions or a checklist the agent follows. Put scripts or reference files
next to this SKILL.md and point to them here.
`;

const ROLE_TEMPLATE = `---
description: When the main agent should hand work to this subagent
tools: [Read, Grep, Glob, Bash]
# model: sonnet
---
You are a specialist who…
`;

function Picker({ items, selected, onSelect, placeholder }: { items: { name: string; description: string }[]; selected: string | null; onSelect: (name: string) => void; placeholder: string }) {
  const [name, setName] = useState("");
  return (
    <HStack gap={2} wrap="wrap" vAlign="center">
      {items.map((item) => (
        <Button key={item.name} label={item.name} size="sm" variant={selected === item.name ? "primary" : "secondary"} tooltip={item.description || undefined} onClick={() => onSelect(item.name)} />
      ))}
      <StackItem size="fill">
        <span />
      </StackItem>
      <TextInput label={placeholder} isLabelHidden size="sm" width={180} placeholder={placeholder} value={name} onChange={(value) => setName(value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
      <Button label="Add" size="sm" isDisabled={!name} onClick={() => (onSelect(name), setName(""))} />
    </HStack>
  );
}

export function Library() {
  const { data, reload } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents");
  const [skill, setSkill] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <VStack gap={4}>
      <Text color="secondary">
        Shared building blocks in <Code size="inherit">{`${data.profilesDir}/library`}</Code>. Agents opt in by listing them in their agent.md.
      </Text>

      <Panel title="Skills" hint="folders with a SKILL.md; agents list them under skills">
        <Picker items={data.library.skills} selected={skill} onSelect={setSkill} placeholder="new-skill-name" />
        {skill && (
          <FileEditor
            key={skill}
            path={`library/skills/${skill}/SKILL.md`}
            initial={SKILL_TEMPLATE(skill)}
            onSaved={() => void reload()}
            onDeleted={() => {
              setSkill(null);
              void reload();
            }}
            deleteLabel="Delete skill"
          />
        )}
      </Panel>

      <Panel title="Roles (subagents)" hint="the main agent can delegate to these; agents list them under subagents">
        <Picker items={data.library.roles} selected={role} onSelect={setRole} placeholder="new-role-name" />
        {role && (
          <FileEditor
            key={role}
            path={`library/roles/${role}.md`}
            initial={ROLE_TEMPLATE}
            rows={12}
            onSaved={() => void reload()}
            onDeleted={() => {
              setRole(null);
              void reload();
            }}
          />
        )}
      </Panel>

      <Panel title="MCP servers" hint="library/mcp.json; agents list server names under mcp">
        <FileEditor path="library/mcp.json" initial={'{\n  "mcpServers": {}\n}\n'} rows={16} onSaved={() => void reload()} />
        <Meta block>
          Same format as Claude Code's .mcp.json. Use <Code size="inherit">{"${NAME}"}</Code> for secrets from the server's environment. The name <Code size="inherit">github</Code> is reserved for the orchestrator's own tools.
        </Meta>
      </Panel>
    </VStack>
  );
}
