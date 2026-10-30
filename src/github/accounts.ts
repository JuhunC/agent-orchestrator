import { deleteSetting, getSetting, setSetting } from "../db.ts";
import { errorMessage } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import type { Profile } from "../profiles/types.ts";
import { seal, unseal } from "../server/secrets.ts";
import { getBotIdentity, GitHubOctokit, installationClient, installationToken, noreplyEmail, type GitHubClient } from "./app.ts";

/**
 * A GitHub account an agent acts as instead of the GitHub App: its comments, pull requests,
 * reviews and issue changes are made with the account's token, its git pushes use it, and its
 * commits are attributed to it. Registered in the admin UI (the token is stored encrypted) or
 * named in agent.md (github.account_token_env). Agents without one use the App, as before.
 */

export interface AccountInfo {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
  /** Scopes of a classic token (x-oauth-scopes); null for fine-grained tokens. */
  scopes: string | null;
}

export interface AgentAccount extends AccountInfo {
  agent: string;
  /** ui: registered in the admin UI. env: github.account_token_env in agent.md. */
  source: "ui" | "env";
  envVar: string | null;
  savedAt: string | null;
}

interface Stored extends AccountInfo {
  token: string;
  savedAt: string;
}

const KEY = (agent: string) => `agent_account:${agent}`;

/** Thrown when GitHub doesn't accept a token. */
export class AccountError extends Error {}

/** Who a token belongs to, from GitHub. */
export async function lookUpToken(token: string): Promise<AccountInfo> {
  const gh = new GitHubOctokit({ auth: token });
  try {
    const response = await gh.request("GET /user");
    const data = response.data as { login: string; id: number; name?: string | null; avatar_url?: string; type?: string };
    if (data.type && data.type !== "User") throw new AccountError(`The token belongs to ${data.login}, a ${data.type}; use a user account's token.`);
    const scopes = (response.headers as Record<string, string | undefined>)["x-oauth-scopes"];
    return { login: data.login, id: data.id, name: data.name ?? null, avatarUrl: data.avatar_url ?? "", scopes: scopes === undefined ? null : scopes };
  } catch (error) {
    if (error instanceof AccountError) throw error;
    const status = Number((error as { status?: number }).status ?? 0);
    if (status === 401) throw new AccountError("GitHub didn't accept the token: it's wrong, expired or revoked.");
    if (status === 403) throw new AccountError(`GitHub refused the token: ${errorMessage(error)}`);
    throw new AccountError(`Couldn't check the token with GitHub: ${errorMessage(error)}`);
  }
}

