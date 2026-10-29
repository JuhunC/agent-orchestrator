import { useState } from "react";
import { api, useApi, type AgentsResponse, type GithubPermissions, type ModelInfo } from "../api.ts";
import { DuplicateDialog } from "../components/DuplicateDialog.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { FileEditor } from "../components/FileEditor.tsx";
import { AgentUsage } from "../components/Usage.tsx";
import { Empty, Panel, Pill } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";
import { Chips } from "./Agents.tsx";

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: When the agent should use this skill
---
# ${name}

Step-by-step instructions for the agent.
`;

const MCP_TEMPLATE = `{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_TOKEN": "\${SOME_TOKEN}" }
    }
  }
}
`;

/** What the agent may do on GitHub, as short labels. */
export function githubPermissions(github: GithubPermissions): string[] {
  const on = (allowed: boolean, label: string) => (allowed ? [label] : []);
  return [
    ...on(github.comment, "comment"),
    ...on(github.updateIssue, "edit issues"),
    ...on(github.review, "review"),
    ...on(github.push, "push"),
    ...on(github.pullRequest, "open PRs"),
    ...on(github.clone, "clone"),
    ...on(github.finalize, "finalize"),
    ...(github.wiki !== "none" ? [`wiki: ${github.wiki}`] : []),
    ...(github.subIssues !== "none" ? [`sub-issues: ${github.subIssues}`] : []),
    ...on(github.relations, "link issues"),
    ...on(github.mergeIntoParent, "merge into parent"),
    ...(github.startRelated?.length ? [github.startRelated.length === 4 ? "start related agents" : `start agents: ${github.startRelated.map((relation) => relation.replace("_", "-")).join(", ")}`] : []),
  ];
}

export function AgentDetail({ name }: { name: string }) {
  const { data, reload } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents");
  const modelInfo = useApi<ModelInfo>("/api/model").data;
  const [skill, setSkill] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [newSkill, setNewSkill] = useState("");
  if (!data) return <Empty>Loading…</Empty>;
  const agent = data.agents.find((candidate) => candidate.name === name);
  if (!agent) return <Empty>No agent called {name}. It may have been deleted.</Empty>;
  const base = `agents/${agent.name}`;
  const permissions = githubPermissions(agent.github);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="grow">
          {agent.name} <span className="meta">@{agent.handle}</span>
        </h1>
        <button onClick={() => setDuplicating(true)}>Duplicate</button>
        <a className="button" href={href("/agents")}>
          All agents
        </a>
      </div>

      {agent.errors.length > 0 && (
        <div className="banner error">
          <span>
            <b>This agent won't start until these are fixed:</b>
            {agent.errors.map((error) => (
              <div key={error}>{error}</div>
            ))}
          </span>
        </div>
      )}

      <div className="grid-2">
        <Panel title="What it gets" hint="resolved from the files below">
          <dl className="kv">
            <dt>Model</dt>
            <dd>
              {agent.model ?? <span className="meta">default ({modelInfo?.model ?? "ANTHROPIC_MODEL"})</span>}
              {agent.modelFrom === "group" && <span className="meta"> (from group)</span>}
              {agent.effort && <span className="meta"> · effort {agent.effort}{agent.effortFrom === "group" ? " (from group)" : ""}</span>}
            </dd>
            <dt>Groups</dt>
            <dd>
              {agent.groups.length ? agent.groups.map((group) => (
                <a key={group} className="badge accent" href={href(`/groups/${group}`)} style={{ marginRight: 4 }}>
                  {group}
                </a>
              )) : <span className="meta">none</span>}
            </dd>
            <dt>Replicas</dt>
            <dd>{agent.replicas ? `${agent.replicas} (works up to ${agent.replicas} cards at once)` : <span className="meta">no limit</span>}
            </dd>
            <dt>Skills</dt>
            <dd>
              <Chips items={[...agent.skills, ...agent.ownSkills.map((own) => own.name)]} empty="none" />
            </dd>
            <dt>MCP servers</dt>
            <dd>
              <Chips items={["github", ...agent.mcp, ...agent.ownMcp]} />
            </dd>
            <dt>Subagents</dt>
            <dd>
              <Chips items={agent.subagents} empty="none" />
            </dd>
            <dt>Built-in tools</dt>
            <dd>
              {agent.toolsAllow ? <Chips items={agent.toolsAllow} /> : "all Claude Code tools"}
              {agent.toolsDeny.length > 0 && (
                <div className="meta">
                  except <Chips items={agent.toolsDeny} />
                </div>
              )}
            </dd>
            <dt>GitHub</dt>
            <dd>
              <Chips items={permissions} empty="read only" />
            </dd>
            <dt>Sub-issues</dt>
            <dd>
              {agent.github.parentBranch ? (
                <span title="github.parent_branch">branch from and merge into the parent issue's branch</span>
              ) : (
                <span className="meta" title="github.parent_branch: false">merge into the default branch, like any issue</span>
              )}
            </dd>
            <dt>Limits</dt>
            <dd>
              {[agent.maxTurns && `${agent.maxTurns} turns`, agent.maxBudgetUsd && `$${agent.maxBudgetUsd}`, agent.timeoutMinutes && `${agent.timeoutMinutes} min`].filter(Boolean).join(" · ") ||
                "defaults"}
            </dd>
            <dt>Session</dt>
            <dd>{agent.live ? <Pill tone="running">live between tasks</Pill> : "new process per task"}</dd>
          </dl>
        </Panel>
        <Panel title="Shared library" hint="what this agent can reference">
          <div className="stack" style={{ gap: 8 }}>
            <div>
              <span className="meta">Skills: </span>
              <Chips items={data.library.skills.map((item) => item.name)} empty="none yet" />
            </div>
            <div>
              <span className="meta">Roles: </span>
              <Chips items={data.library.roles.map((item) => item.name)} empty="none yet" />
            </div>
            <div>
              <span className="meta">MCP servers: </span>
              <Chips items={data.library.mcp.map((item) => item.name)} empty="none yet" />
            </div>
            <p className="meta" style={{ margin: 0 }}>
              List names from the library under <code>skills</code>, <code>mcp</code> and <code>subagents</code> in agent.md. <a href={href("/library")}>Edit the library</a>.
            </p>
          </div>
        </Panel>
      </div>

      <AgentUsage agent={agent.name} />

      <Panel title="Model and effort">
        <ModelPicker agent={agent.name} model={agent.model} effort={agent.effort} defaultModel={modelInfo?.model ?? null} onSaved={() => void reload()} />
      </Panel>

      {duplicating && <DuplicateDialog agent={agent} groups={data.groups} onClose={() => setDuplicating(false)} onDone={(created) => (created.length === 1 ? navigate(`/agents/${created[0]}`) : void reload())} />}

      <Panel title="agent.md" hint="frontmatter settings, then the role prompt">
        <FileEditor path={`${base}/agent.md`} rows={22} onSaved={() => void reload()} onDeleted={() => navigate("/agents")} deleteLabel="Delete agent" />
      </Panel>

      <Panel
        title="Own skills"
        hint="only this agent has these"
        actions={
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input placeholder="new-skill-name" value={newSkill} onChange={(event) => setNewSkill(event.target.value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} style={{ width: 180 }} />
            <button className="small" disabled={!newSkill} onClick={() => (setSkill(newSkill), setNewSkill(""))}>
              Add skill
            </button>
          </div>
        }
      >
        <div className="stack" style={{ gap: 10 }}>
          <div className="row">
            {agent.ownSkills.length === 0 && !skill && <span className="meta">None. Library skills are usually enough; add one here for things only this agent does.</span>}
            {agent.ownSkills.map((own) => (
              <button key={own.name} className={`small${skill === own.name ? " primary" : ""}`} onClick={() => setSkill(own.name)} title={own.description}>
                {own.name}
              </button>
            ))}
          </div>
          {skill && (
            <FileEditor
              key={skill}
              path={`${base}/skills/${skill}/SKILL.md`}
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

      <Panel title="Own MCP servers" hint="mcp.json; added to the library servers it lists">
        <FileEditor path={`${base}/mcp.json`} initial={MCP_TEMPLATE} rows={12} onSaved={() => void reload()} onDeleted={() => void reload()} />
        <p className="meta">
          <code>{"${NAME}"}</code> is replaced with the server's environment variable, so secrets stay out of the files. Remote servers use <code>"url"</code> and{" "}
          <code>"headers"</code>. Add <code>"alwaysLoad": true</code> to show a server's tools without tool search.
        </p>
      </Panel>

      <div className="row">
        <button
          className="small"
          onClick={async () => {
            await api.post(`/api/agents/${encodeURIComponent(agent.name)}/enabled`, { enabled: !agent.enabled });
            void reload();
          }}
        >
          {agent.enabled ? "Turn off" : "Turn on"}
        </button>
      </div>
    </div>
  );
}
