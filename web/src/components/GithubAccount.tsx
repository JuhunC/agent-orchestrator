import { useState } from "react";
import { api, type Agent } from "../api.ts";
import { Panel } from "./ui.tsx";

type Check = { ok: boolean; problem: string | null; login?: string; repositories: { repository: string; access: string }[] };

/** Which GitHub account an agent acts as: its own (registered with a token), or the GitHub App. */
export function GithubAccount({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const account = agent.account ?? null;
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [repository, setRepository] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const path = `/api/agents/${encodeURIComponent(agent.name)}/github-account`;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const register = () =>
    run(async () => {
      const result = await api.put<{ warning: string | null }>(path, { token });
      setToken("");
      setCheck(null);
      setWarning(result.warning);
      onChanged();
    });
  const remove = () =>
    run(async () => {
      if (!confirm(`Stop acting as @${account?.login}? ${agent.name} goes back to acting as the GitHub App.`)) return;
      await api.del(path);
      setCheck(null);
      setWarning(null);
      onChanged();
    });
  const test = () => run(async () => setCheck(await api.post<Check>(`${path}/check`, { repository: repository.trim() || undefined })));

  return (
    <Panel title="GitHub account" hint={account ? `acts as @${account.login || "?"}` : "acts as the GitHub App"}>
      <div className="stack" style={{ gap: 10 }}>
        {account ? (
          <div className="account-row">
            {account.avatarUrl && <img className="avatar" src={account.avatarUrl} alt="" width={36} height={36} />}
            <div className="grow">
              <div>
                <b>@{account.login || "unknown"}</b>
                {account.name && <span className="meta"> · {account.name}</span>}
              </div>
              <div className="meta">
                {account.source === "env" ? (
                  <>
                    Token from <code>{account.envVar}</code> (<code>github.account_token_env</code> in agent.md)
                  </>
                ) : (
                  <>Registered here{account.savedAt ? ` on ${new Date(account.savedAt).toLocaleDateString()}` : ""}</>
                )}
                {account.scopes !== null && <> · scopes: {account.scopes || "none"}</>}
              </div>
            </div>
            {account.source === "ui" && (
              <button className="danger" disabled={busy} onClick={() => void remove()}>
                Remove
              </button>
            )}
          </div>
        ) : (
          <p className="meta" style={{ margin: 0 }}>
            {agent.name} comments, opens pull requests, reviews and pushes as the orchestrator's GitHub App (<code>app[bot]</code>). Register an account to have it do all of that as that GitHub user instead.
          </p>
        )}
        {account?.problem && <div className="banner error">{account.problem}</div>}
        {warning && <div className="banner">{warning}</div>}
        {error && <div className="banner error">{error}</div>}

        {account ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input placeholder="owner/repository (optional)" value={repository} onChange={(event) => setRepository(event.target.value)} style={{ flex: "1 1 200px" }} />
            <button disabled={busy} onClick={() => void test()}>
              Check access
            </button>
          </div>
        ) : (
          <form
            className="row"
            style={{ gap: 8, flexWrap: "wrap" }}
            onSubmit={(event) => {
              event.preventDefault();
              void register();
            }}
          >
            <input type="password" autoComplete="off" placeholder="The account's personal access token" value={token} onChange={(event) => setToken(event.target.value)} style={{ flex: "1 1 260px" }} />
            <button className="primary" disabled={busy || !token.trim()}>
              Register account
            </button>
          </form>
        )}
        {check && (
          <div className="stack" style={{ gap: 4 }}>
            {check.problem ? (
              <div className="banner error">{check.problem}</div>
            ) : (
              <div className="meta">The token works for @{check.login}.</div>
            )}
            {check.repositories.map((row) => (
              <div key={row.repository} className="meta">
                <code>{row.repository}</code>: {row.access === "write" ? "can push ✓" : row.access === "read" ? "read only: it can't push or open pull requests" : row.access === "none" ? "no access" : row.access}
              </div>
            ))}
          </div>
        )}
        <p className="meta" style={{ margin: 0 }}>
          {account
            ? "Its comments, pull requests, reviews, issue changes, pushes and commits are made as this account. Board card moves still use the board's access."
            : "Use an account made for this agent, and a classic token with the repo scope (add workflow to let it change GitHub Actions files), or a fine-grained token with Contents, Issues and Pull requests read and write on its repositories. What this account does on GitHub won't start agents. The token stays on the server, encrypted."}
        </p>
      </div>
    </Panel>
  );
}
