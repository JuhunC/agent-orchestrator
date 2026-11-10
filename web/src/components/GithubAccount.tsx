import { useState } from "react";
import { Avatar, Button, Code, HStack, StackItem, Text, TextInput, VStack } from "@astryxdesign/core";
import { api, type Agent } from "../api.ts";
import { Meta, Notice, Panel } from "./ui.tsx";

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
      {account ? (
        <HStack gap={3} vAlign="center" wrap="wrap">
          {account.avatarUrl && <Avatar src={account.avatarUrl} name={account.login || "account"} size={36} />}
          <StackItem size="fill">
            <VStack gap={0.5}>
              <Text>
                <b>@{account.login || "unknown"}</b>
                {account.name && <Meta> · {account.name}</Meta>}
              </Text>
              <Meta>
                {account.source === "env" ? (
                  <>
                    Token from <Code size="inherit">{account.envVar ?? ""}</Code> (<Code size="inherit">github.account_token_env</Code> in agent.md)
                  </>
                ) : (
                  <>Registered here{account.savedAt ? ` on ${new Date(account.savedAt).toLocaleDateString()}` : ""}</>
                )}
                {account.scopes !== null && <> · scopes: {account.scopes || "none"}</>}
                {account.expiresAt ? <> · expires {new Date(account.expiresAt).toLocaleDateString()}</> : account.login ? <> · doesn't expire</> : null}
              </Meta>
            </VStack>
          </StackItem>
          {account.source === "ui" && <Button label="Remove" variant="destructive" isDisabled={busy} onClick={() => void remove()} />}
        </HStack>
      ) : (
        <Meta block>
          {agent.name} comments, opens pull requests, reviews and pushes as the orchestrator's GitHub App (<Code size="inherit">app[bot]</Code>). Register an account to have it do all of that as that GitHub user instead.
        </Meta>
      )}
      {account?.problem && <Notice tone="error" title={account.problem} />}
      {account?.expiresAt && !account.problem && Date.parse(account.expiresAt) - Date.now() < 14 * 86_400_000 && (
        <Notice title={`The token expires on ${new Date(account.expiresAt).toLocaleDateString()}.`}>Make a new one and register it, or {agent.name}'s tasks will fail.</Notice>
      )}
      {warning && <Notice title={warning} />}
      {error && <Notice tone="error" title={error} />}

      {account ? (
        <HStack gap={2} wrap="wrap" vAlign="end">
          <StackItem size="fill">
            <TextInput label="Repository to check" isLabelHidden placeholder="owner/repository (optional)" value={repository} onChange={setRepository} />
          </StackItem>
          <Button label="Check access" isDisabled={busy} onClick={() => void test()} />
        </HStack>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
        >
          <HStack gap={2} wrap="wrap" vAlign="end">
            <StackItem size="fill">
              <TextInput label="Personal access token" isLabelHidden type="password" autoComplete="off" placeholder="The account's personal access token" value={token} onChange={setToken} />
            </StackItem>
            <Button label="Register account" type="submit" variant="primary" isDisabled={busy || !token.trim()} />
          </HStack>
        </form>
      )}
      {check && (
        <VStack gap={1}>
          {check.problem ? <Notice tone="error" title={check.problem} /> : <Meta block>The token works for @{check.login}.</Meta>}
          {check.repositories.map((row) => (
            <Meta key={row.repository} block>
              <Code size="inherit">{row.repository}</Code>:{" "}
              {row.access === "write" ? "can push ✓" : row.access === "read" ? "read only: it can't push or open pull requests" : row.access === "none" ? "no access" : row.access}
            </Meta>
          ))}
        </VStack>
      )}
      <Meta block>
        {account
          ? `Its comments, pull requests, reviews, issue changes, pushes and commits are made as this account. Board card moves still use the board's access.${agent.github.accountMentions ? ` Mentioning @${account.login} (or assigning it) starts ${agent.name}, like @${agent.handle}.` : ""}`
          : "A classic token with the repo scope (add workflow to let it change GitHub Actions files), or a fine-grained token with Contents, Issues and Pull requests read and write on its repositories. It can be an account made for the agent or your own: what the orchestrator does as it is recognised as the agent's, what you do with it counts as yours. Mentioning the account starts the agent (github.account_mentions: false turns that off). The token stays on the server, encrypted."}
      </Meta>
    </Panel>
  );
}
