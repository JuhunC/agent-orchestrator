import { useState } from "react";
import { useApi, type AgentsResponse } from "../api.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Empty, Panel } from "../components/ui.tsx";

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
    <div className="row">
      {items.map((item) => (
        <button key={item.name} className={`small${selected === item.name ? " primary" : ""}`} title={item.description} onClick={() => onSelect(item.name)}>
          {item.name}
        </button>
      ))}
      <span className="grow" />
      <input placeholder={placeholder} value={name} onChange={(event) => setName(event.target.value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} style={{ width: 180 }} />
      <button className="small" disabled={!name} onClick={() => (onSelect(name), setName(""))}>
        Add
      </button>
    </div>
  );
}

export function Library() {
  const { data, reload } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents");
  const [skill, setSkill] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <div className="stack">
      <div className="page-head">
        <span className="sub">
          Shared building blocks in <code>{data.profilesDir}/library</code>. Agents opt in by listing them in their agent.md.
        </span>
      </div>

      <Panel title="Skills" hint="folders with a SKILL.md; agents list them under skills">
        <div className="stack" style={{ gap: 10 }}>
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
        </div>
      </Panel>

      <Panel title="Roles (subagents)" hint="the main agent can delegate to these; agents list them under subagents">
        <div className="stack" style={{ gap: 10 }}>
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
        </div>
      </Panel>

      <Panel title="MCP servers" hint="library/mcp.json; agents list server names under mcp">
        <FileEditor path="library/mcp.json" initial={'{\n  "mcpServers": {}\n}\n'} rows={16} onSaved={() => void reload()} />
        <p className="meta">
          Same format as Claude Code's .mcp.json. Use <code>{"${NAME}"}</code> for secrets from the server's environment. The name <code>github</code> is reserved for the
          orchestrator's own tools.
        </p>
      </Panel>
    </div>
  );
}
