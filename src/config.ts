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

// Credentials the agents may need. Everything else in the orchestrator's
// environment (GitHub App key, webhook secret, admin token) stays out of the
// agent process.
const DEFAULT_AGENT_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "TZ",
];

export const config = {
  port,
  host: env("HOST", "0.0.0.0"),
  publicUrl: trimSlash(env("PUBLIC_URL", `http://localhost:${port}`)),
  dataDir: resolve(env("DATA_DIR", "./data")),
  agentsConfigPath: resolve(env("AGENTS_CONFIG", "./config/agents.yaml")),
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

  webhookProxyUrl: env("WEBHOOK_PROXY_URL"),
  // Testing hook: clone from `file:///…/{owner}/{repo}.git` instead of GITHUB_URL.
  gitRemoteTemplate: env("GIT_REMOTE_TEMPLATE"),
};

export type Config = typeof config;
