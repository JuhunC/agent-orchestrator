import { useState } from "react";
import { Button, Code, Grid, SegmentedControl, SegmentedControlItem, Selector, TextInput } from "@astryxdesign/core";
import { api, type Agent, type Group } from "../api.ts";
import { Dialog, ErrorText, Meta } from "./ui.tsx";

/** Copies an agent: one named copy to edit, or several identical numbered copies. */
export function DuplicateDialog({ agent, groups, onClose, onDone }: { agent: Agent; groups: Group[]; onClose: () => void; onDone: (created: string[]) => void }) {
  const [mode, setMode] = useState<"one" | "many">("one");
  const [name, setName] = useState(`${agent.name}-copy`);
  const [handle, setHandle] = useState(`${agent.handle}-copy`.slice(0, 39));
  const [count, setCount] = useState("2");
  const [group, setGroup] = useState(agent.groups[0] ?? "");
  const [newGroup, setNewGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const targetGroup = group === "__new" ? newGroup.trim() : group;
      const body = mode === "one" ? { name: name.trim(), handle: handle.trim(), group: targetGroup || undefined } : { count: Number(count), group: targetGroup || undefined };
      const { created } = await api.post<{ created: string[] }>(`/api/agents/${encodeURIComponent(agent.name)}/duplicate`, body);
      onDone(created);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Duplicate ${agent.name}`}
      onClose={onClose}
      footer={
        <>
          <Button label="Cancel" onClick={onClose} />
          <Button
            label={busy ? "Creating…" : mode === "one" ? "Create copy" : `Create ${count} copies`}
            variant="primary"
            isDisabled={busy || (mode === "one" ? !name.trim() || !handle.trim() : !(Number(count) >= 1))}
            onClick={() => void submit()}
          />
        </>
      }
    >
      <SegmentedControl label="Kind of copy" value={mode} onChange={(value) => setMode(value as "one" | "many")} layout="fill">
        <SegmentedControlItem value="one" label="One copy to customise" />
        <SegmentedControlItem value="many" label="Several identical copies" />
      </SegmentedControl>
      {mode === "one" ? (
        <Grid columns={{ minWidth: 200 }} gap={4}>
          <TextInput label="Name" value={name} onChange={(value) => setName(value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
          <TextInput label="GitHub handle" value={handle} onChange={(value) => setHandle(value.replace(/^@/, ""))} />
        </Grid>
      ) : (
        <TextInput
          label="How many"
          width={240}
          value={count}
          onChange={(value) => setCount(value.replace(/\D/g, ""))}
          description={`Named ${agent.name.replace(/-\d+$/, "")}-2, -3, … with handles @${agent.handle.replace(/-\d+$/, "")}-2, -3, …`}
        />
      )}
      <Grid columns={{ minWidth: 200 }} gap={4}>
        <Selector
          label="Add to group"
          options={[{ value: "", label: "No group" }, ...groups.map((candidate) => ({ value: candidate.name, label: candidate.name })), { value: "__new", label: "New group…" }]}
          value={group}
          placeholder="No group"
          onChange={(value) => setGroup(value ?? "")}
        />
        {group === "__new" && <TextInput label="New group name" value={newGroup} onChange={(value) => setNewGroup(value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />}
      </Grid>
      <Meta block>
        Copies get everything: role, skills, MCP servers, subagents, model and effort. To run identical copies without separate folders, set <Code size="inherit">replicas: N</Code> in agent.md instead.
      </Meta>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