/** The registered account: its details, and its token unless it can't be decrypted. */
function stored(agent: string): { info: Omit<Stored, "token">; token: string | null } | null {
  const raw = getSetting(KEY(agent));
  if (!raw) return null;
  let data: Stored;
  try {
    data = JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
  const { token, ...info } = data;
  try {
    return { info, token: unseal(token) };
  } catch {
    return { info, token: null };
  }
}

const UNREADABLE = "Its token can't be decrypted (DATA_DIR/data-key changed?). Register the account again, or remove it to use the GitHub App.";

/** Registers the account a token belongs to for an agent, after checking it with GitHub. */
export async function registerAccount(agent: string, token: string): Promise<AgentAccount> {
  const clean = token.trim();
  if (!clean) throw new AccountError("Paste the account's token.");
  const info = await lookUpToken(clean);
  const savedAt = new Date().toISOString();
  setSetting(KEY(agent), JSON.stringify({ ...info, token: seal(clean), savedAt }));
  forget();
  return { ...info, agent, source: "ui", envVar: null, savedAt };
}

export function removeAccount(agent: string): void {
  deleteSetting(KEY(agent));
  forget();
}

const envInfo = new Map<string, { info: AccountInfo | null; error: string | null; at: number }>();
const clients = new Map<string, GitHubClient>();

function forget(): void {
  envInfo.clear();
  clients.clear();
}

function profileOf(agent: string | Profile): Profile | null {
  return typeof agent === "string" ? (loadProfiles().agents.find((profile) => profile.name === agent) ?? null) : agent;
}

/**
 * The token the agent acts with on GitHub, or null when it uses the App. agent.md's variable wins.
 * Throws when the agent has an account whose token is missing: it never falls back to the App.
 */
export function accountToken(agent: string | Profile): string | null {
  const profile = profileOf(agent);
  const name = typeof agent === "string" ? agent : agent.name;
  const envVar = profile?.github.accountTokenEnv;
  if (envVar) {
    const token = process.env[envVar]?.trim();
    if (!token) throw new AccountError(`${name} acts as a GitHub account, but ${envVar} (github.account_token_env) isn't set.`);
    return token;
  }
  const saved = stored(name);
  if (saved && !saved.token) throw new AccountError(`${name} acts as @${saved.info.login} on GitHub, but: ${UNREADABLE}`);
  return saved?.token ?? null;
}

/** The agent's account, or null when it uses the App. A token from agent.md is looked up once (10 minutes). */
export async function agentAccount(agent: string | Profile): Promise<(AgentAccount & { problem: string | null }) | null> {
  const profile = profileOf(agent);
  const name = typeof agent === "string" ? agent : agent.name;
  const envVar = profile?.github.accountTokenEnv ?? null;
  if (envVar) {
    const token = process.env[envVar]?.trim();
    const empty = { login: "", id: 0, name: null, avatarUrl: "", scopes: null };
    if (!token) return { ...empty, agent: name, source: "env", envVar, savedAt: null, problem: `${envVar} isn't set` };
    let known = envInfo.get(token);
    if (!known || Date.now() - known.at > 10 * 60_000) {
      known = await lookUpToken(token).then(
        (info) => ({ info, error: null, at: Date.now() }),
        (error) => ({ info: null, error: errorMessage(error), at: Date.now() }),
      );
      envInfo.set(token, known);
    }
    return { ...(known.info ?? empty), agent: name, source: "env", envVar, savedAt: null, problem: known.error };
  }
  const saved = stored(name);
  if (!saved) return null;
  return { ...saved.info, agent: name, source: "ui", envVar: null, problem: saved.token ? null : UNREADABLE };
}

type Who = { agent: string; installationId: number };

/** The client an agent's task acts on GitHub with: its account's, or the App installation's. */
export async function clientFor(task: Who): Promise<GitHubClient> {
  const token = accountToken(task.agent);
  if (!token) return installationClient(task.installationId);
  let client = clients.get(token);
  if (!client) {
    client = new GitHubOctokit({ auth: token }) as GitHubClient;
    clients.set(token, client);
  }
  return client;
}

/** The token an agent's git commands use: its account's, or an installation token. */
export async function gitTokenFor(task: Who): Promise<string> {
  return accountToken(task.agent) ?? (await installationToken(task.installationId));
}

/** Who an agent's commits are by: its account (name and noreply address), or the App's bot. */
export async function commitIdentityFor(task: Who): Promise<{ name: string; email: string }> {
  const account = accountToken(task.agent) ? await agentAccount(task.agent) : null;
  if (account?.login) return { name: account.name || account.login, email: noreplyEmail(account.id, account.login) };
  return getBotIdentity(task.installationId);
}

/**
 * The agent whose account a GitHub login is, if any. What these accounts do on GitHub is the
 * agents' own work, so webhooks they cause are ignored like the App's.
 */
export async function agentForLogin(login: string): Promise<string | null> {
  if (!login) return null;
  for (const profile of loadProfiles().agents) {
    if (!profile.github.accountTokenEnv && !getSetting(KEY(profile.name))) continue;
    const account = await agentAccount(profile).catch(() => null);
    if (account?.login && account.login.toLowerCase() === login.toLowerCase()) return profile.name;
  }
  return null;
}

/** What the account can do in a repository: push (write), read, or nothing. */
export async function repositoryAccess(agent: string, owner: string, repo: string): Promise<"write" | "read" | "none"> {
  const token = accountToken(agent);
  if (!token) throw new AccountError(`${agent} has no GitHub account.`);
  const gh = new GitHubOctokit({ auth: token });
  try {
    const { data } = await gh.rest.repos.get({ owner, repo });
    const permissions = data.permissions;
    return permissions?.push || permissions?.admin || permissions?.maintain ? "write" : "read";
  } catch (error) {
    const status = Number((error as { status?: number }).status ?? 0);
    if (status === 404 || status === 403) return "none";
    throw error;
  }
}
