import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App, Octokit } from "octokit";
import { config } from "../config.ts";
import { log } from "../log.ts";

export interface AppCredentials {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
  ownerLogin: string;
  source: "env" | "setup";
}

const credentialsFile = join(config.dataDir, "github-app.json");

export const GitHubOctokit = Octokit.defaults({
  baseUrl: config.github.apiUrl,
  userAgent: "agent-orchestrator",
});
export type GitHubClient = InstanceType<typeof GitHubOctokit>;

let cached: { credentials: AppCredentials; app: App } | null = null;
let slugLookup: Promise<void> | null = null;

function readEnvCredentials(): AppCredentials | null {
  const { appId, webhookSecret, clientId, clientSecret, privateKeyPath } = config.github;
  let privateKey = config.github.privateKey;
  if (!privateKey && privateKeyPath && existsSync(privateKeyPath)) privateKey = readFileSync(privateKeyPath, "utf8");
  if (!appId || !privateKey) return null;
  return {
    appId,
    slug: process.env.GITHUB_APP_SLUG ?? "",
    privateKey,
    webhookSecret,
    clientId,
    clientSecret,
    htmlUrl: "",
    ownerLogin: "",
    source: "env",
  };
}

function readFileCredentials(): AppCredentials | null {
  if (!existsSync(credentialsFile)) return null;
  try {
    const data = JSON.parse(readFileSync(credentialsFile, "utf8")) as AppCredentials;
    return { ...data, source: "setup" };
  } catch (error) {
    log.error("Could not read saved GitHub App credentials", { file: credentialsFile, error: String(error) });
    return null;
  }
}

export function getCredentials(): AppCredentials | null {
  if (cached) return cached.credentials;
  const credentials = readEnvCredentials() ?? readFileCredentials();
  if (!credentials) return null;
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    Octokit: GitHubOctokit,
  });
  cached = { credentials, app };
  if (!credentials.slug) {
    // Env-configured apps don't tell us their slug; ask GitHub once.
    slugLookup ??= app.octokit
      .request("GET /app")
      .then(({ data }) => {
        if (cached && data) {
          cached.credentials.slug = data.slug ?? "";
          cached.credentials.htmlUrl = data.html_url;
          cached.credentials.ownerLogin = (data.owner as { login?: string } | null)?.login ?? "";
        }
      })
      .catch((error) => log.warn("Could not look up the GitHub App", { error: String(error) }))
      .finally(() => (slugLookup = null));
  }
  return credentials;
}

export async function ensureAppDetails(): Promise<AppCredentials | null> {
  const credentials = getCredentials();
  if (slugLookup) await slugLookup;
  return credentials;
}

export function getApp(): App {
  getCredentials();
  if (!cached) throw new Error("The GitHub App is not configured yet. Open the admin UI → Settings to create it.");
  return cached.app;
}

export function saveCredentials(credentials: Omit<AppCredentials, "source">): void {
  writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  cached = null;
  tokens.clear();
  getCredentials();
}

export async function installationClient(installationId: number): Promise<GitHubClient> {
  return (await getApp().getInstallationOctokit(installationId)) as unknown as GitHubClient;
}

const tokens = new Map<number, { token: string; expiresAt: number }>();

/** An installation token for git, reused until five minutes before it expires (GitHub gives them an hour). */
export async function installationToken(installationId: number): Promise<string> {
  const known = tokens.get(installationId);
  if (known && known.expiresAt - Date.now() > 5 * 60_000) return known.token;
  const { data } = await getApp().octokit.request("POST /app/installations/{installation_id}/access_tokens", {
    installation_id: installationId,
  });
  tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) || Date.now() + 30 * 60_000 });
  return data.token;
}

export async function findInstallation(owner: string, repo: string): Promise<number> {
  const { data } = await getApp().octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
  return data.id;
}

let botIdentity: { name: string; email: string } | null = null;

/** The `name[bot]` identity commits are attributed to, so GitHub shows the app's avatar. */
export async function getBotIdentity(installationId: number): Promise<{ name: string; email: string }> {
  if (botIdentity) return botIdentity;
  const credentials = await ensureAppDetails();
  const slug = credentials?.slug || "agent-orchestrator";
  const login = `${slug}[bot]`;
  const host = config.github.isDotCom ? "users.noreply.github.com" : `users.noreply.${new URL(config.github.url).hostname}`;
  try {
    const gh = await installationClient(installationId);
    const { data } = await gh.request("GET /users/{username}", { username: login });
    botIdentity = { name: login, email: `${data.id}+${login}@${host}` };
    return botIdentity;
  } catch {
    return { name: login, email: `${login}@${host}` };
  }
}

export function resetBotIdentity(): void {
  botIdentity = null;
}

/** Clone URL for a repo. Credentials are passed per command, never stored in the remote. */
export function repoRemoteUrl(owner: string, repo: string): string {
  if (config.gitRemoteTemplate) {
    return config.gitRemoteTemplate.replace("{owner}", owner).replace("{repo}", repo);
  }
  return `${config.github.url}/${owner}/${repo}.git`;
}

/**
 * The installation on an account (the org or user that owns a project board). Looks through the
 * app's installations by account name, which behaves the same on github.com and GitHub
 * Enterprise Server, and says where the app is installed when it isn't on `owner`.
 */
export async function findOwnerInstallation(owner: string): Promise<number> {
  const installations = await getApp().octokit.paginate("GET /app/installations", { per_page: 100 });
  const accountName = (installation: (typeof installations)[number]) => {
    const account = installation.account as { login?: string; slug?: string } | null;
    return account?.login ?? account?.slug ?? "";
  };
  const match = installations.find((installation) => accountName(installation).toLowerCase() === owner.toLowerCase());
  if (match) return match.id;
  const where = installations.map(accountName).filter(Boolean);
  throw new Error(
    `The GitHub App isn't installed on "${owner}", which owns this project${where.length ? ` (it's installed on: ${where.join(", ")})` : " (it isn't installed anywhere yet)"}. ` +
      `Install it on ${owner}, or set token_env in the board file to use a token that can see the project.`,
  );
}
