import { useEffect, useRef, useState } from "react";
import { Blockquote, Button, CheckboxInput, Code, CodeBlock, Heading, HStack, StackItem, Text, VStack } from "@astryxdesign/core";
import { api, duration, KIND_LABEL, useNow, useStream, type Task, type TaskEvent } from "../api.ts";
import { A, Columns, Empty, KV, Meta, Notice, Panel, StatusPill, Tag, who } from "../components/ui.tsx";
import { navigate } from "../router.ts";

/** Something that happened on GitHub while the agent works, which it hasn't been told yet. */
interface WaitingNote {
  author: string;
  summary: string;
  url: string;
  mention: boolean;
  fromAgent: boolean;
}

/** A task in a chain of agents starting each other. */
interface ChainNode {
  id: number;
  agent: string;
  owner: string;
  repo: string;
  threadKind: Task["threadKind"];
  threadNumber: number;
  threadTitle: string;
  triggerKind: Task["triggerKind"];
  status: Task["status"];
  board: string | null;
  boardColumn: string | null;
  started?: ChainNode[];
}

function ChainRow({ node, depth, current }: { node: ChainNode; depth: number; current?: boolean }) {
  const how =
    node.triggerKind === "agent" ? "started by an agent" : node.triggerKind === "schedule" ? "scheduled run" : node.triggerKind === "board" ? `board stage${node.boardColumn ? ` (${node.boardColumn})` : ""}` : node.triggerKind;
  return (
    <>
      <HStack gap={2} vAlign="center" wrap="wrap" paddingInlineStart={depth === 0 ? 0 : depth === 1 ? 4 : depth === 2 ? 8 : 10}>
        <StatusPill status={node.status} />
        <Text>
          {current ? <b>this task</b> : <A to={`/tasks/${node.id}`}>task #{node.id}</A>} · {node.agent} on {node.owner}/{node.repo}#{node.threadNumber}
          {node.threadTitle ? ` "${node.threadTitle}"` : ""}
        </Text>
        <Meta>· {how}</Meta>
      </HStack>
      {node.started?.map((child) => <ChainRow key={child.id} node={child} depth={depth + 1} />)}
    </>
  );
}

/** Who started whom: the tasks that led to this one, and those it started. */
function Chain({ task, chain }: { task: Task; chain: { ancestors: ChainNode[]; started: ChainNode[] } }) {
  if (!chain.ancestors.length && !chain.started.length) return null;
  return (
    <Panel title="Chain" hint="agents starting agents on related issues, and board stages their moves started">
      <VStack gap={1.5}>
        {chain.ancestors.map((node, index) => (
          <ChainRow key={node.id} node={node} depth={index} />
        ))}
        <ChainRow node={{ ...task, started: chain.started }} depth={chain.ancestors.length} current />
      </VStack>
    </Panel>
  );
}

export function TaskDetail({ id }: { id: number }) {
  const [task, setTask] = useState<Task | null>(null);
  const [chain, setChain] = useState<{ ancestors: ChainNode[]; started: ChainNode[] } | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [inbox, setInbox] = useState<WaitingNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showStderr, setShowStderr] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  useEffect(() => {
    setTask(null);
    setEvents([]);
    api
      .get<{ task: Task; events: TaskEvent[]; inbox: WaitingNote[]; chain?: { ancestors: ChainNode[]; started: ChainNode[] } }>(`/api/tasks/${id}`)
      .then((data) => {
        setTask(data.task);
        setEvents(data.events);
        setInbox(data.inbox);
        setChain(data.chain ?? null);
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

  useStream((message) => {
    if (message.type === "task" && message.task.id === id) setTask(message.task);
    if (message.type === "event" && message.event.taskId === id) {
      setEvents((current) => (current.some((event) => event.id === message.event.id) ? current : [...current, message.event]));
      // GitHub activity arrived for the agent, or it was just handed over: what's waiting changed.
      if (message.event.kind === "github") {
        void api
          .get<{ inbox: WaitingNote[] }>(`/api/tasks/${id}?after=${message.event.id}`)
          .then((data) => setInbox(data.inbox))
          .catch(() => undefined);
      }
    }
  });

  const visible = events.filter((event) => showStderr || event.kind !== "stderr");
  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visible.length, follow]);

  if (error) return <Notice tone="error" title={error} />;
  if (!task) return <Empty>Loading…</Empty>;

  const active = task.status === "running" || task.status === "queued";
  const cancel = () => confirm("Stop this agent?") && void api.post(`/api/tasks/${task.id}/cancel`);
  const retry = async () => {
    const created = await api.post<Task>(`/api/tasks/${task.id}/retry`);
    navigate(`/tasks/${created.id}`);
  };
  const replay = async () => {
    const created = await api.post<Task>(`/api/tasks/${task.id}/replay`);
    navigate(`/tasks/${created.id}`);
  };
  const stderrCount = events.filter((event) => event.kind === "stderr").length;

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StatusPill status={task.status} />
        <StackItem size="fill">
          <Heading level={2}>
            {task.agent} · {task.owner}/{task.repo}#{task.threadNumber}
          </Heading>
        </StackItem>
        {active ? (
          <Button label={task.status === "queued" ? "Remove from queue" : "Stop agent"} variant="destructive" onClick={cancel} />
        ) : (
          <HStack gap={2}>
            <Button label="Run again" onClick={() => void retry()} />
            {!task.dryRun && <Button label="Dry run" tooltip="Run the same request with the agent's current profile, without changing anything on GitHub" onClick={() => void replay()} />}
          </HStack>
        )}
      </HStack>

      {task.dryRun && (
        <Notice
          tone="info"
          title={
            <>
              Dry run{task.retryOf ? <> of <A to={`/tasks/${task.retryOf}`}>task #{task.retryOf}</A></> : null}.
            </>
          }
        >
          The agent worked with its current profile in a checkout of its own, and nothing was changed on GitHub: what it would have posted, pushed or moved is in the log as "Dry run: would …". Compare its
          reply with the original's to judge a profile change.
        </Notice>
      )}

      {task.error && task.status !== "succeeded" && <Notice tone="error" title={task.error} />}
      {task.status === "queued" && task.retryAt && (
        <Notice title="Waiting for the usage limit to reset." action={<Button label="Run now" onClick={() => void api.post(`/api/tasks/${task.id}/run-now`)} />}>
          It continues automatically at {new Date(task.retryAt).toLocaleString()} (attempt {task.attempts + 1}).
        </Notice>
      )}

      {active && inbox.length > 0 && (
        <Notice tone="info" title={`${inbox.length} update${inbox.length === 1 ? "" : "s"} from GitHub waiting for the agent`}>
          <VStack gap={1}>
            <Text>
              {task.status === "running"
                ? "It's told at its next step."
                : "It's told when the task starts again: updates are kept across restarts."}
            </Text>
            {inbox.map((note, index) => (
              <HStack key={index} gap={2} vAlign="center" wrap="wrap">
                <Text>
                  {who(note.author)} {note.summary}
                </Text>
                {note.mention && <Tag>{note.fromAgent ? "from an agent" : "mention"}</Tag>}
                {note.url && (
                  <A to={note.url} external>
                    view
                  </A>
                )}
              </HStack>
            ))}
          </VStack>
        </Notice>
      )}

      {chain && <Chain task={task} chain={chain} />}

      <Columns>
        <Panel title="Request">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Tag>{KIND_LABEL[task.threadKind]}</Tag>
            {task.threadUrl ? (
              <A to={task.threadUrl} external>
                {task.threadTitle || `${task.owner}/${task.repo}#${task.threadNumber}`}
              </A>
            ) : (
              <Text>{task.threadTitle}</Text>
            )}
          </HStack>
          <Blockquote>
            <span className="ao-prose">{task.requestText}</span>
          </Blockquote>
          <Meta block>
            {who(task.requestedBy)} · {task.triggerKind}
            {task.requestUrl && (
              <>
                {" · "}
                <A to={task.requestUrl} external>
                  view on GitHub
                </A>
              </>
            )}
            {task.retryOf && (
              <>
                {task.dryRun ? " · dry run of " : " · retry of "}
                <A to={`/tasks/${task.retryOf}`}>#{task.retryOf}</A>
              </>
            )}
            {task.profileVersion && (
              <span title="The version of the agent's profile that ran this task (see the agent's page for outcomes by version)">
                {" · profile "}
                <Code size="inherit">{task.profileVersion}</Code>
                {task.profileCommit ? ` (commit ${task.profileCommit})` : ""}
              </span>
            )}
            {task.scheduleId && (
              <>
                {" · "}
                <A to="/schedules">schedule #{task.scheduleId}</A>
              </>
            )}
            {task.startedByTask && (
              <>
                {" · started by task "}
                <A to={`/tasks/${task.startedByTask}`}>#{task.startedByTask}</A>
              </>
            )}
          </Meta>
        </Panel>
        <Panel title="Details">
          <KV
            items={[
              ["Task", `#${task.id}`],
              ["Duration", duration(task.startedAt, task.finishedAt, now)],
              ["Branch", task.branch ? <Code size="inherit">{`${task.branch}${task.baseBranch && task.baseBranch !== task.branch ? ` → ${task.baseBranch}` : ""}`}</Code> : "—"],
              [
                "Pull request",
                <>
                  {task.prUrl ? (
                    <A to={task.prUrl} external>
                      #{task.prNumber}
                    </A>
                  ) : (
                    "—"
                  )}
                  {task.commits ? (
                    <Meta>
                      {" "}
                      · {task.commits} commit{task.commits === 1 ? "" : "s"}
                    </Meta>
                  ) : null}
                </>,
              ],
              ["Session", task.sessionId ? <Code size="inherit">{task.sessionId}</Code> : "—"],
              ["Exit code", task.exitCode ?? "—"],
              ...(task.costUsd !== null ? ([["Cost", `$${task.costUsd.toFixed(4)}`]] as [string, string][]) : []),
              ["Thread history", <A to={`/history/${task.owner}/${task.repo}/${task.threadKind}/${task.threadNumber}`}>All runs on this thread</A>],
            ]}
          />
        </Panel>
      </Columns>

      <Panel
        title="Activity"
        hint={active ? "live" : `${events.length} events`}
        tight
        actions={
          <HStack gap={4} vAlign="center">
            <CheckboxInput label={`stderr (${stderrCount})`} size="sm" value={showStderr} onChange={setShowStderr} />
            <CheckboxInput label="Follow" size="sm" value={follow} onChange={setFollow} />
          </HStack>
        }
      >
        <div className="ao-log" ref={logRef}>
          {visible.length === 0 && <div className="ao-log-line">{task.status === "queued" ? "Waiting for a free slot…" : "No activity yet."}</div>}
          {visible.map((event) => (
            <div key={event.id} className={`ao-log-line k-${event.kind}`}>
              <span className="ao-log-time">{event.ts.slice(11, 19)}</span>
              <span className="ao-log-kind">{event.kind}</span>
              <span className="ao-log-message">{event.message}</span>
            </div>
          ))}
        </div>
      </Panel>

      {task.resultText && (
        <Panel title="Agent reply">
          <Text display="block">
            <span className="ao-prose">{task.resultText}</span>
          </Text>
        </Panel>
      )}

      {task.prompt && (
        <Panel
          title="Prompt"
          hint={/left out to keep this prompt short|cut here to keep the prompt short/.test(task.prompt) ? "the thread was too long to fit: the oldest comments were left out" : "what the agent was given, including its history"}
          actions={<Button label={showPrompt ? "Hide" : "Show"} size="sm" onClick={() => setShowPrompt((value) => !value)} />}>
          {showPrompt ? <CodeBlock code={task.prompt} isWrapped width="100%" maxHeight={640} size="sm" /> : <Meta>{task.prompt.length.toLocaleString()} characters</Meta>}
        </Panel>
      )}
    </VStack>
  );
}
