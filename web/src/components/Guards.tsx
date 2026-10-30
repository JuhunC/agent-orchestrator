import { useApi, type Incident } from "../api.ts";
import { href } from "../router.ts";
import { Panel } from "./ui.tsx";

interface GuardsResponse {
  global: { name: string; setting: string; value: string; what: string }[];
  boards: { name: string; movesPerIssue: number; entriesPerColumn: number; budgetUsdPerIssue: number | null; maxRunning: number | null; needsHuman: string | null }[];
  agents: { name: string; maxBudgetUsd: number | null; maxTurns: number | null; timeoutMinutes: number | null; replicas: number | null }[];
  recent: Incident[];
}

const or = (value: number | null, unit = "") => (value === null ? <span className="meta">none</span> : `${unit === "$" ? "$" : ""}${value}${unit && unit !== "$" ? ` ${unit}` : ""}`);

/** Every limit that keeps agents from running away, in one place, with the ones that tripped lately. */
export function Guards() {
  const { data } = useApi<GuardsResponse>("/api/guards", (message) => message.type === "incidents" || message.type === "settings" || message.type === "agents" || message.type === "boards");
  if (!data) return null;
  return (
    <Panel title="Loop guards" hint="what stops agents from running away">
      <div className="stack" style={{ gap: 16 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Guard</th>
                <th>Set to</th>
                <th>Setting</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {data.global.map((guard) => (
                <tr key={guard.name}>
                  <td>{guard.name}</td>
                  <td className="nowrap">{guard.value}</td>
                  <td>
                    <code>{guard.setting}</code>
                  </td>
                  <td className="meta">{guard.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.boards.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Board</th>
                  <th title="limits.moves_per_issue">Agent moves per card</th>
                  <th title="limits.entries_per_column">Visits per column</th>
                  <th title="limits.budget_usd_per_issue">Spend per card</th>
                  <th title="limits.max_running">Cards at once</th>
                  <th>Then</th>
                </tr>
              </thead>
              <tbody>
                {data.boards.map((board) => (
                  <tr key={board.name}>
                    <td>
                      <a href={href("/boards")}>{board.name}</a>
                    </td>
                    <td>{board.movesPerIssue}</td>
                    <td>{board.entriesPerColumn}</td>
                    <td>{or(board.budgetUsdPerIssue, "$")}</td>
                    <td>{or(board.maxRunning)}</td>
                    <td className="meta">{board.needsHuman ? `to "${board.needsHuman}"` : "the card stays"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th title="max_budget_usd">Spend per task</th>
                <th title="max_turns">Turns per task</th>
                <th title="timeout_minutes">Timeout</th>
                <th title="replicas">Cards at once</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((agent) => (
                <tr key={agent.name}>
                  <td>
                    <a href={href(`/agents/${agent.name}`)}>{agent.name}</a>
                  </td>
                  <td>{or(agent.maxBudgetUsd, "$")}</td>
                  <td>{or(agent.maxTurns)}</td>
                  <td>{agent.timeoutMinutes ? `${agent.timeoutMinutes} min` : <span className="meta">default</span>}</td>
                  <td>{or(agent.replicas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Tripped recently</h3>
          {data.recent.length === 0 ? (
            <div className="meta">None.</div>
          ) : (
            data.recent.slice(0, 15).map((incident) => (
              <div key={incident.id} className="meta" style={{ marginBottom: 4 }}>
                {new Date(incident.ts).toLocaleString()}: {incident.message}{" "}
                {incident.taskId ? <a href={href(`/tasks/${incident.taskId}`)}>task #{incident.taskId}</a> : incident.url ? <a href={incident.url} target="_blank" rel="noreferrer">on GitHub ↗</a> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </Panel>
  );
}
