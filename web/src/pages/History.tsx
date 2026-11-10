import { Blockquote, Button, Divider, Heading, HStack, StackItem, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, VStack } from "@astryxdesign/core";
import { api, ago, duration, KIND_LABEL, useApi, type Task, type ThreadKind, type ThreadSummary } from "../api.ts";
import { A, DataTable, Empty, LinkButton, Meta, Notice, Panel, StatusPill, Tag, who } from "../components/ui.tsx";
import { navigate } from "../router.ts";

export function History() {
  const { data } = useApi<ThreadSummary[]>("/api/threads", (message) => message.type === "task");
  return (
    <VStack gap={4}>
      <Text color="secondary">
        Everything agents have done, per issue, pull request and discussion. When an agent is mentioned again on a thread, its earlier runs here (and on linked PRs) are given to it as context.
      </Text>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.length === 0 ? (
          <Empty>No agent has worked on anything yet.</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Thread</TableHeaderCell>
                <TableHeaderCell>Agents</TableHeaderCell>
                <TableHeaderCell>Runs</TableHeaderCell>
                <TableHeaderCell>Last activity</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((thread) => (
                <TableRow
                  key={`${thread.owner}/${thread.repo}/${thread.threadKind}/${thread.threadNumber}`}
                  className="ao-clickable"
                  onClick={() => navigate(`/history/${thread.owner}/${thread.repo}/${thread.threadKind}/${thread.threadNumber}`)}
                >
                  <TableCell>
                    <VStack gap={0.5}>
                      <Text weight="medium" maxLines={1}>
                        {thread.threadTitle || "(untitled)"}
                      </Text>
                      <HStack gap={1} vAlign="center">
                        <Tag>{KIND_LABEL[thread.threadKind]}</Tag>
                        <Meta>
                          {thread.owner}/{thread.repo}#{thread.threadNumber}
                        </Meta>
                      </HStack>
                    </VStack>
                  </TableCell>
                  <TableCell>
                    <HStack gap={1} wrap="wrap">
                      {thread.agents.map((agent) => (
                        <Tag key={agent} accent>
                          {agent}
                        </Tag>
                      ))}
                    </HStack>
                  </TableCell>
                  <TableCell>
                    <Text hasTabularNumbers>{thread.taskCount}</Text>
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" textWrap="nowrap">
                      {ago(thread.lastActivity)}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>
    </VStack>
  );
}

interface ThreadDetailData {
  ref: { owner: string; repo: string; kind: ThreadKind; number: number };
  tasks: Task[];
  links: { owner: string; repo: string; kind: ThreadKind; number: number }[];
  workspaces: { agent: string; exists: boolean }[];
}

export function ThreadDetail({ owner, repo, kind, number }: { owner: string; repo: string; kind: string; number: string }) {
  const base = `/api/threads/${owner}/${repo}/${kind}/${number}`;
  const { data, reload } = useApi<ThreadDetailData>(base, (message) => message.type === "task");
  if (!data) return <Empty>Loading…</Empty>;

  const title = data.tasks.find((task) => task.threadTitle)?.threadTitle ?? "";
  const url = data.tasks.find((task) => task.threadUrl)?.threadUrl;
  const agents = [...new Set(data.tasks.map((task) => task.agent))];

  const setMemory = async (agent: string, forgotten: boolean) => {
    await api.post(`${base}/memory`, { agent, forgotten });
    void reload();
  };
  const resetWorkspace = async (agent: string) => {
    if (!confirm(`Delete ${agent}'s checkout for this thread? The next run starts from a fresh clone.`)) return;
    try {
      await api.del(`${base}/workspace?agent=${encodeURIComponent(agent)}`);
      void reload();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Tag>{KIND_LABEL[data.ref.kind]}</Tag>
        <StackItem size="fill">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>{title || `${owner}/${repo}#${number}`}</Heading>
            <Meta>{`${owner}/${repo}#${number}`}</Meta>
          </HStack>
        </StackItem>
        {url && <LinkButton to={url} label="Open on GitHub" external />}
      </HStack>

      {data.links.length > 0 && (
        <Notice
          tone="info"
          title={
            <>
              Linked:{" "}
              {data.links.map((link, index) => (
                <span key={`${link.kind}${link.number}`}>
                  {index > 0 && ", "}
                  <A to={`/history/${link.owner}/${link.repo}/${link.kind}/${link.number}`}>
                    {KIND_LABEL[link.kind]} #{link.number}
                  </A>
                </span>
              ))}
              . Agents see their runs on linked threads too.
            </>
          }
        />
      )}

      <Panel title="Agent memory" hint="what each agent remembers about this thread">
        {agents.map((agent) => {
          const runs = data.tasks.filter((task) => task.agent === agent);
          const remembered = runs.filter((task) => !task.forgotten && task.status !== "queued" && task.status !== "running").length;
          const workspace = data.workspaces.find((entry) => entry.agent === agent);
          return (
            <HStack key={agent} gap={2} vAlign="center" wrap="wrap">
              <Tag accent>{agent}</Tag>
              <StackItem size="fill">
                <Meta>
                  remembers {remembered} of {runs.length} run{runs.length === 1 ? "" : "s"}
                  {workspace?.exists ? " · has a checkout" : ""}
                </Meta>
              </StackItem>
              {remembered > 0 ? <Button label="Forget" size="sm" onClick={() => void setMemory(agent, true)} /> : <Button label="Remember again" size="sm" onClick={() => void setMemory(agent, false)} />}
              <Button label="Reset checkout" size="sm" isDisabled={!workspace?.exists} onClick={() => void resetWorkspace(agent)} />
            </HStack>
          );
        })}
      </Panel>

      <Panel title="Runs" hint={`${data.tasks.length} total, oldest first`} tight>
        <VStack gap={0}>
          {data.tasks.map((task, index) => (
            <VStack key={task.id} gap={0}>
              {index > 0 && <Divider />}
              <VStack gap={2} padding={4}>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <StatusPill status={task.status} />
                  <Text weight="semibold" color={task.forgotten ? "secondary" : undefined}>
                    {task.agent}
                  </Text>
                  <Meta>
                    for {who(task.requestedBy)} · {new Date(task.createdAt).toLocaleString()} · {duration(task.startedAt, task.finishedAt)}
                  </Meta>
                  {task.forgotten && <Tag>forgotten</Tag>}
                  <StackItem size="fill">
                    <span />
                  </StackItem>
                  {task.prUrl && <LinkButton to={task.prUrl} label={`PR #${task.prNumber}`} external size="sm" />}
                  <LinkButton to={`/tasks/${task.id}`} label={`Task #${task.id}`} size="sm" />
                </HStack>
                <Blockquote>
                  <span className="ao-prose">{task.requestText.slice(0, 600)}</span>
                </Blockquote>
                {(task.resultText || task.error) && (
                  <Text color={task.forgotten ? "secondary" : undefined} display="block">
                    <span className="ao-prose">{(task.resultText || task.error || "").slice(0, 1200)}</span>
                  </Text>
                )}
              </VStack>
            </VStack>
          ))}
        </VStack>
      </Panel>
    </VStack>
  );
}
