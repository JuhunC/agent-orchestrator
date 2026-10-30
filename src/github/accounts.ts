import { deleteSetting, getSetting, setSetting } from "../db.ts";
import { errorMessage } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import type { Profile } from "../profiles/types.ts";
import { recordIncident } from "../runner/incidents.ts";
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
  /** When the token expires (GitHub says so in a response header), or null when it doesn't. */
  expiresAt?: string | null;
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
    const headers = response.headers as Record<string, string | undefined>;
    const scopes = headers["x-oauth-scopes"];
    // e.g. "2026-12-01 00:00:00 UTC"
    const expiry = headers["github-authentication-token-expiration"];
    const expiresAt = expiry ? new Date(expiry.replace(/ UTC$/, "Z").replace(" ", "T")).toISOString() : null;
    return { login: data.login, id: data.id, name: data.name ?? null, avatarUrl: data.avatar_url ?? "", scopes: scopes === undefined ? null : scopes, expiresAt };
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

/** Like accountToken, but null instead of an error when the account's token is missing. */
export function accountTokenOrNull(agent: string | Profile): string | null {
  try {
    return accountToken(agent);
  } catch {
    return null;
  }
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
    return { ...(known.info ?? empty), agent: name, source: "env", envVar, savedAt: null, problem: known.error ?? (known.info ? expired(known.info) : null) };
  }
  const saved = stored(name);
  if (!saved) return null;
  return { ...saved.info, agent: name, source: "ui", envVar: null, problem: saved.token ? expired(saved.info) : UNREADABLE };
}

function expired(info: AccountInfo): string | null {
  return info.expiresAt && Date.parse(info.expiresAt) <= Date.now() ? `The token expired on ${info.expiresAt.slice(0, 10)}. Make a new one and register it again.` : null;
}

const warned = new Map<string, string>();

/** Warns (Recent problems, alerts) about agents' tokens that expire within two weeks, once a day each. */
export async function checkTokenExpiry(now = Date.now()): Promise<void> {
  for (const profile of loadProfiles().agents) {
    if (!profile.github.accountTokenEnv && !getSetting(KEY(profile.name))) continue;
    const account = await agentAccount(profile).catch(() => null);
    if (!account?.expiresAt) continue;
    const days = Math.floor((Date.parse(account.expiresAt) - now) / 86_400_000);
    if (days > 14) continue;
    const day = new Date(now).toISOString().slice(0, 10);
    if (warned.get(profile.name) === day) continue;
    warned.set(profile.name, day);
    const when = account.expiresAt.slice(0, 10);
    recordIncident(
      "account_token",
      days < 0 ? "critical" : "warning",
      days < 0 ? `${profile.name}'s GitHub token (@${account.login}) expired on ${when}: its tasks fail until a new one is registered.` : `${profile.name}'s GitHub token (@${account.login}) expires on ${when}, in ${days} day${days === 1 ? "" : "s"}. Register a new one on the agent's page.`,
    );
  }
}

export function startAccountChecks(): void {
  const tick = () => void checkTokenExpiry().catch(() => undefined);
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}

type Who = { agent: string; installationId: number };

/**
 * What the orchestrator changed on GitHub as an agent's account in the last few minutes: issues
 * and pull requests (owner/repo#number) and branches it pushed (owner/repo@branch). GitHub sends
 * webhooks for those with the account as the sender; they're the agent's own echo, not a person.
 */
const ownWrites = new Map<string, number>();
const OWN_WINDOW_MS = 5 * 60_000;

export function noteOwnWrite(key: string): void {
  const now = Date.now();
  ownWrites.set(key.toLowerCase(), now);
  if (ownWrites.size > 2000) for (const [entry, at] of ownWrites) if (now - at > OWN_WINDOW_MS) ownWrites.delete(entry);
}

export function isRecentOwnWrite(key: string): boolean {
  const at = ownWrites.get(key.toLowerCase());
  return at !== undefined && Date.now() - at <= OWN_WINDOW_MS;
}

/** Notes the issue, pull request or branch an account's API request changes. */
function noteRequest(options: Record<string, any>, data?: Record<string, any>): void {
  if (String(options.method ?? "GET").toUpperCase() === "GET" || !options.owner || !options.repo) return;
  const repo = `${options.owner}/${options.repo}`;
  const number = options.issue_number ?? options.pull_number ?? data?.number;
  if (number) noteOwnWrite(`${repo}#${number}`);
  for (const branch of [options.head, options.base]) if (typeof branch === "string" && branch) noteOwnWrite(`${repo}@${branch.replace(/^[^:]+:/, "")}`);
}

/** The client an agent's task acts on GitHub with: its account's, or the App installation's. */
export async function clientFor(task: Who): Promise<GitHubClient> {
  const token = accountToken(task.agent);
  if (!token) return installationClient(task.installationId);
  let client = clients.get(token);
  if (!client) {
    const created = new GitHubOctokit({ auth: token }) as GitHubClient;
    // Before (the webhook can beat the response) and after (to learn a new pull request's number).
    created.hook.before("request", (options) => noteRequest(options as Record<string, any>));
    created.hook.after("request", (response, options) => noteRequest(options as Record<string, any>, response.data as Record<string, any>));
    client = created;
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

/** Agents' GitHub accounts: login (lower case) → agent names. */
export async function accountLogins(): Promise<Map<string, string[]>> {
  const logins = new Map<string, string[]>();
  for (const profile of loadProfiles().agents) {
    if (!profile.github.accountTokenEnv && !getSetting(KEY(profile.name))) continue;
    const account = await agentAccount(profile).catch(() => null);
    if (account?.login) logins.set(account.login.toLowerCase(), [...(logins.get(account.login.toLowerCase()) ?? []), profile.name]);
  }
  return logins;
}

/** The agent whose account a GitHub login is, if any (the first, when agents share one). */
export async function agentForLogin(login: string): Promise<string | null> {
  if (!login) return null;
  return (await accountLogins()).get(login.toLowerCase())?.[0] ?? null;
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
