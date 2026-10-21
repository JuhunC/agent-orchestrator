import { useState } from "react";
import { ago, api, useApi, type BoardInfo, type BoardsResponse } from "../api.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Dialog, Empty, Panel, Pill } from "../components/ui.tsx";
import { href, navigate } from "../router.ts";
import { Chips } from "./Agents.tsx";

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
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!/^[a-z\d][a-z\d_-]*$/i.test(name) || !/^[\w.-]+\/\d+$/.test(project.trim())} onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="board-name">Name</label>
          <input id="board-name" value={name} onChange={(event) => setName(event.target.value.replace(/[^a-z\d_-]/gi, "-").toLowerCase())} />
        </div>
        <div className="field">
          <label htmlFor="board-project">GitHub Project</label>
          <input id="board-project" placeholder="your-org/3" value={project} onChange={(event) => setProject(event.target.value)} />
          <span className="help">Owner and number from the project's URL. Organization projects send webhooks; others are polled.</span>
        </div>
      </div>
      <p className="meta">Creates profiles/boards/{name}.yaml with an example mapping (Backlog → Ready → In review → Done). You'll adjust it next.</p>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}

function BoardSummary({ board }: { board: BoardInfo }) {
  const counts: Record<string, number> = {};
  for (const item of board.items) if (item.status) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return (
    <tr className="clickable" onClick={() => navigate(`/boards/${board.name}`)}>
      <td>
        <div className="title">
          {board.name} {board.errors.length > 0 || board.status.error ? <Pill tone="failed">needs attention</Pill> : null}
        </div>
        <div className="meta">
          {board.status.project ? board.status.project.title : board.project}
          {board.status.lastSyncAt && ` · synced ${ago(board.status.lastSyncAt)}`}
        </div>
      </td>
      <td>
        <Chips items={board.columns.map((column) => `${column.name}${column.agents.length ? ` → ${column.agents.length > 1 ? `${column.agents.length} agents (${column.mode})` : column.agents[0]}` : ""}${counts[column.name] ? ` (${counts[column.name]})` : ""}`)} />
      </td>
    </tr>
  );
}

export function Boards() {
  const { data } = useApi<BoardsResponse>("/api/boards", (message) => message.type === "boards" || message.type === "agents");
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <div className="page-head">
        <span className="sub">
          Connect a GitHub Project: when a card lands in a column, that column's agent picks it up, does its stage of the work, and moves the card on.
        </span>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          New board
        </button>
      </div>
      {data?.errors.length ? <div className="banner error">{data.errors.join(" · ")}</div> : null}
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.boards.length === 0 ? (
          <Empty>No boards yet. Create one, or add a file under profiles/boards (see product.yaml.example).</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Board</th>
                  <th>Columns → agents</th>
                </tr>
              </thead>
              <tbody>
                {data.boards.map((board) => (
                  <BoardSummary key={board.name} board={board} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {creating && <NewBoardDialog onClose={() => setCreating(false)} />}
    </div>
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
    <div className="stack">
      <div className="page-head">
        <h1 className="grow">
          {board.name} <span className="meta">{board.project}</span>
        </h1>
        {board.status.project && (
          <a className="button" href={board.status.project.url} target="_blank" rel="noreferrer">
            Open project ↗
          </a>
        )}
        <button onClick={sync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        <a className="button" href={href("/boards")}>
          All boards
        </a>
      </div>

      {(board.errors.length > 0 || board.status.error) && (
        <div className="banner error">
          <span>
            {[...board.errors, ...(board.status.error ? [board.status.error] : [])].map((error) => (
              <div key={error}>{error}</div>
            ))}
          </span>
        </div>
      )}

      <Panel title="Column mapping" hint="harness (agent) and role per column">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th>Agents (harness)</th>
                <th>Role</th>
                <th>Model · effort</th>
                <th>Moves to</th>
              </tr>
            </thead>
            <tbody>
              {board.columns.map((column) => (
                <tr key={column.name}>
                  <td>
                    <b>{column.name}</b>
                    {projectColumns.length > 0 && !projectColumns.some((option) => option.toLowerCase() === column.name.toLowerCase()) && (
                      <div className="error-text">not in the project</div>
                    )}
                  </td>
                  <td>
                    {column.agents.length === 0 ? (
                      <span className="meta">none (people only)</span>
                    ) : (
                      <>
                        {column.agents.length > 1 || column.mode !== "pool" ? <span className="badge accent">{column.mode === "pool" ? "pool" : column.mode === "all" ? "all work it" : "by label"}</span> : null}{" "}
                        {column.mode === "label" ? (
                          <div className="meta">
                            {column.routes.map((route) => `${route.label} → ${route.agents.join(", ")}`).join(" · ")}
                            {column.routeDefault.length > 0 && ` · otherwise ${column.routeDefault.join(", ")}`}
                          </div>
                        ) : (
                          <div>
                            {column.agentRefs.map((ref, index) => (
                              <span key={ref}>
                                {index > 0 && ", "}
                                {ref.startsWith("group:") ? <a href={href(`/groups/${ref.slice(6)}`)}>{ref}</a> : <a href={href(`/agents/${ref}`)}>{ref}</a>}
                              </span>
                            ))}
                            {column.agentRefs.some((ref) => ref.startsWith("group:")) && <div className="meta">{column.agents.join(", ")}</div>}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td>{column.roleName ? <span className="badge accent">{column.roleName}</span> : column.roleText ? <span className="meta">{column.roleText.slice(0, 80)}</span> : "—"}</td>
                  <td className="meta">{[column.model ?? "agent's model", column.effort ?? "agent's effort"].join(" · ")}</td>
                  <td>
                    {column.onStart && <div className="meta">on start → {column.onStart}</div>}
                    {column.agent ? column.movesTo === "any" ? "any column" : <Chips items={column.movesTo} /> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta">
          Loop guards: {board.limits.movesPerIssue} agent moves per card, {board.limits.entriesPerColumn} visits per column
          {board.limits.budgetUsdPerIssue !== null && `, $${board.limits.budgetUsdPerIssue} per card`}; then the card goes to <b>{board.needsHuman ?? "nowhere (it stays)"}</b>. Agents never merge.
        </p>
      </Panel>

      <Panel title="Cards" hint={board.items.length ? `${board.items.length} seen` : undefined} tight>
        {board.items.length === 0 ? (
          <Empty>No cards seen yet. Move an issue on the project, or press Sync now.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Card</th>
                  <th>Column</th>
                  <th>Agent moves</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {board.items.map((item) => (
                  <tr key={item.itemId} className="clickable" onClick={() => navigate(`/history/${item.owner}/${item.repo}/${item.kind}/${item.number}`)}>
                    <td>
                      <div className="title ellipsis">{item.title || `#${item.number}`}</div>
                      <div className="meta">
                        {item.owner}/{item.repo}#{item.number}
                      </div>
                    </td>
                    <td>{item.status ? <span className="badge">{item.status}</span> : "—"}</td>
                    <td className="num">{item.moves}</td>
                    <td className="num meta">{ago(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={`${board.file}`} hint="edit the mapping">
        <FileEditor path={board.file} rows={26} onSaved={() => void reload()} onDeleted={() => navigate("/boards")} deleteLabel="Delete board" />
        <p className="meta">
          Agents: {data.agents.join(", ") || "none"} · Library roles: {data.roles.join(", ") || "none"}. A role can also be written inline as text.
        </p>
      </Panel>
    </div>
  );
}
