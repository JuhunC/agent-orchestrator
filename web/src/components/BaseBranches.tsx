import { useEffect, useState } from "react";
import { api, useApi, type BaseBranchOverview, type Installation } from "../api.ts";
import { href } from "../router.ts";
import { Panel } from "./ui.tsx";

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
      <div className="stack" style={{ gap: 10 }}>
        <div className="meta">
          Without a setting, pull requests go into the repository's default branch. Set one here per repository, with <code>base_branch</code> in a board file or an agent's agent.md, on a schedule, or when you start a run. The most specific wins: run or schedule, then board, then agent, then repository.
        </div>
        {data.repos.length > 0 && (
          <div className="table-wrap">
            <table>
              <tbody>
                {data.repos.map((entry) => (
                  <tr key={entry.repo}>
                    <td className="mono">{entry.repo}</td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      → {entry.branch}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="small" disabled={busy} onClick={() => void save(entry.repo, null)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="base-branch-form">
          <input aria-label="Repository" list="base-branch-repos" placeholder="owner/repo" value={repo} onChange={(event) => setRepo(event.target.value.trim())} />
          <datalist id="base-branch-repos">
            {repos.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <input aria-label="Base branch" placeholder="develop" value={branch} onChange={(event) => setBranch(event.target.value.trim())} />
          <button disabled={!valid || busy} onClick={() => void save(repo.trim(), branch.trim())}>
            {busy ? "Saving…" : "Set"}
          </button>
        </div>
        {error && <div className="banner error">{error}</div>}
        {others > 0 && (
          <div className="meta stack" style={{ gap: 4 }}>
            {data.boards.map((board) => (
              <div key={`board-${board.name}`}>
                Board <a href={href(`/boards/${board.name}`)}>{board.name}</a>: <code>{board.branch}</code>
              </div>
            ))}
            {data.agents.map((agent) => (
              <div key={`agent-${agent.name}`}>
                Agent <a href={href(`/agents/${agent.name}`)}>{agent.name}</a>: <code>{agent.branch}</code>
              </div>
            ))}
            {data.schedules.map((schedule) => (
              <div key={`schedule-${schedule.id}`}>
                Schedule <a href={href("/schedules")}>{schedule.name}</a> ({schedule.agent}, {schedule.repo}): <code>{schedule.branch}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
