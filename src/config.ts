import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string): string[] {
  return env(name)
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** A path is resolved against the working directory; a bare command name is looked up on PATH. */
function executable(name: string): string {
  const value = env(name);
  if (!value || value.includes("/")) return value && resolve(value);
  const dir = (process.env.PATH ?? "").split(delimiter).find((entry) => entry && existsSync(join(entry, value)));
  return dir ? join(dir, value) : value;
}

const port = int("PORT", 3000);
const githubUrl = trimSlash(env("GITHUB_URL", "https://github.com"));
const isDotCom = /^https?:\/\/(www\.)?github\.com$/i.test(githubUrl);

// What agent processes may see from the server's environment: the model provider settings
// (your own Anthropic-compatible service works through ANTHROPIC_BASE_URL) and proxies.
// The GitHub App key, webhook secret and admin token are never passed on.
const DEFAULT_AGENT_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_MAX_RETRIES",
  "MAX_THINKING_TOKENS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "TZ",
];

export const config = {
  port,
  host: env("HOST", "0.0.0.0"),
  publicUrl: trimSlash(env("PUBLIC_URL", `http://localhost:${port}`)),
  dataDir: resolve(env("DATA_DIR", "./data")),
  profilesDir: resolve(env("PROFILES_DIR", "./profiles")),
  // Example profiles copied into an empty PROFILES_DIR on first start (the image sets this).
  defaultProfilesDir: env("DEFAULT_PROFILES_DIR") ? resolve(env("DEFAULT_PROFILES_DIR")) : "",
  webDistDir: resolve(env("WEB_DIST_DIR", "./web/dist")),

  github: {
    url: githubUrl,
    apiUrl: trimSlash(env("GITHUB_API_URL", isDotCom ? "https://api.github.com" : `${githubUrl}/api/v3`)),
    isDotCom,
    appId: env("GITHUB_APP_ID"),
    privateKey: env("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    privateKeyPath: env("GITHUB_APP_PRIVATE_KEY_PATH"),
    webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
    clientId: env("GITHUB_CLIENT_ID"),
    clientSecret: env("GITHUB_CLIENT_SECRET"),
  },

  adminUsers: list("ADMIN_USERS").map((login) => login.toLowerCase()),
  adminToken: env("ADMIN_TOKEN"),
  authDisabled: env("AUTH_DISABLED") === "true",
  sessionSecret: env("SESSION_SECRET"),

  maxConcurrent: int("MAX_CONCURRENT_TASKS", 2),
  defaultTimeoutMinutes: int("TASK_TIMEOUT_MINUTES", 60),
  progressUpdateSeconds: int("PROGRESS_UPDATE_SECONDS", 20),
  historyLimit: int("HISTORY_LIMIT", 10),
  triggerMinPermission: env("TRIGGER_MIN_PERMISSION", "write").toLowerCase(),
  allowedRepos: list("ALLOWED_REPOS").map((repo) => repo.toLowerCase()),
  labelPrefix: env("AGENT_LABEL_PREFIX", "agent:"),
  agentEnvPassthrough: [...DEFAULT_AGENT_ENV, ...list("AGENT_ENV_PASSTHROUGH")],
  agentHome: resolve(env("AGENT_HOME", resolve(env("DATA_DIR", "./data"), "agent-home"))),
  // Claude Code's update checks and telemetry are off by default on the server.
  allowNonessentialTraffic: env("ALLOW_NONESSENTIAL_TRAFFIC") === "true",

  liveIdleMinutes: int("LIVE_SESSION_IDLE_MINUTES", 30),
  maxLiveSessions: int("MAX_LIVE_SESSIONS", 4),
  usageLimitRetries: int("USAGE_LIMIT_RETRIES", 5),
  // Retries when the model API fails to answer (5xx, overloaded, dropped connection): each request
  // is retried this many times by Claude Code, and a task that still fails is retried this many
  // times by the orchestrator, waiting MODEL_ERROR_RETRY_DELAY_SECONDS (doubling) in between.
  modelErrorRetries: Math.max(0, int("MODEL_ERROR_RETRIES", 3)),
  modelErrorRetryDelaySeconds: Math.max(1, int("MODEL_ERROR_RETRY_DELAY_SECONDS", 20)),
  // What agents run instead of the Claude Code bundled with the Agent SDK. It must take the same
  // flags and speak the same stream-json protocol. Empty = the bundled one.
  claudeCodeExecutable: executable("CLAUDE_CODE_EXECUTABLE"),
  // Most pull requests agents may open for one issue (or discussion), open or closed. 0 = no limit.
  maxPullRequestsPerIssue: Math.max(0, int("MAX_PULL_REQUESTS_PER_ISSUE", 0)),
  // Spending limits for all agents together (US dollars, Claude Code's estimates; UTC days and
  // months). When one is reached, new tasks wait until the next day or month. Settings can change them.
  // Agents' checkouts nobody has used for this many days are removed (unless they hold work that
  // isn't on GitHub). 0 keeps them forever.
  // Queued tasks start people's requests first, then agent-started work, then board stages; one
  // that has waited this long goes first. 0 = strictly that order.
  queueAgingMinutes: Math.max(0, int("QUEUE_AGING_MINUTES", 30)),
  workspaceRetentionDays: Math.max(0, int("WORKSPACE_RETENTION_DAYS", 14)),
  spendLimitDailyUsd: Number(env("SPEND_LIMIT_DAILY_USD", "0")) || 0,
  spendLimitMonthlyUsd: Number(env("SPEND_LIMIT_MONTHLY_USD", "0")) || 0,
  // How many times in a row agents may start each other on related issues (start_related_agent):
  // a task started that way may start another only while the chain is shorter than this. 0 = never.
  maxAgentChain: Math.max(0, int("MAX_AGENT_CHAIN", 3)),

  // Run agents as this OS user, which can't read the orchestrator's data (keys, tokens, database).
  // AGENT_ISOLATION: auto (isolate when it works, warn when not), required (refuse to run agents
  // unisolated), off (run agents as the orchestrator's own user).
  agentUser: env("AGENT_USER"),
  // Agents reach the model service through the orchestrator with a per-session credential, so the
  // real key never enters their environment. off: give agents the real credentials.
  modelProxy: env("MODEL_PROXY", "on").toLowerCase() === "off" ? "off" : "on",
  agentIsolation: (["auto", "required", "off"].includes(env("AGENT_ISOLATION", "auto").toLowerCase()) ? env("AGENT_ISOLATION", "auto").toLowerCase() : "auto") as "auto" | "required" | "off",

  webhookProxyUrl: env("WEBHOOK_PROXY_URL"),
  // Testing hook: clone from `file:///…/{owner}/{repo}.git` instead of GITHUB_URL.
  gitRemoteTemplate: env("GIT_REMOTE_TEMPLATE"),
};

export type Config = typeof config;

// With a separate agent user, what the orchestrator writes is private unless shared on purpose
// (workspaces, the agent's home, skills): set before the database file is created.
if (config.agentUser && config.agentIsolation !== "off") process.umask(0o077);

/** Is owner/repo in ALLOWED_REPOS (or is every repository allowed)? */
export function repoAllowed(fullName: string): boolean {
  if (!config.allowedRepos.length) return true;
  const [owner] = fullName.toLowerCase().split("/");
  return config.allowedRepos.some((pattern) => pattern === fullName.toLowerCase() || pattern === `${owner}/*`);
}
