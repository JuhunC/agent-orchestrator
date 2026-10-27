import type { BoardColumnInfo, BoardInfo } from "../api.ts";

const NODE_W = 148;
const GAP = 44;
const PAD = 14;
const LINE = 16;

type EdgeKind = "forward" | "back" | "start";
interface Edge {
  from: number;
  to: number;
  kind: EdgeKind;
}

const STROKE: Record<EdgeKind, string> = { forward: "var(--accent)", back: "var(--queued)", start: "var(--muted)" };

function clip(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function agentsText(column: BoardColumnInfo): string {
  if (!column.agents.length) return "people only";
  if (column.mode === "label") return `by label · ${column.agents.length} agent${column.agents.length === 1 ? "" : "s"}`;
  if (column.agents.length > 1) return `${column.agents.length} agents · ${column.mode === "all" ? "all work it" : "pool"}`;
  return column.agents[0]!;
}

/** The text lines inside a column's box, after its name. */
function nodeLines(board: BoardInfo, column: BoardColumnInfo): { text: string; tone?: "accent" | "muted" }[] {
  const needs = [...column.rules.evidence, ...column.rules.handoffRequired.map((field) => `handoff ${field}`)];
  return [
    { text: agentsText(column), tone: "muted" },
    ...(column.agents.length && column.movesTo === "any" ? [{ text: "→ any column", tone: "accent" as const }] : []),
    ...(needs.length ? [{ text: `to enter: ${needs.join(", ")}` }] : []),
    ...(board.subIssues.column === column.name ? [{ text: "new sub-issues land here", tone: "muted" as const }] : []),
    ...(board.subIssues.movesTo.includes(column.name) ? [{ text: "parents move sub-issues here", tone: "muted" as const }] : []),
  ];
}

/**
 * The board as a directional map: one box per column, in file order, and an arrow for each
 * move an agent in a column may make (moves_to). Arrows forward arc above the boxes, arrows that
 * send a card back arc below, and on_start moves are dashed.
 */
export function BoardMap({ board }: { board: BoardInfo }) {
  const columns = board.columns;
  if (!columns.length) return null;
  const position = new Map(columns.map((column, index) => [column.name, index]));
  const counts: Record<string, number> = {};
  for (const item of board.items) if (item.status) counts[item.status] = (counts[item.status] ?? 0) + 1;

  const edges: Edge[] = [];
  columns.forEach((column, from) => {
    if (column.onStart && position.has(column.onStart)) edges.push({ from, to: position.get(column.onStart)!, kind: "start" });
    if (!column.agents.length || column.movesTo === "any") return;
    for (const target of column.movesTo) {
      const to = position.get(target);
      if (to !== undefined && to !== from) edges.push({ from, to, kind: to > from ? "forward" : "back" });
    }
  });

  const lines = columns.map((column) => nodeLines(board, column));
  const nodeH = 30 + Math.max(...lines.map((items) => items.length)) * LINE;
  const arc = (edge: Edge) => 26 + 22 * (Math.abs(edge.to - edge.from) - 1);
  const straight = (edge: Edge) => edge.kind === "forward" && edge.to === edge.from + 1;
  const above = edges.filter((edge) => edge.kind !== "back" && !straight(edge));
  const below = edges.filter((edge) => edge.kind === "back");
  const top = PAD + (above.length ? Math.max(...above.map(arc)) * 0.75 + 8 : 0);
  const bottom = top + nodeH;
  const needsHumanNode = board.needsHuman && !position.has(board.needsHuman) ? board.needsHuman : null;
  const count = columns.length + (needsHumanNode ? 1 : 0);
  const width = PAD * 2 + count * NODE_W + (count - 1) * GAP;
  const height = bottom + (below.length ? Math.max(...below.map(arc)) * 0.75 + 8 : 0) + PAD;
  const left = (index: number) => PAD + index * (NODE_W + GAP);
  const center = (index: number) => left(index) + NODE_W / 2;
  const marker = (kind: EdgeKind) => `board-map-${board.name}-${kind}`;

  const path = (edge: Edge): string => {
    if (straight(edge)) {
      const y = top + nodeH / 2;
      return `M ${left(edge.from) + NODE_W} ${y} L ${left(edge.to) - 2} ${y}`;
    }
    const h = arc(edge);
    if (edge.kind === "back") {
      const [sx, ex] = [center(edge.from) - 14, center(edge.to) + 14];
      return `M ${sx} ${bottom} C ${sx} ${bottom + h} ${ex} ${bottom + h} ${ex} ${bottom + 2}`;
    }
    const [sx, ex] = [center(edge.from) + 14, center(edge.to) - 14];
    return `M ${sx} ${top} C ${sx} ${top - h} ${ex} ${top - h} ${ex} ${top - 2}`;
  };

  return (
    <div className="board-map">
      <div className="board-map-scroll">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Where agents can move cards on the ${board.name} board`}>
          <defs>
            {(Object.keys(STROKE) as EdgeKind[]).map((kind) => (
              <marker key={kind} id={marker(kind)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: STROKE[kind] }} />
              </marker>
            ))}
          </defs>
          {edges.map((edge, index) => (
            <path
              key={index}
              d={path(edge)}
              markerEnd={`url(#${marker(edge.kind)})`}
              style={{ fill: "none", stroke: STROKE[edge.kind], strokeWidth: 1.6, strokeDasharray: edge.kind === "start" ? "5 4" : undefined }}
            >
              <title>{`${columns[edge.from]!.name} → ${columns[edge.to]!.name}${edge.kind === "start" ? " (when the agent starts)" : edge.kind === "back" ? " (sends it back)" : ""}`}</title>
            </path>
          ))}
          {columns.map((column, index) => {
            const missing = board.status.project && !board.status.project.columns.some((option) => option.toLowerCase() === column.name.toLowerCase());
            return (
              <g key={column.name} transform={`translate(${left(index)} ${top})`}>
                <title>{[column.name, agentsText(column), ...lines[index]!.slice(1).map((line) => line.text)].join("\n")}</title>
                <rect
                  width={NODE_W}
                  height={nodeH}
                  rx={9}
                  style={{
                    fill: column.agents.length ? "var(--panel)" : "var(--panel-2)",
                    stroke: missing ? "var(--failed)" : column.agents.length ? "var(--accent-border)" : "var(--border-strong)",
                    strokeWidth: column.agents.length ? 1.5 : 1,
                    strokeDasharray: column.agents.length ? undefined : "4 3",
                  }}
                />
                <text x={10} y={20} style={{ fill: "var(--text)", fontSize: 13, fontWeight: 600 }}>
                  {clip(column.name, 17)}
                  {counts[column.name] ? <tspan style={{ fill: "var(--muted)", fontWeight: 400 }}>{` · ${counts[column.name]}`}</tspan> : null}
                </text>
                {lines[index]!.map((line, row) => (
                  <text key={row} x={10} y={38 + row * LINE} style={{ fill: line.tone === "accent" ? "var(--accent)" : line.tone === "muted" ? "var(--muted)" : "var(--text)", fontSize: 11.5 }}>
                    {clip(line.text, 25)}
                  </text>
                ))}
              </g>
            );
          })}
          {needsHumanNode && (
            <g transform={`translate(${left(columns.length)} ${top})`}>
              <title>{`${needsHumanNode}: agents can always move a card here, and loop guards send cards here.`}</title>
              <rect width={NODE_W} height={nodeH} rx={9} style={{ fill: "var(--queued-bg)", stroke: "var(--queued-border)", strokeDasharray: "4 3" }} />
              <text x={10} y={20} style={{ fill: "var(--queued)", fontSize: 13, fontWeight: 600 }}>
                {clip(needsHumanNode, 17)}
                {counts[needsHumanNode] ? <tspan style={{ fontWeight: 400 }}>{` · ${counts[needsHumanNode]}`}</tspan> : null}
              </text>
              <text x={10} y={38} style={{ fill: "var(--muted)", fontSize: 11.5 }}>
                from any agent column
              </text>
              <text x={10} y={38 + LINE} style={{ fill: "var(--muted)", fontSize: 11.5 }}>
                and from loop guards
              </text>
            </g>
          )}
        </svg>
      </div>
      <div className="board-map-legend">
        <span>
          <svg width="28" height="10" aria-hidden="true">
            <line x1="1" y1="5" x2="27" y2="5" style={{ stroke: STROKE.forward, strokeWidth: 2 }} />
          </svg>
          an agent moves the card on
        </span>
        <span>
          <svg width="28" height="10" aria-hidden="true">
            <line x1="1" y1="5" x2="27" y2="5" style={{ stroke: STROKE.back, strokeWidth: 2 }} />
          </svg>
          sends it back
        </span>
        <span>
          <svg width="28" height="10" aria-hidden="true">
            <line x1="1" y1="5" x2="27" y2="5" style={{ stroke: STROKE.start, strokeWidth: 2, strokeDasharray: "5 4" }} />
          </svg>
          when the agent starts (on_start)
        </span>
        <span>
          <svg width="28" height="12" aria-hidden="true">
            <rect x="1" y="1" width="26" height="10" rx="3" style={{ fill: "var(--panel-2)", stroke: "var(--border-strong)", strokeDasharray: "3 2" }} />
          </svg>
          no agent: people move cards on
        </span>
      </div>
    </div>
  );
}
