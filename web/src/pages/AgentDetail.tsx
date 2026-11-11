import { useState } from "react";
import { Button, Code, Heading, HStack, StackItem, Text, TextInput, VStack } from "@astryxdesign/core";
import { api, useApi, type AgentsResponse, type GithubPermissions, type ModelInfo } from "../api.ts";
import { DuplicateDialog } from "../components/DuplicateDialog.tsx";
import { GithubAccount } from "../components/GithubAccount.tsx";
import { AgentLiveActivity } from "../components/LiveActivity.tsx";
import { Schedules } from "../components/Schedules.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { FileEditor } from "../components/FileEditor.tsx";
import { AgentUsage } from "../components/Usage.tsx";
import { A, Chips, Columns, Empty, KV, Lines, LinkButton, Meta, Notice, Panel, Pill, Tag } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";

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
    ...on(github.route, "pass work to agents"),
    ...(github.startRelated?.length ? [github.startRelated.length === 4 ? "start related agents" : `start agents: ${github.startRelated.map((relation) => relation.replace("_", "-")).join(", ")}`] : []),
  ];
}

export function AgentDetail({ name }: { name: string }) {
  const { data, reload } = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents");
  const modelInfo = useApi<ModelInfo>("/api/model").data;
  const [skill, setSkill] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [newSkill, setNewSkill] = useState("");
  // Bumped when the model picker or live activity choice rewrites agent.md, so its editor shows it.
  const [fileVersion, setFileVersion] = useState(0);
  if (!data) return <Empty>Loading…</Empty>;
  const changedFile = () => {
    void reload();
    setFileVersion((version) => version + 1);
  };
  const agent = data.agents.find((candidate) => candidate.name === name);
  if (!agent) return <Empty>No agent called {name}. It may have been deleted.</Empty>;
  const base = `agents/${agent.name}`;
  const permissions = githubPermissions(agent.github);

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>{agent.name}</Heading>
            <Meta>@{agent.handle}</Meta>
            {agent.triage && <Tag accent>triage</Tag>}
          </HStack>
        </StackItem>
        <Button label="Duplicate" onClick={() => setDuplicating(true)} />
        <LinkButton to="/agents" label="All agents" />
      </HStack>

      {agent.triage && (
        <Notice tone="info" title="This is the triage agent." action={<LinkButton to="/settings" label="Routing" size="sm" />}>
          New issues that name no agent come to it, and it passes each to the agent that fits (route_to_agent). Its prompt lists the other agents with their descriptions and how busy each is.
        </Notice>
      )}

      {agent.errors.length > 0 && (
        <Notice tone="error" title="This agent won't start until these are fixed:">
          <Lines items={agent.errors} />
        </Notice>
      )}

      <Columns>
        <Panel title="What it gets" hint="resolved from the files below">
          <KV
            items={[
              [
                "Model",
                <>
                  {agent.model ?? <Meta>default ({modelInfo?.model ?? "ANTHROPIC_MODEL"})</Meta>}
                  {agent.modelFrom === "group" && <Meta> (from group)</Meta>}
                  {agent.effort && (
                    <Meta>
                      {" "}
                      · effort {agent.effort}
                      {agent.effortFrom === "group" ? " (from group)" : ""}
                    </Meta>
                  )}
                  {agent.fallbackModel && (
                    <span title="fallback_model: used when the model is overloaded or out of usage">
                      <Meta> · falls back to {agent.fallbackModel.split(",").join(", ")}</Meta>
                    </span>
                  )}
                </>,
              ],
              [
                "Groups",
                agent.groups.length ? (
                  <HStack gap={1} wrap="wrap">
                    {agent.groups.map((group) => (
                      <Tag key={group} accent href={href(`/groups/${group}`)}>
                        {group}
                      </Tag>
                    ))}
                  </HStack>
                ) : (
                  <Meta>none</Meta>
                ),
              ],
              ["Replicas", agent.replicas ? `${agent.replicas} (works up to ${agent.replicas} cards at once)` : <Meta>no limit</Meta>],
              ["Skills", <Chips items={[...agent.skills, ...agent.ownSkills.map((own) => own.name)]} empty="none" />],
              ["MCP servers", <Chips items={["github", ...agent.mcp, ...agent.ownMcp]} />],
              ["Subagents", <Chips items={agent.subagents} empty="none" />],
              [
                "Built-in tools",
                <VStack gap={1}>
                  {agent.toolsAllow ? <Chips items={agent.toolsAllow} /> : <Text>all Claude Code tools</Text>}
                  {agent.toolsDeny.length > 0 && (
                    <HStack gap={1} vAlign="center" wrap="wrap">
                      <Meta>except</Meta>
                      <Chips items={agent.toolsDeny} />
                    </HStack>
                  )}
                </VStack>,
              ],
              ["GitHub", <Chips items={permissions} empty="read only" />],
              [
                "Base branch",
                agent.baseBranch ? (
                  <span title="github.base_branch">
                    pull requests go into <Code size="inherit">{agent.baseBranch}</Code> (a board, schedule or run can name another)
                  </span>
                ) : (
                  <span title="github.base_branch">
                    <Meta>
                      the repository's setting (<A to="/settings">Settings</A>) or default branch, unless a board, schedule or run names one
                    </Meta>
                  </span>
                ),
              ],
              [
                "Sub-issues",
                agent.github.parentBranch ? (
                  <span title="github.parent_branch">branch from and merge into the parent issue's branch</span>
                ) : (
                  <span title="github.parent_branch: false">
                    <Meta>merge into the base branch, like any issue</Meta>
                  </span>
                ),
              ],
              ["Limits", [agent.maxTurns && `${agent.maxTurns} turns`, agent.maxBudgetUsd && `$${agent.maxBudgetUsd}`, agent.timeoutMinutes && `${agent.timeoutMinutes} min`].filter(Boolean).join(" · ") || "defaults"],
              ["Session", agent.live ? <Pill tone="running">live between tasks</Pill> : "new process per task"],
            ]}
          />
        </Panel>
        <Panel title="Shared library" hint="what this agent can reference">
          <KV
            items={[
              ["Skills", <Chips items={data.library.skills.map((item) => item.name)} empty="none yet" />],
              ["Roles", <Chips items={data.library.roles.map((item) => item.name)} empty="none yet" />],
              ["MCP servers", <Chips items={data.library.mcp.map((item) => item.name)} empty="none yet" />],
            ]}
          />
          <Meta block>
            List names from the library under <Code size="inherit">skills</Code>, <Code size="inherit">mcp</Code> and <Code size="inherit">subagents</Code> in agent.md. <A to="/library">Edit the library</A>.
          </Meta>
        </Panel>
      </Columns>

      <GithubAccount agent={agent} onChanged={() => void reload()} />

      <Schedules agent={agent.name} />

      <AgentUsage agent={agent.name} />

      <Columns>
        <Panel title="Model and effort">
          <ModelPicker agent={agent.name} model={agent.model} effort={agent.effort} defaultModel={modelInfo?.model ?? null} onSaved={changedFile} />
        </Panel>
        <AgentLiveActivity agent={agent} defaultOn={data.liveActivityDefault ?? false} onSaved={changedFile} />
      </Columns>

      {duplicating && <DuplicateDialog agent={agent} groups={data.groups} onClose={() => setDuplicating(false)} onDone={(created) => (created.length === 1 ? navigate(`/agents/${created[0]}`) : void reload())} />}

      <Panel title="agent.md" hint="frontmatter settings, then the role prompt">
        <FileEditor path={`${base}/agent.md`} rows={22} reloadKey={fileVersion} onSaved={() => void reload()} onDeleted={() => navigate("/agents")} deleteLabel="Delete agent" />
      </Panel>

      <Panel
        title="Own skills"
        hint="only this agent has these"
        actions={
          <HStack gap={2} vAlign="center">
            <TextInput label="New skill name" isLabelHidden size="sm" width={180} placeholder="new-skill-name" value={newSkill} onChange={(value) => setNewSkill(value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
            <Button label="Add skill" size="sm" isDisabled={!newSkill} onClick={() => (setSkill(newSkill), setNewSkill(""))} />
          </HStack>
        }
      >
        <HStack gap={2} wrap="wrap" vAlign="center">
          {agent.ownSkills.length === 0 && !skill && <Meta>None. Library skills are usually enough; add one here for things only this agent does.</Meta>}
          {agent.ownSkills.map((own) => (
            <Button key={own.name} label={own.name} size="sm" variant={skill === own.name ? "primary" : "secondary"} tooltip={own.description || undefined} onClick={() => setSkill(own.name)} />
          ))}
        </HStack>
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
      </Panel>

      <Panel title="Own MCP servers" hint="mcp.json; added to the library servers it lists">
        <FileEditor path={`${base}/mcp.json`} initial={MCP_TEMPLATE} rows={12} onSaved={() => void reload()} onDeleted={() => void reload()} />
        <Meta block>
          <Code size="inherit">{"${NAME}"}</Code> is replaced with the server's environment variable, so secrets stay out of the files. Remote servers use <Code size="inherit">"url"</Code> and <Code size="inherit">"headers"</Code>. Add{" "}
          <Code size="inherit">"alwaysLoad": true</Code> to show a server's tools without tool search.
        </Meta>
      </Panel>

      <HStack>
        <Button
          label={agent.enabled ? "Turn off" : "Turn on"}
          size="sm"
          onClick={async () => {
            await api.post(`/api/agents/${encodeURIComponent(agent.name)}/enabled`, { enabled: !agent.enabled });
            void reload();
          }}
        />
      </HStack>
    </VStack>
  );
}
