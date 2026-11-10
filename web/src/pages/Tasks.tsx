import { useState } from "react";
import { Button, HStack, Selector, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, TextInput, VStack } from "@astryxdesign/core";
import { ago, api, duration, useApi, useNow, type AgentsResponse, type Task } from "../api.ts";
import { DataTable, Empty, Meta, Panel, StatusPill, ThreadCell, who } from "../components/ui.tsx";
import { navigate } from "../router.ts";

const PAGE = 50;

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "succeeded", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export function Tasks() {
  const [status, setStatus] = useState("");
  const [agent, setAgent] = useState("");
  const [repo, setRepo] = useState("");
  const [older, setOlder] = useState<Task[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (status) query.set("status", status);
  if (agent) query.set("agent", agent);
  if (/^[^/\s]+\/[^/\s]+$/.test(repo)) query.set("repo", repo);
  const path = `/api/tasks?${query}`;
  const { data } = useApi<Task[]>(path, (message) => message.type === "task");
  const agents = useApi<AgentsResponse>("/api/agents").data?.agents ?? [];
  const now = useNow(5000);

  const tasks = [...(data ?? []), ...older.filter((task) => !(data ?? []).some((current) => current.id === task.id))];

  const loadMore = async () => {
    const last = tasks.at(-1);
    if (!last) return;
    const next = await api.get<Task[]>(`${path}&before=${last.id}`);
    setOlder((current) => [...current, ...next]);
    if (next.length < PAGE) setExhausted(true);
  };

  const resetPaging = () => {
    setOlder([]);
    setExhausted(false);
  };

  return (
    <VStack gap={4}>
      <HStack gap={2} wrap="wrap" vAlign="end">
        <Selector
          label="Status"
          isLabelHidden
          width={180}
          options={STATUSES}
          value={status}
          onChange={(value) => (setStatus(value ?? ""), resetPaging())}
        />
        <Selector
          label="Agent"
          isLabelHidden
          width={180}
          options={[{ value: "", label: "All agents" }, ...agents.map((candidate) => ({ value: candidate.name, label: candidate.name }))]}
          value={agent}
          onChange={(value) => (setAgent(value ?? ""), resetPaging())}
        />
        <TextInput label="Repository" isLabelHidden placeholder="owner/repo" width={220} value={repo} onChange={(value) => (setRepo(value.trim()), resetPaging())} />
      </HStack>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : tasks.length === 0 ? (
          <Empty>No tasks match.</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>#</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableHeaderCell>Thread</TableHeaderCell>
                <TableHeaderCell>Requested by</TableHeaderCell>
                <TableHeaderCell>Took</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id} className="ao-clickable" onClick={() => navigate(`/tasks/${task.id}`)}>
                  <TableCell>
                    <Text type="supporting" hasTabularNumbers>
                      {task.id}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <StatusPill status={task.status} />
                  </TableCell>
                  <TableCell>
                    <Text textWrap="nowrap">{task.agent}</Text>
                  </TableCell>
                  <TableCell>
                    <ThreadCell task={task} />
                  </TableCell>
                  <TableCell>
                    <VStack gap={0.5}>
                      <Text>{who(task.requestedBy)}</Text>
                      <Meta>
                        {task.triggerKind}
                        {task.dryRun ? " · dry run" : ""}
                      </Meta>
                    </VStack>
                  </TableCell>
                  <TableCell>
                    <Text hasTabularNumbers textWrap="nowrap">
                      {duration(task.startedAt, task.finishedAt, now)}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" textWrap="nowrap">
                      {ago(task.createdAt, now)}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>
      {data && tasks.length >= PAGE && !exhausted && (
        <HStack hAlign="center">
          <Button label="Load older tasks" onClick={() => void loadMore()} />
        </HStack>
      )}
    </VStack>
  );
}
