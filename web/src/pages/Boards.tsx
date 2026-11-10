import { useState } from "react";
import { Button, Code, Grid, Heading, HStack, StackItem, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, TextInput, VStack } from "@astryxdesign/core";
import { ago, api, useApi, type BoardInfo, type BoardsResponse } from "../api.ts";
import { BoardMap } from "../components/BoardMap.tsx";
import { FileEditor } from "../components/FileEditor.tsx";
import { A, Chips, DataTable, Dialog, Empty, ErrorText, Lines, LinkButton, Meta, Notice, Panel, Pill, Tag } from "../components/ui.tsx";
import { navigate } from "../router.ts";

const BOARD_TEMPLATE = (project: string) => `# Which agent works each column of a GitHub Project.
# harness = agent (a profile: tools, skills, MCP), role = what to do in that column.
project: ${project}            # org/project-number
status_field: Status
needs_human: Needs human       # where loop guards send cards
poll_seconds: 60
limits:
  moves_per_issue: 10
  entries_per_column: 3
  budget_usd_per_issue: 30

columns:
  Backlog:
    agent: analyst
    role: requirements
    effort: medium
    moves_to: [Ready]
  Ready:
    agent: coder
    role: implement
    on_start: In progress
    effort: high
    moves_to: [In review]
  In progress:
    agent: coder
    role: address-feedback
    moves_to: [In review]
  In review:
    agent: tester
    role: verify
    moves_to: [Done, In progress]
  Done: {}

# Optional (see Options next to the editor):
# fields:                      # GitHub Project fields to track per card
#   start: Start date          # a date field
#   end: End date              # a date field
#   estimate: Estimate         # a number field
#   start_on: [In progress]    # fill in the start date when a card enters these
#   end_on: [Done]             # fill in the end date when a card enters these
# sub_issues:
#   column: Backlog            # where sub-issues that agents create land
#   moves_to: [Ready]          # where a parent card's agent may move its sub-issues
# base_branch: develop         # pull requests go here instead of the default branch
#                              # (or per repository: { acme/api: develop, default: main })
`;

function NewBoardDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("product");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    try {
      await api.put("/api/profiles/file", { path: `boards/${name}.yaml`, content: BOARD_TEMPLATE(project.trim()) });
      onClose();
      navigate(`/boards/${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      title="New board"
      onClose={onClose}
      footer={
        <>
          <Button label="Cancel" onClick={onClose} />
          <Button label="Create" variant="primary" isDisabled={!/^[a-z\d][a-z\d_-]*$/i.test(name) || !/^[\w.-]+\/\d+$/.test(project.trim())} onClick={() => void create()} />
        </>
      }
    >
      <Grid columns={{ minWidth: 220 }} gap={4}>
        <TextInput label="Name" value={name} onChange={(value) => setName(value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
        <TextInput
          label="GitHub Project"
          placeholder="your-org/3"
          value={project}
          onChange={setProject}
          description="Owner and number from the project's URL. Organization projects send webhooks; others are polled."
        />
      </Grid>
      <Meta block>Creates profiles/boards/{name}.yaml with an example mapping (Backlog → Ready → In review → Done). You'll adjust it next.</Meta>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}

function BoardSummary({ board }: { board: BoardInfo }) {
  const counts: Record<string, number> = {};
  for (const item of board.items) if (item.status) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return (
    <TableRow className="ao-clickable" onClick={() => navigate(`/boards/${board.name}`)}>
      <TableCell>
        <VStack gap={0.5}>
          <HStack gap={1.5} vAlign="center" wrap="wrap">
            <Text weight="semibold">{board.name}</Text>
            {board.errors.length > 0 || board.status.error ? <Pill tone="failed">needs attention</Pill> : null}
          </HStack>
          <Meta>
            {board.status.project ? board.status.project.title : board.project}
            {board.status.lastSyncAt && ` · synced ${ago(board.status.lastSyncAt)}`}
          </Meta>
        </VStack>
      </TableCell>
      <TableCell>
        <Chips items={board.columns.map((column) => `${column.name}${column.agents.length ? ` → ${column.agents.length > 1 ? `${column.agents.length} agents (${column.mode})` : column.agents[0]}` : ""}${counts[column.name] ? ` (${counts[column.name]})` : ""}`)} />
      </TableCell>
    </TableRow>
  );
}

export function Boards() {
  const { data } = useApi<BoardsResponse>("/api/boards", (message) => message.type === "boards" || message.type === "agents");
  const [creating, setCreating] = useState(false);
  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <Text color="secondary">Connect a GitHub Project: when a card lands in a column, that column's agent picks it up, does its stage of the work, and moves the card on.</Text>
        </StackItem>
        <Button label="New board" variant="primary" onClick={() => setCreating(true)} />
      </HStack>
      {data?.errors.length ? <Notice tone="error" title={data.errors.join(" · ")} /> : null}
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.boards.length === 0 ? (
          <Empty>No boards yet. Create one, or add a file under profiles/boards (see product.yaml.example).</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Board</TableHeaderCell>
                <TableHeaderCell>Columns → agents</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.boards.map((board) => (
                <BoardSummary key={board.name} board={board} />
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>
      {creating && <NewBoardDialog onClose={() => setCreating(false)} />}
    </VStack>
  );
}

export function BoardDetail({ name }: { name: string }) {
  const { data, reload } = useApi<BoardsResponse>("/api/boards", (message) => message.type === "boards" || message.type === "agents" || message.type === "task");
  const [syncing, setSyncing] = useState(false);
  if (!data) return <Empty>Loading…</Empty>;
  const board = data.boards.find((candidate) => candidate.name === name);
  if (!board) return <Empty>No board called {name}.</Empty>;
  const projectColumns = board.status.project?.columns ?? [];

  const sync = async () => {
    setSyncing(true);
    try {
      await api.post(`/api/boards/${encodeURIComponent(board.name)}/sync`);
      void reload();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>{board.name}</Heading>
            <Meta>{board.project}</Meta>
          </HStack>
        </StackItem>
        <HStack gap={2} wrap="wrap">
          {board.status.project && <LinkButton to={board.status.project.url} label="Open project" external />}
          <Button label={syncing ? "Syncing…" : "Sync now"} isDisabled={syncing} onClick={() => void sync()} />
          <LinkButton to="/boards" label="All boards" />
        </HStack>
      </HStack>

      {(board.errors.length > 0 || board.status.error) && (
        <Notice tone="error" title="This board needs attention">
          <Lines items={[...board.errors, ...(board.status.error ? [board.status.error] : [])]} />
        </Notice>
      )}

      <Panel title="Move map" hint="where an agent can move a card from each column">
        <BoardMap board={board} />
      </Panel>

      <Panel title="Column mapping" hint="harness (agent) and role per column">
        <DataTable>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Column</TableHeaderCell>
              <TableHeaderCell>Agents (harness)</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Model · effort</TableHeaderCell>
              <TableHeaderCell>Moves to</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.columns.map((column) => (
              <TableRow key={column.name}>
                <TableCell>
                  <VStack gap={0.5}>
                    <Text weight="semibold">{column.name}</Text>
                    {projectColumns.length > 0 && !projectColumns.some((option) => option.toLowerCase() === column.name.toLowerCase()) && <ErrorText>not in the project</ErrorText>}
                    {(column.rules.evidence.length > 0 || column.rules.handoffRequired.length > 0) && (
                      <span title="What an agent must show to move a card here">
                        <Meta>to enter: {[...column.rules.evidence, ...column.rules.handoffRequired.map((field) => `handoff ${field}`)].join(", ")}</Meta>
                      </span>
                    )}
                  </VStack>
                </TableCell>
                <TableCell>
                  {column.agents.length === 0 ? (
                    <Meta>none (people only)</Meta>
                  ) : (
                    <VStack gap={1}>
                      {column.agents.length > 1 || column.mode !== "pool" ? (
                        <HStack>
                          <Tag accent>{column.mode === "pool" ? "pool" : column.mode === "all" ? "all work it" : "by label"}</Tag>
                        </HStack>
                      ) : null}
                      {column.mode === "label" ? (
                        <Meta>
                          {column.routes.map((route) => `${route.label} → ${route.agents.join(", ")}`).join(" · ")}
                          {column.routeDefault.length > 0 && ` · otherwise ${column.routeDefault.join(", ")}`}
                        </Meta>
                      ) : (
                        <>
                          <Text>
                            {column.agentRefs.map((ref, index) => (
                              <span key={ref}>
                                {index > 0 && ", "}
                                {ref.startsWith("group:") ? <A to={`/groups/${ref.slice(6)}`}>{ref}</A> : <A to={`/agents/${ref}`}>{ref}</A>}
                              </span>
                            ))}
                          </Text>
                          {column.agentRefs.some((ref) => ref.startsWith("group:")) && <Meta>{column.agents.join(", ")}</Meta>}
                        </>
                      )}
                    </VStack>
                  )}
                </TableCell>
                <TableCell>{column.roleName ? <Tag accent>{column.roleName}</Tag> : column.roleText ? <Meta>{column.roleText.slice(0, 80)}</Meta> : "—"}</TableCell>
                <TableCell>
                  <Meta>{[column.model ?? "agent's model", column.effort ?? "agent's effort"].join(" · ")}</Meta>
                </TableCell>
                <TableCell>
                  <VStack gap={1}>
                    {column.onStart && <Meta>on start → {column.onStart}</Meta>}
                    {column.agent ? column.movesTo === "any" ? <Text>any column</Text> : <Chips items={column.movesTo} /> : <Text>—</Text>}
                  </VStack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
        <Meta block>
          Loop guards: {board.limits.movesPerIssue} agent moves per card, {board.limits.entriesPerColumn} visits per column
          {board.limits.budgetUsdPerIssue !== null && `, $${board.limits.budgetUsdPerIssue} per card`}; then the card goes to <b>{board.needsHuman ?? "nowhere (it stays)"}</b>. Agents open pull requests; they never merge
          into the base branch themselves.
        </Meta>
        <Meta block>
          Base branch:{" "}
          {board.baseBranch ? (
            <>
              pull requests go into <Code size="inherit">{board.baseBranch}</Code> (<Code size="inherit">base_branch</Code>).
            </>
          ) : (
            <>
              each agent's or repository's setting, otherwise the repository's default branch. Set <Code size="inherit">base_branch</Code> in the board file to choose one.
            </>
          )}
        </Meta>
        {board.workTypes.length > 0 && (
          <Meta block>
            Work types: {board.workTypes.map((type) => `${type.name} (${type.labels.join(", ")}) can't go to ${type.forbid.join(", ") || "—"}`).join(" · ")}. People can still move any card anywhere.
          </Meta>
        )}
        {(board.fields.start || board.fields.end || board.fields.estimate) && (
          <Meta block>
            Project fields:{" "}
            {[
              board.fields.start && `start date "${board.fields.start}"${board.fields.startOn.length ? ` (filled in on entering ${board.fields.startOn.join(" or ")})` : ""}`,
              board.fields.end && `end date "${board.fields.end}"${board.fields.endOn.length ? ` (filled in on entering ${board.fields.endOn.join(" or ")})` : ""}`,
              board.fields.estimate && `estimate "${board.fields.estimate}"`,
            ]
              .filter(Boolean)
              .join(" · ")}
            . Agents set them with set_card_fields.
          </Meta>
        )}
        {(board.subIssues.column || board.subIssues.movesTo.length > 0) && (
          <Meta block>
            Sub-issues:{" "}
            {board.subIssues.column ? (
              <>
                ones agents create land in <b>{board.subIssues.column}</b>
              </>
            ) : (
              "ones agents create aren't added to the board"
            )}
            {" · "}
            {board.subIssues.movesTo.length ? <>a parent's agent may move them to {board.subIssues.movesTo.join(", ")}</> : "a parent's agent can't move them"}.
          </Meta>
        )}
      </Panel>

      <Panel title="Cards" hint={board.items.length ? `${board.items.length} seen` : undefined} tight>
        {board.items.length === 0 ? (
          <Empty>No cards seen yet. Move an issue on the project, or press Sync now.</Empty>
        ) : (
          <DataTable hover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Card</TableHeaderCell>
                <TableHeaderCell>Column</TableHeaderCell>
                {board.fields.start && <TableHeaderCell>Start</TableHeaderCell>}
                {board.fields.end && <TableHeaderCell>End</TableHeaderCell>}
                {board.fields.estimate && <TableHeaderCell>Estimate</TableHeaderCell>}
                <TableHeaderCell>Agent moves</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {board.items.map((item) => (
                <TableRow key={item.itemId} className="ao-clickable" onClick={() => navigate(`/history/${item.owner}/${item.repo}/${item.kind}/${item.number}`)}>
                  <TableCell>
                    <VStack gap={0.5}>
                      <Text weight="medium" maxLines={1}>
                        {item.title || `#${item.number}`}
                      </Text>
                      <Meta>
                        {item.owner}/{item.repo}#{item.number}
                      </Meta>
                    </VStack>
                  </TableCell>
                  <TableCell>{item.status ? <Tag>{item.status}</Tag> : "—"}</TableCell>
                  {board.fields.start && (
                    <TableCell>
                      <Meta>{item.fields?.start ?? "—"}</Meta>
                    </TableCell>
                  )}
                  {board.fields.end && (
                    <TableCell>
                      <Meta>{item.fields?.end ?? "—"}</Meta>
                    </TableCell>
                  )}
                  {board.fields.estimate && <TableCell>{item.fields?.estimate ?? "—"}</TableCell>}
                  <TableCell>
                    <Text hasTabularNumbers>{item.moves}</Text>
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" textWrap="nowrap">
                      {ago(item.updatedAt)}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>

      <Panel title={`${board.file}`} hint="edit the mapping">
        <FileEditor path={board.file} rows={26} onSaved={() => void reload()} onDeleted={() => navigate("/boards")} deleteLabel="Delete board" />
        <Meta block>
          Agents: {data.agents.join(", ") || "none"} · Library roles: {data.roles.join(", ") || "none"}. A role can also be written inline as text.
        </Meta>
      </Panel>
    </VStack>
  );
}
