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

/** Like int, but fractions are allowed (minutes given as 0.5). */
function num(name: string, fallback: number): number {
  const parsed = Number(env(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string): string[] {
  return env(name)
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A comma-separated list of label names, lower case (label names may hold spaces). */
function labels(name: string, fallback: string): string[] {
  return env(name, fallback)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item !== "none");
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
  // GitHub users who may sign in to look (viewers) or to run the queue (operators: pause, cancel,
  // retry, run agents, turn them on and off) without changing configuration.
  viewerUsers: list("VIEWER_USERS").map((login) => login.toLowerCase()),
  operatorUsers: list("OPERATOR_USERS").map((login) => login.toLowerCase()),
  adminToken: env("ADMIN_TOKEN"),
  authDisabled: env("AUTH_DISABLED") === "true",
  sessionSecret: env("SESSION_SECRET"),

  maxConcurrent: int("MAX_CONCURRENT_TASKS", 2),
  defaultTimeoutMinutes: int("TASK_TIMEOUT_MINUTES", 60),
  // How often a running task's progress comment is edited (at most), and how many such edits all
  // tasks together may make per hour: GitHub limits how fast content is written. "minimal" posts
  // the comment when a task starts and completes it when it ends, with no edits in between.
  progressUpdateSeconds: int("PROGRESS_UPDATE_SECONDS", 60),
  progressEditsPerHour: Math.max(0, int("PROGRESS_EDITS_PER_HOUR", 300)),
  progressComments: env("PROGRESS_COMMENTS", "edit").toLowerCase() === "minimal" ? "minimal" : "edit",
  // Whether agents post that progress comment at all (live activity). Off: only the result when
  // they finish. Settings (and an agent's github.live_activity) override this starting value.
  liveActivity: env("LIVE_ACTIVITY") === "true",
  historyLimit: int("HISTORY_LIMIT", 10),
  triggerMinPermission: env("TRIGGER_MIN_PERMISSION", "write").toLowerCase(),
  allowedRepos: list("ALLOWED_REPOS").map((repo) => repo.toLowerCase()),
  labelPrefix: env("AGENT_LABEL_PREFIX", "agent:"),
  agentEnvPassthrough: [...DEFAULT_AGENT_ENV, ...list("AGENT_ENV_PASSTHROUGH")],
  agentHome: resolve(env("AGENT_HOME", resolve(env("DATA_DIR", "./data"), "agent-home"))),
  // Claude Code's update checks and telemetry are off by default on the server.
  allowNonessentialTraffic: env("ALLOW_NONESSENTIAL_TRAFFIC") === "true",

  // Model(s) agents switch to when theirs is overloaded or its usage limit is reached, unless an
  // agent sets fallback_model. Comma-separated, tried in order. Empty: none.
  fallbackModel: env("FALLBACK_MODEL"),
  liveIdleMinutes: int("LIVE_SESSION_IDLE_MINUTES", 30),
  maxLiveSessions: int("MAX_LIVE_SESSIONS", 4),
  usageLimitRetries: int("USAGE_LIMIT_RETRIES", 5),
  // A task the orchestrator restarted under (a deploy, a crash) resumes where it left off, up to
  // this many times; on shutdown, running tasks get SHUTDOWN_WAIT_SECONDS to finish first.
  restartResumes: Math.max(0, int("RESTART_RESUMES", 2)),
  shutdownWaitSeconds: Math.max(0, int("SHUTDOWN_WAIT_SECONDS", 20)),
  // Retries when the model API fails to answer (5xx, overloaded, dropped connection): each request
  // is retried this many times by Claude Code, and a task that still fails is retried this many
  // times by the orchestrator, waiting MODEL_ERROR_RETRY_DELAY_SECONDS (doubling) in between.
  modelErrorRetries: Math.max(0, int("MODEL_ERROR_RETRIES", 3)),
  modelErrorRetryDelaySeconds: Math.max(1, int("MODEL_ERROR_RETRY_DELAY_SECONDS", 20)),
  // A task that timed out, went silent or stopped with an error continues in the same session
  // this many times (told what happened) before it fails. 0: it fails at once.
  taskFailureRetries: Math.max(0, int("TASK_FAILURE_RETRIES", 1)),
  // A task whose agent does nothing at all for this long (no reply, no tool call, no tool result)
  // is taken to hang: its turn is stopped and it counts as a failure to retry. 0 = never.
  taskStallMinutes: Math.max(0, num("TASK_STALL_MINUTES", 30)),
  // An agent may pause its task until other work is done (wait_for): for at most this long, this
  // many times per task; what the tasks wait for is looked at again every WAIT_CHECK_SECONDS (and
  // when a webhook says something changed). WAIT_MAX_HOURS=0: agents can't pause.
  waitMaxHours: Math.max(0, num("WAIT_MAX_HOURS", 72)),
  taskMaxWaits: Math.max(1, int("TASK_MAX_WAITS", 3)),
  waitCheckSeconds: Math.max(5, int("WAIT_CHECK_SECONDS", 120)),
  // What agents run instead of the Claude Code bundled with the Agent SDK. It must take the same
  // flags and speak the same stream-json protocol. Empty = the bundled one.
  claudeCodeExecutable: executable("CLAUDE_CODE_EXECUTABLE"),
  // Most pull requests agents may open for one issue (or discussion), open or closed. 0 = no limit.
  maxPullRequestsPerIssue: Math.max(0, int("MAX_PULL_REQUESTS_PER_ISSUE", 0)),
  // Most open agent pull requests per repository before board stages and agent-started work that
  // would open another one wait (people's own requests still run). 0 = no limit.
  maxOpenAgentPullsPerRepo: Math.max(0, int("MAX_OPEN_AGENT_PRS_PER_REPO", 0)),
  // When an agent's pull request conflicts with its base, start that agent to merge the base in.
  rebaseConflictedPulls: env("REBASE_CONFLICTED_PRS", "on").toLowerCase() !== "off",
  // Days after an agent's pull request is merged or closed before its branch is deleted on GitHub
  // (agent/… and ao/issue-… branches only, and not while open pull requests still target it). 0 = never.
  agentBranchCleanupDays: Math.max(0, int("AGENT_BRANCH_CLEANUP_DAYS", 1)),
  // Spending limits for all agents together (US dollars, Claude Code's estimates; UTC days and
  // months). When one is reached, new tasks wait until the next day or month. Settings can change them.
  // Agents' checkouts nobody has used for this many days are removed (unless they hold work that
  // isn't on GitHub). 0 keeps them forever.
  // Daily snapshots of the database and key files (see backup.ts): how many to keep (0 = none),
  // and where (default DATA_DIR/backups; a separate disk or mounted folder is better).
  backupKeep: Math.max(0, int("BACKUP_KEEP", 7)),
  // Prompts and step-by-step logs of tasks that finished longer ago than this are dropped (the
  // task, its reply, cost and links stay). 0 keeps them forever.
  taskDetailRetentionDays: Math.max(0, int("TASK_DETAIL_RETENTION_DAYS", 90)),
  backupDir: env("BACKUP_DIR") ? resolve(env("BACKUP_DIR")) : "",
  // Queued tasks start people's requests first, then agent-started work, then board stages; one
  // that has waited this long goes first. 0 = strictly that order.
  queueAgingMinutes: Math.max(0, int("QUEUE_AGING_MINUTES", 30)),
  // An issue or pull request with one of these labels gets its tasks started before the rest
  // (high) or after the rest (low). "none" turns either off.
  highPriorityLabels: labels("HIGH_PRIORITY_LABELS", "urgent, priority:high, p0"),
  lowPriorityLabels: labels("LOW_PRIORITY_LABELS", "priority:low"),
  // Among tasks of the same standing, whoever has the least running and waiting goes first, so
  // one person or board with many tasks doesn't hold up everyone else. off: oldest first.
  queueFairness: env("QUEUE_FAIRNESS", "on").toLowerCase() !== "off",
  // At most this many tasks run at once in one repository (0 = no limit), so a busy repository
  // leaves room for the others.
  maxRunningPerRepo: Math.max(0, int("MAX_RUNNING_PER_REPO", 0)),
  workspaceRetentionDays: Math.max(0, int("WORKSPACE_RETENTION_DAYS", 14)),
  // Checkouts of closed issues and pull requests go sooner: after this many days unused.
  workspaceClosedRetentionDays: Math.max(0, int("WORKSPACE_CLOSED_RETENTION_DAYS", 2)),
  // New checkouts borrow history from one shared copy per repository (DATA_DIR/mirrors), so each
  // holds little more than its files. off: every checkout is a full clone, as before.
  gitSharedObjects: env("GIT_SHARED_OBJECTS", "on").toLowerCase() !== "off",
  spendLimitDailyUsd: Number(env("SPEND_LIMIT_DAILY_USD", "0")) || 0,
  spendLimitMonthlyUsd: Number(env("SPEND_LIMIT_MONTHLY_USD", "0")) || 0,
  // How many times in a row agents may start each other on related issues (start_related_agent):
  // a task started that way may start another only while the chain is shorter than this. 0 = never.
  maxAgentChain: Math.max(0, int("MAX_AGENT_CHAIN", 3)),

  // Schedules (agents run again and again on a timetable): the time zone a schedule uses when it
  // names none, the shortest time allowed between two runs, how many one agent may have (file
  // schedules included), and how many failed runs in a row pause a schedule (0 = never).
  scheduleTimezone: env("SCHEDULE_TIMEZONE", "UTC"),
  scheduleMinMinutes: Math.max(1, int("SCHEDULE_MIN_MINUTES", 15)),
  schedulesPerAgent: Math.max(0, int("SCHEDULES_PER_AGENT", 20)),
  schedulePauseAfterFailures: Math.max(0, int("SCHEDULE_PAUSE_AFTER_FAILURES", 3)),

  // Run agents as this OS user, which can't read the orchestrator's data (keys, tokens, database).
  // AGENT_ISOLATION: auto (isolate when it works, warn when not), required (refuse to run agents
  // unisolated), off (run agents as the orchestrator's own user).
  agentUser: env("AGENT_USER"),
  // Agents reach the model service through the orchestrator with a per-session credential, so the
  // real key never enters their environment. off: give agents the real credentials.
  modelProxy: env("MODEL_PROXY", "on").toLowerCase() === "off" ? "off" : "on",
  agentIsolation: (["auto", "required", "off"].includes(env("AGENT_ISOLATION", "auto").toLowerCase()) ? env("AGENT_ISOLATION", "auto").toLowerCase() : "auto") as "auto" | "required" | "off",

  // Where to post problems (failed tasks, loop guards, limits): a Slack or Discord incoming
  // webhook, or any URL that takes JSON. Empty: they're only shown in the admin UI and logs.
  alertWebhookUrl: env("ALERT_WEBHOOK_URL"),
  // info | warning | critical: the least severe problem that's posted.
  alertMinSeverity: (["info", "warning", "critical"].includes(env("ALERT_MIN_SEVERITY", "warning")) ? env("ALERT_MIN_SEVERITY", "warning") : "warning") as "info" | "warning" | "critical",
  // Bearer token Prometheus scrapes /metrics with. Empty: /metrics is off.
  metricsToken: env("METRICS_TOKEN"),

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
