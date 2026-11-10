import { Code, SegmentedControl, SegmentedControlItem, Switch, VStack } from "@astryxdesign/core";
import { api, useApi, type Agent, type AgentsResponse } from "../api.ts";
import { A, Chips, KV, Meta, Panel } from "./ui.tsx";

/** Settings → Live activity: the default for agents that don't set github.live_activity. */
export function LiveActivityPanel({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const agents = useApi<AgentsResponse>("/api/agents", (message) => message.type === "agents").data?.agents ?? [];
  const always = agents.filter((agent) => agent.github.liveActivity === true).map((agent) => agent.name);
  const never = agents.filter((agent) => agent.github.liveActivity === false).map((agent) => agent.name);
  return (
    <Panel title="Live activity" hint="the comment an agent edits while it works">
      <VStack gap={3}>
        <Switch label={on ? "Agents post live activity" : "Agents only post their result"} value={on} onChange={onChange} />
        <Meta block>
          On: when an agent starts, it posts a comment and keeps it up to date with its steps and latest message. Off: the thread hears from the agent once, when it finishes. An agent's own{" "}
          <Code size="inherit">github.live_activity</Code> wins; change it on the agent's page.
        </Meta>
        {(always.length > 0 || never.length > 0) && (
          <KV
            items={[
              ["Always on", <Chips items={always} empty="none" />],
              ["Always off", <Chips items={never} empty="none" />],
            ]}
          />
        )}
      </VStack>
    </Panel>
  );
}

/** The agent page's choice: follow Settings, or always on or off (github.live_activity). */
export function AgentLiveActivity({ agent, defaultOn, onSaved }: { agent: Agent; defaultOn: boolean; onSaved: () => void }) {
  const value = agent.github.liveActivity === null ? "default" : agent.github.liveActivity ? "on" : "off";
  const save = async (next: string) => {
    await api.patch(`/api/agents/${encodeURIComponent(agent.name)}`, { liveActivity: next === "default" ? null : next === "on" });
    onSaved();
  };
  return (
    <Panel title="Live activity" hint="github.live_activity">
      <SegmentedControl label="Live activity" value={value} onChange={(next) => void save(String(next))} layout="fill">
        <SegmentedControlItem value="default" label={`Settings (${defaultOn ? "on" : "off"})`} />
        <SegmentedControlItem value="on" label="On" />
        <SegmentedControlItem value="off" label="Off" />
      </SegmentedControl>
      <Meta block>
        {agent.liveActivity
          ? "It posts a comment when it starts and edits it as it works, then completes it at the end."
          : "It only posts its result when it finishes: no comment while it works."}{" "}
        {value === "default" && (
          <>
            Change the default in <A to="/settings">Settings</A>.
          </>
        )}
      </Meta>
    </Panel>
  );
}
