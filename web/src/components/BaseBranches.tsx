import { useEffect, useState } from "react";
import { Button, Code, HStack, TableBody, TableCell, TableRow, Text, TextInput, VStack } from "@astryxdesign/core";
import { api, useApi, type BaseBranchOverview, type Installation } from "../api.ts";
import { A, DataTable, Meta, Notice, Panel, SuggestInput } from "./ui.tsx";

/**
 * Settings → Base branches: which branch agents' pull requests go into, per repository, and the
 * boards, agents and schedules that set their own.
 */
export function BaseBranches() {
  const { data, reload } = useApi<BaseBranchOverview>("/api/base-branches", (message) => ["settings", "agents", "schedules", "boards"].includes(message.type));
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Installation[]>("/api/installations")
      .then((installations) => setRepos(installations.flatMap((installation) => installation.repositories).sort()))
      .catch(() => undefined);
  }, []);

  if (!data) return null;
  const save = async (target: string, value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.put("/api/base-branches", { repo: target, branch: value });
      if (value) {
        setRepo("");
        setBranch("");
      }
      void reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const valid = /^[\w.-]+\/[\w.-]+$/.test(repo.trim()) && branch.trim();
  const others = data.boards.length + data.agents.length + data.schedules.length;

  return (
    <Panel title="Base branches" hint="where agents' pull requests go">
      <Meta block>
        Without a setting, pull requests go into the repository's default branch. Set one here per repository, with <Code size="inherit">base_branch</Code> in a board file or an agent's agent.md, on a schedule, or when
        you start a run. The most specific wins: run or schedule, then board, then agent, then repository.
      </Meta>
      {data.repos.length > 0 && (
        <DataTable>
          <TableBody>
            {data.repos.map((entry) => (
              <TableRow key={entry.repo}>
                <TableCell>
                  <Text type="code">{entry.repo}</Text>
                </TableCell>
                <TableCell>
                  <Text type="code" textWrap="nowrap">
                    → {entry.branch}
                  </Text>
                </TableCell>
                <TableCell>
                  <HStack hAlign="end">
                    <Button label="Remove" size="sm" isDisabled={busy} onClick={() => void save(entry.repo, null)} />
                  </HStack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      <HStack gap={2} vAlign="end" wrap="wrap">
        <SuggestInput label="Repository" isLabelHidden placeholder="owner/repo" width={200} suggestions={repos} value={repo} onChange={(value) => setRepo(value.trim())} />
        <TextInput label="Base branch" isLabelHidden placeholder="develop" width={140} value={branch} onChange={(value) => setBranch(value.trim())} />
        <Button label={busy ? "Saving…" : "Set"} isDisabled={!valid || busy} onClick={() => void save(repo.trim(), branch.trim())} />
      </HStack>
      {error && <Notice tone="error" title={error} />}
      {others > 0 && (
        <VStack gap={1}>
          {data.boards.map((board) => (
            <Meta key={`board-${board.name}`} block>
              Board <A to={`/boards/${board.name}`}>{board.name}</A>: <Code size="inherit">{board.branch}</Code>
            </Meta>
          ))}
          {data.agents.map((agent) => (
            <Meta key={`agent-${agent.name}`} block>
              Agent <A to={`/agents/${agent.name}`}>{agent.name}</A>: <Code size="inherit">{agent.branch}</Code>
            </Meta>
          ))}
          {data.schedules.map((schedule) => (
            <Meta key={`schedule-${schedule.id}`} block>
              Schedule <A to="/schedules">{schedule.name}</A> ({schedule.agent}, {schedule.repo}): <Code size="inherit">{schedule.branch ?? ""}</Code>
            </Meta>
          ))}
        </VStack>
      )}
    </Panel>
  );
}
