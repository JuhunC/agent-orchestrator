import { resolve } from "node:path";

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

  webhookProxyUrl: env("WEBHOOK_PROXY_URL"),
  // Testing hook: clone from `file:///…/{owner}/{repo}.git` instead of GITHUB_URL.
  gitRemoteTemplate: env("GIT_REMOTE_TEMPLATE"),
};

export type Config = typeof config;
