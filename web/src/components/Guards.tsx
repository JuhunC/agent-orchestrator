import { Code, Heading, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, VStack } from "@astryxdesign/core";
import { useApi, type Incident } from "../api.ts";
import { A, DataTable, Meta, Panel } from "./ui.tsx";

interface GuardsResponse {
  global: { name: string; setting: string; value: string; what: string }[];
  boards: { name: string; movesPerIssue: number; entriesPerColumn: number; budgetUsdPerIssue: number | null; maxRunning: number | null; needsHuman: string | null }[];
  agents: { name: string; maxBudgetUsd: number | null; maxTurns: number | null; timeoutMinutes: number | null; replicas: number | null }[];
  recent: Incident[];
}

const or = (value: number | null, unit = "") => (value === null ? <Meta>none</Meta> : `${unit === "$" ? "$" : ""}${value}${unit && unit !== "$" ? ` ${unit}` : ""}`);

/** A column header with the setting it comes from as a tooltip. */
function Th({ children, setting }: { children: string; setting?: string }) {
  return (
    <TableHeaderCell>
      <span title={setting}>{children}</span>
    </TableHeaderCell>
  );
}

/** Every limit that keeps agents from running away, in one place, with the ones that tripped lately. */
export function Guards() {
  const { data } = useApi<GuardsResponse>("/api/guards", (message) => message.type === "incidents" || message.type === "settings" || message.type === "agents" || message.type === "boards");
  if (!data) return null;
  return (
    <Panel title="Loop guards" hint="what stops agents from running away">
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th>Guard</Th>
            <Th>Set to</Th>
            <Th>Setting</Th>
            <Th>What it does</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.global.map((guard) => (
            <TableRow key={guard.name}>
              <TableCell>{guard.name}</TableCell>
              <TableCell>
                <Text textWrap="nowrap">{guard.value}</Text>
              </TableCell>
              <TableCell>
                <Code size="inherit">{guard.setting}</Code>
              </TableCell>
              <TableCell>
                <Meta>{guard.what}</Meta>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      {data.boards.length > 0 && (
        <DataTable>
          <TableHeader>
            <TableRow>
              <Th>Board</Th>
              <Th setting="limits.moves_per_issue">Agent moves per card</Th>
              <Th setting="limits.entries_per_column">Visits per column</Th>
              <Th setting="limits.budget_usd_per_issue">Spend per card</Th>
              <Th setting="limits.max_running">Cards at once</Th>
              <Th>Then</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.boards.map((board) => (
              <TableRow key={board.name}>
                <TableCell>
                  <A to="/boards">{board.name}</A>
                </TableCell>
                <TableCell>{board.movesPerIssue}</TableCell>
                <TableCell>{board.entriesPerColumn}</TableCell>
                <TableCell>{or(board.budgetUsdPerIssue, "$")}</TableCell>
                <TableCell>{or(board.maxRunning)}</TableCell>
                <TableCell>
                  <Meta>{board.needsHuman ? `to "${board.needsHuman}"` : "the card stays"}</Meta>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th>Agent</Th>
            <Th setting="max_budget_usd">Spend per task</Th>
            <Th setting="max_turns">Turns per task</Th>
            <Th setting="timeout_minutes">Timeout</Th>
            <Th setting="replicas">Cards at once</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.agents.map((agent) => (
            <TableRow key={agent.name}>
              <TableCell>
                <A to={`/agents/${agent.name}`}>{agent.name}</A>
              </TableCell>
              <TableCell>{or(agent.maxBudgetUsd, "$")}</TableCell>
              <TableCell>{or(agent.maxTurns)}</TableCell>
              <TableCell>{agent.timeoutMinutes ? `${agent.timeoutMinutes} min` : <Meta>default</Meta>}</TableCell>
              <TableCell>{or(agent.replicas)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      <VStack gap={1.5}>
        <Heading level={3}>Tripped recently</Heading>
        {data.recent.length === 0 ? (
          <Meta>None.</Meta>
        ) : (
          data.recent.slice(0, 15).map((incident) => (
            <Meta key={incident.id} block>
              {new Date(incident.ts).toLocaleString()}: {incident.message}{" "}
              {incident.taskId ? (
                <A to={`/tasks/${incident.taskId}`}>task #{incident.taskId}</A>
              ) : incident.url ? (
                <A to={incident.url} external>
                  on GitHub
                </A>
              ) : null}
            </Meta>
          ))
        )}
      </VStack>
    </Panel>
  );
}
