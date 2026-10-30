import { randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, constants, existsSync, rmSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { bus, type BusMessage } from "../bus.ts";
import { config } from "../config.ts";
import {
  createTask,
  getSetting,
  getTask,
  linkedThreads,
  listDeliveries,
  listEvents,
  listTasks,
  listThreads,
  setForgotten,
  setSetting,
  taskStats,
  tasksForThread,
  listBoardItems,
  listHandoffs,
  tasksStartedBy,
  databaseSize,
} from "../db.ts";
import { addressCheck, appAddresses, ensureAppDetails, findInstallation, getApp, getCredentials, installationClient, resetBotIdentity, saveCredentials, setAppWebhookUrl } from "../github/app.ts";
import { AccountError, accountToken, agentAccount, lookUpToken, registerAccount, removeAccount, repositoryAccess } from "../github/accounts.ts";
import { errorMessage } from "../log.ts";
import { scheduler } from "../runner/scheduler.ts";
import { cleanUpWorkspaces, lastCleanup } from "../runtime/cleanup.ts";
import { backUp, backupDir, listBackups } from "../runtime/backup.ts";
import { isolationStatus } from "../runtime/isolation.ts";
import { setSpendLimits, spendBlockReason, spendStatus } from "../runner/spend.ts";
import { queueOrder } from "../runner/queue-order.ts";
import { listIncidents, renderMetrics } from "../runner/incidents.ts";
import { outcomeReport } from "../runner/outcomes.ts";
import { MAX_COMMENTS_PER_TASK, MAX_SUB_ISSUES_PER_TASK } from "../runtime/github-tools.ts";
import { MAX_RELATED_STARTS_PER_TASK } from "../runtime/related-agents.ts";
import { workspaceDir } from "../runtime/workspace.ts";
import { loadProfiles, setProfileEnabled } from "../profiles/loader.ts";
import { configReference } from "../profiles/reference.ts";
import type { Profile } from "../profiles/types.ts";
import {
  addToGroup,
  applyToGroup,
  createAgent,
  deleteProfileFile,
  duplicateAgent,
  listProfileFiles,
  ProfileFileError,
  readProfileFile,
  setAgentModel,
  writeProfileFile,
} from "../profiles/store.ts";
import { sessions } from "../runtime/manager.ts";
import { boardStatus, forgetProjectCache, pollInterval, syncBoard } from "../boards/engine.ts";
import { loadBoards } from "../boards/loader.ts";
import { clearLimit, getLimit } from "../runner/limit-store.ts";
import { startManualTask } from "../triggers.ts";
import { usageReport } from "../runner/usage-report.ts";
import { registerScheduleRoutes } from "./schedules-api.ts";
import type { Task, ThreadKind, ThreadRef } from "../types.ts";

const KINDS: ThreadKind[] = ["issue", "pull", "discussion"];

function agentView(profile: Profile) {
  const { ownMcp, ...rest } = profile;
  return {
    ...rest,
    ownMcp: Object.keys(ownMcp),
    ownSkills: profile.ownSkills.map((skill) => ({ name: skill.name, description: skill.description })),
    dir: undefined,
  };
}

function modelView() {
  const base = process.env.ANTHROPIC_BASE_URL;
  const auth = process.env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : null;
  return {
    baseUrl: base ? new URL(base).origin : "https://api.anthropic.com",
    custom: Boolean(base),
    model: process.env.ANTHROPIC_MODEL ?? null,
    credential: auth,
    limit: getLimit(),
  };
}

/** A task in a chain of agents starting each other, for the task page. */
function chainEntry(task: Task) {
  return { id: task.id, agent: task.agent, owner: task.owner, repo: task.repo, threadKind: task.threadKind, threadNumber: task.threadNumber, threadTitle: task.threadTitle, triggerKind: task.triggerKind, status: task.status, board: task.board, boardColumn: task.boardColumn, createdAt: task.createdAt };
}

/**
 * Who started whom around a task: the tasks that led to it (oldest first) and those it led to,
 * as a tree (agents starting agents on related issues, and board stages their moves started).
 */
function taskChain(task: Task) {
  const ancestors: ReturnType<typeof chainEntry>[] = [];
  const seen = new Set<number>([task.id]);
  let current = task.startedByTask ? getTask(task.startedByTask) : null;
  while (current && !seen.has(current.id) && ancestors.length < 50) {
    seen.add(current.id);
    ancestors.unshift(chainEntry(current));
    current = current.startedByTask ? getTask(current.startedByTask) : null;
  }
  type Node = ReturnType<typeof chainEntry> & { started: Node[] };
  let budget = 200;
  const descend = (from: Task): Node[] =>
    tasksStartedBy(from.id)
      .filter((child) => !seen.has(child.id) && budget-- > 0)
      .map((child) => {
        seen.add(child.id);
        return { ...chainEntry(child), started: descend(child) };
      });
  return { ancestors, started: descend(task) };
}

function threadRef(params: { owner: string; repo: string; kind: string; number: string }): ThreadRef {
  if (!KINDS.includes(params.kind as ThreadKind)) throw new Error(`Unknown thread kind ${params.kind}`);
  return { owner: params.owner, repo: params.repo, kind: params.kind as ThreadKind, number: Number(params.number) };
}

function settingsView() {
  return {
    paused: scheduler.paused,
    maxConcurrent: scheduler.maxConcurrent,
    /** Lower than maxConcurrent while recovering from the model service's rate limits. */
    effectiveConcurrent: scheduler.effectiveConcurrent(),
    running: scheduler.runningIds().length,
    liveIdleMinutes: sessions.idleMinutes,
    maxLiveSessions: sessions.maxLive,
    usageLimitRetries: config.usageLimitRetries,
    isolation: isolationStatus(),
    spend: spendStatus(),
    workspaces: { retentionDays: config.workspaceRetentionDays, lastCleanup: lastCleanup() },
    spendBlocked: spendBlockReason(),
  };
}

async function setupView() {
  const credentials = await ensureAppDetails();
  const webhookUrl = config.webhookProxyUrl || `${config.publicUrl}/api/github/webhooks`;
  const addresses = credentials ? await appAddresses() : null;
  const check = addresses ? addressCheck(addresses) : null;
  return {
    configured: Boolean(credentials),
    callbackUrl: `${config.publicUrl}/api/auth/github/callback`,
    appAddresses: addresses,
    callbackProblem: check?.callbackProblem ?? null,
    webhookProblem: check?.webhookProblem ?? null,
    app: credentials
      ? {
          appId: credentials.appId,
          slug: credentials.slug,
          htmlUrl: credentials.htmlUrl,
          ownerLogin: credentials.ownerLogin,
          source: credentials.source,
          githubLogin: Boolean(credentials.clientId && credentials.clientSecret),
          installUrl: credentials.slug ? `${config.github.url}/apps/${credentials.slug}/installations/new` : null,
        }
      : null,
    githubUrl: config.github.url,
    apiUrl: config.github.apiUrl,
    publicUrl: config.publicUrl,
    webhookUrl,
    webhookProxy: Boolean(config.webhookProxyUrl),
    adminUsers: config.adminUsers,
    triggerMinPermission: config.triggerMinPermission,
    allowedRepos: config.allowedRepos,
    labelPrefix: config.labelPrefix,
    defaultTimeoutMinutes: config.defaultTimeoutMinutes,
    profilesDir: config.profilesDir,
  };
}

function appManifest(name: string) {
  const webhookUrl = config.webhookProxyUrl || `${config.publicUrl}/api/github/webhooks`;
  return {
    name,
    url: config.publicUrl,
    description: "Runs AI agents when they are mentioned or assigned on issues, pull requests and discussions.",
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: `${config.publicUrl}/api/setup/callback`,
    callback_urls: [`${config.publicUrl}/api/auth/github/callback`],
    public: false,
    default_permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      discussions: "write",
      workflows: "write",
      checks: "read",
      statuses: "read",
      metadata: "read",
      organization_projects: "write",
    },
    default_events: [
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "discussion",
      "discussion_comment",
      "projects_v2_item",
    ],
  };
}

export function registerApi(app: FastifyInstance): void {
  registerScheduleRoutes(app);
  // ---------- live stream ----------
  app.get("/api/stream", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (message: BusMessage) => reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
    reply.raw.write(`retry: 3000\n\n`);
    const unsubscribe = bus.subscribe(send);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
    request.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---------- overview ----------
  app.get("/api/overview", async () => {
    const stats = taskStats();
    return {
      agents: loadProfiles().agents.map((agent) => ({ ...agentView(agent), stats: stats[agent.name] ?? null })),
      sessions: sessions.list(),
      model: modelView(),
      running: listTasks({ status: "running", limit: 50 }),
      queued: queueOrder(listTasks({ status: "queued", limit: 100 })),
      incidents: listIncidents(20).filter((incident) => Date.now() - Date.parse(incident.ts) < 7 * 86_400_000),
      recent: listTasks({ status: "succeeded,failed,cancelled", limit: 15 }),
      settings: settingsView(),
      configured: Boolean(getCredentials()),
    };
  });

  // ---------- tasks ----------
  app.get<{ Querystring: { status?: string; agent?: string; repo?: string; limit?: string; before?: string } }>("/api/tasks", async (request) => {
    const { status, agent, repo, limit, before } = request.query;
    return listTasks({ status, agent, repo, limit: limit ? Number(limit) : 50, beforeId: before ? Number(before) : undefined });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = getTask(Number(request.params.id));
    if (!task) return reply.code(404).send({ error: "Task not found" });
    return { task, events: listEvents(task.id, Number(request.query.after ?? 0)), chain: request.query.after ? undefined : taskChain(task) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    if (!scheduler.cancel(Number(request.params.id))) return reply.code(409).send({ error: "That task is not queued or running" });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request, reply) => {
    const original = getTask(Number(request.params.id));
    if (!original) return reply.code(404).send({ error: "Task not found" });
    const task = createTask({
      agent: original.agent,
      installationId: original.installationId,
      owner: original.owner,
      repo: original.repo,
      threadKind: original.threadKind,
      threadNumber: original.threadNumber,
      threadTitle: original.threadTitle,
      threadUrl: original.threadUrl,
      triggerKind: "retry",
      requestedBy: original.requestedBy,
      requestText: original.requestText,
      requestUrl: original.requestUrl,
      retryOf: original.id,
      dryRun: original.dryRun,
    });
    bus.publish({ type: "task", task });
    scheduler.kick();
    return task;
  });

  /**
   * Replays a task as a dry run with the agent's current profile: the same thread and request,
   * in its own checkout and session, with nothing changed on GitHub. For trying a prompt change.
   */
  app.post<{ Params: { id: string } }>("/api/tasks/:id/replay", async (request, reply) => {
    const original = getTask(Number(request.params.id));
    if (!original) return reply.code(404).send({ error: "Task not found" });
    if (!loadProfiles().agents.some((agent) => agent.name === original.agent)) return reply.code(400).send({ error: `${original.agent} no longer exists` });
    const task = createTask({
      agent: original.agent,
      installationId: original.installationId,
      owner: original.owner,
      repo: original.repo,
      threadKind: original.threadKind,
      threadNumber: original.threadNumber,
      threadTitle: original.threadTitle,
      threadUrl: original.threadUrl,
      triggerKind: "manual",
      requestedBy: request.adminLogin ?? original.requestedBy,
      requestText: original.requestText,
      requestUrl: original.requestUrl,
      retryOf: original.id,
      board: original.board,
      boardColumn: original.boardColumn,
      boardItemId: original.boardItemId,
      dryRun: true,
    });
    bus.publish({ type: "task", task });
    scheduler.kick();
    return task;
  });

  app.post<{ Body: { agent: string; repo: string; number: number; kind?: ThreadKind | "auto"; instruction: string } }>("/api/tasks", async (request, reply) => {
    const { agent, repo, number, instruction } = request.body ?? ({} as never);
    const [owner, name] = String(repo ?? "").split("/");
    if (!owner || !name || !number || !instruction?.trim()) return reply.code(400).send({ error: "Agent, owner/repo, number and instruction are required" });
    try {
      const installationId = await findInstallation(owner, name);
      let kind = request.body.kind && request.body.kind !== "auto" ? request.body.kind : null;
      if (!kind) {
        const gh = await installationClient(installationId);
        const { data } = await gh.rest.issues.get({ owner, repo: name, issue_number: Number(number) });
        kind = data.pull_request ? "pull" : "issue";
      }
      const id = await startManualTask({
        agentName: agent,
        owner,
        repo: name,
        kind,
        number: Number(number),
        instruction: instruction.trim(),
        requestedBy: request.adminLogin ?? "admin",
        installationId,
      });
      return { id };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/tasks/cancel-all", async () => ({ cancelled: scheduler.cancelAll() }));

  // ---------- agents & profiles ----------
  app.get("/api/agents", async () => {
    const stats = taskStats();
    const profiles = loadProfiles();
    return {
      agents: await Promise.all(profiles.agents.map(async (agent) => ({ ...agentView(agent), stats: stats[agent.name] ?? null, account: await agentAccount(agent).catch(() => null) }))),
      library: {
        skills: Object.values(profiles.library.skills).map((skill) => ({ name: skill.name, description: skill.description })),
        roles: Object.values(profiles.library.roles).map((role) => ({ name: role.name, description: role.description, tools: role.tools, model: role.model })),
        mcp: Object.entries(profiles.library.mcp).map(([name, server]) => ({ name, type: server.type, target: server.url ?? server.command })),
      },
      groups: profiles.groups,
      errors: [...profiles.errors.map((error) => `${error.file}: ${error.message}`), ...profiles.library.errors],
      profilesDir: config.profilesDir,
    };
  });

  app.post<{ Body: { name: string; handle: string } }>("/api/agents", async (request, reply) => {
    try {
      createAgent(String(request.body?.name ?? ""), String(request.body?.handle ?? ""), request.adminLogin ?? "admin");
      bus.publish({ type: "agents" });
      return { ok: true };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { name: string }; Body: { enabled: boolean } }>("/api/agents/:name/enabled", async (request, reply) => {
    if (!loadProfiles().agents.some((agent) => agent.name === request.params.name)) return reply.code(404).send({ error: "Agent not found" });
    setProfileEnabled(request.params.name, Boolean(request.body?.enabled));
    bus.publish({ type: "agents" });
    scheduler.kick();
    return { ok: true };
  });

  app.patch<{ Params: { name: string }; Body: { model?: string | null; effort?: string | null } }>("/api/agents/:name", async (request, reply) => {
    try {
      setAgentModel(request.params.name, request.body?.model?.trim() || null, request.body?.effort || null, request.adminLogin ?? "admin");
      bus.publish({ type: "agents" });
      return { ok: true };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  // The GitHub account an agent acts as (instead of the App). The token never leaves the server.
  app.put<{ Params: { name: string }; Body: { token?: string } }>("/api/agents/:name/github-account", async (request, reply) => {
    const profile = loadProfiles().agents.find((agent) => agent.name === request.params.name);
    if (!profile) return reply.code(404).send({ error: "Agent not found" });
    if (profile.github.accountTokenEnv) return reply.code(400).send({ error: `${profile.name}'s agent.md sets github.account_token_env (${profile.github.accountTokenEnv}), which takes precedence. Remove it there to register an account here.` });
    try {
      const account = await registerAccount(profile.name, String(request.body?.token ?? ""));
      bus.publish({ type: "agents" });
      const admins = config.adminUsers.includes(account.login.toLowerCase());
      return {
        account,
        warning: admins && profile.github.accountMentions ? `@${account.login} is in ADMIN_USERS, so it looks like a person's account: mentions of @${account.login} now start ${profile.name}. Set github.account_mentions: false in its agent.md if that's not wanted.` : null,
      };
    } catch (error) {
      return reply.code(error instanceof AccountError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { name: string } }>("/api/agents/:name/github-account", async (request, reply) => {
    if (!loadProfiles().agents.some((agent) => agent.name === request.params.name)) return reply.code(404).send({ error: "Agent not found" });
    removeAccount(request.params.name);
    bus.publish({ type: "agents" });
    return { ok: true };
  });

  /** Checks the token still works, and which repositories the account can push to. */
  app.post<{ Params: { name: string }; Body: { repository?: string } }>("/api/agents/:name/github-account/check", async (request, reply) => {
    const profile = loadProfiles().agents.find((agent) => agent.name === request.params.name);
    if (!profile) return reply.code(404).send({ error: "Agent not found" });
    const account = await agentAccount(profile);
    if (!account) return reply.code(400).send({ error: `${profile.name} has no GitHub account; it acts as the GitHub App.` });
    if (account.problem) return { ok: false, problem: account.problem, repositories: [] };
    try {
      const token = accountToken(profile)!;
      const info = await lookUpToken(token);
      if (info.login.toLowerCase() !== account.login.toLowerCase()) throw new AccountError(`The token now belongs to @${info.login}, not @${account.login}. Register it again.`);
    } catch (error) {
      return { ok: false, problem: errorMessage(error), repositories: [] };
    }
    const wanted = String(request.body?.repository ?? "").trim();
    if (wanted && !/^[\w.-]+\/[\w.-]+$/.test(wanted)) return reply.code(400).send({ error: "Give the repository as owner/name." });
    const names = new Set<string>(wanted ? [wanted] : []);
    for (const task of listTasks({ agent: profile.name, limit: 100 })) names.add(`${task.owner}/${task.repo}`);
    for (const pattern of config.allowedRepos) if (!pattern.endsWith("/*")) names.add(pattern);
    const repositories = await Promise.all(
      [...names].slice(0, 20).map(async (full) => {
        const [owner, repo] = full.split("/") as [string, string];
        const access = await repositoryAccess(profile.name, owner, repo).catch((error) => `error: ${errorMessage(error)}`);
        return { repository: full, access };
      }),
    );
    return { ok: true, problem: null, login: account.login, repositories };
  });

  app.post<{ Params: { name: string }; Body: { name?: string; handle?: string; count?: number; group?: string } }>("/api/agents/:name/duplicate", async (request, reply) => {
    try {
      const created = duplicateAgent(request.params.name, request.body ?? {}, request.adminLogin ?? "admin");
      bus.publish({ type: "agents" });
      return { created };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { name: string }; Body: { model?: string | null; effort?: string | null; enabled?: boolean } }>("/api/groups/:name/apply", async (request, reply) => {
    try {
      const body = request.body ?? {};
      const members = applyToGroup(request.params.name, { model: body.model, effort: body.effort }, request.adminLogin ?? "admin");
      if (typeof body.enabled === "boolean") for (const member of members) setProfileEnabled(member, body.enabled);
      bus.publish({ type: "agents" });
      scheduler.kick();
      return { members };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { name: string }; Body: { agents: string[] } }>("/api/groups/:name/members", async (request, reply) => {
    try {
      addToGroup(request.params.name, (request.body?.agents ?? []).map(String), request.adminLogin ?? "admin");
      bus.publish({ type: "agents" });
      return { ok: true };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  // Spend and tokens per agent, day and model (Claude Code's estimates).
  app.get<{ Querystring: { days?: string; agent?: string } }>("/api/usage", async (request) =>
    usageReport(Number(request.query.days ?? 30) || 30, request.query.agent ? String(request.query.agent) : undefined),
  );

  app.get("/api/profiles/files", async () => listProfileFiles());

  // What each kind of profile file can contain, with the skills, agents, … that exist now.
  app.get("/api/profiles/reference", async () => configReference(loadProfiles()));

  // ---------- project boards ----------
  app.get("/api/boards", async () => {
    const profiles = loadProfiles();
    const { boards, errors } = loadBoards(profiles);
    return {
      boards: boards.map((board) => ({
        name: board.name,
        file: `boards/${board.name}.yaml`,
        project: `${board.owner}/${board.projectNumber}`,
        statusField: board.statusField,
        needsHuman: board.needsHuman,
        pollSeconds: pollInterval(board),
        limits: board.limits,
        columns: Object.values(board.columns).map((column) => ({ ...column, role: undefined, roleText: column.roleName ? null : column.role.slice(0, 300) })),
        workTypes: board.workTypes,
        subIssues: board.subIssues,
        fields: board.fields,
        errors: board.errors,
        status: boardStatus(board.name),
        items: listBoardItems(board.name).slice(0, 200),
      })),
      errors: errors.map((error) => `${error.file}: ${error.message}`),
      agents: profiles.agents.map((agent) => agent.name),
      roles: Object.keys(profiles.library.roles),
    };
  });

  app.post<{ Params: { name: string } }>("/api/boards/:name/sync", async (request, reply) => {
    const board = loadBoards().boards.find((candidate) => candidate.name === request.params.name);
    if (!board) return reply.code(404).send({ error: "No such board" });
    forgetProjectCache();
    await syncBoard(board);
    return boardStatus(board.name);
  });

  app.get<{ Params: { name: string; item: string } }>("/api/boards/:name/items/:item/handoffs", async (request) => listHandoffs(request.params.name, request.params.item));

  app.get<{ Querystring: { path: string } }>("/api/profiles/file", async (request, reply) => {
    try {
      return { path: request.query.path, content: readProfileFile(String(request.query.path ?? "")) };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError ? 404 : 500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: { path: string; content: string } }>("/api/profiles/file", async (request, reply) => {
    try {
      writeProfileFile(String(request.body?.path ?? ""), String(request.body?.content ?? ""), request.adminLogin ?? "admin");
      bus.publish({ type: "agents" });
      return { ok: true };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError || error instanceof SyntaxError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Querystring: { path: string } }>("/api/profiles/file", async (request, reply) => {
    try {
      deleteProfileFile(String(request.query.path ?? ""), request.adminLogin ?? "admin");
      bus.publish({ type: "agents" });
      return { ok: true };
    } catch (error) {
      return reply.code(error instanceof ProfileFileError ? 400 : 500).send({ error: errorMessage(error) });
    }
  });

  // ---------- sessions & limits ----------
  app.get("/api/sessions", async () => sessions.list());

  app.delete<{ Params: { key: string } }>("/api/sessions/:key", async (request, reply) => {
    const session = sessions.list().find((entry) => entry.key === request.params.key);
    if (!session) return reply.code(404).send({ error: "No such session" });
    if (session.busy) return reply.code(409).send({ error: "The session is working on a task; stop the task instead" });
    sessions.close(request.params.key, "closed from the admin UI");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/run-now", async (request, reply) => {
    if (!scheduler.runNow(Number(request.params.id))) return reply.code(409).send({ error: "That task isn't waiting" });
    return { ok: true };
  });

  app.delete("/api/limit", async () => {
    clearLimit();
    scheduler.kick();
    return { ok: true };
  });

  app.get("/api/model", async () => modelView());

  // ---------- history ----------
  app.get("/api/threads", async () => listThreads(200));

  app.get<{ Params: { owner: string; repo: string; kind: string; number: string } }>("/api/threads/:owner/:repo/:kind/:number", async (request) => {
    const ref = threadRef(request.params);
    const tasks = tasksForThread(ref);
    const agents = [...new Set(tasks.map((task) => task.agent))];
    return {
      ref,
      tasks,
      links: linkedThreads(ref),
      workspaces: agents.map((agent) => ({
        agent,
        exists: existsSync(workspaceDir({ owner: ref.owner, repo: ref.repo, agent, threadKind: ref.kind, threadNumber: ref.number })),
      })),
    };
  });

  app.post<{ Params: { owner: string; repo: string; kind: string; number: string }; Body: { agent?: string; forgotten: boolean } }>(
    "/api/threads/:owner/:repo/:kind/:number/memory",
    async (request) => {
      setForgotten(threadRef(request.params), request.body?.agent ?? null, Boolean(request.body?.forgotten));
      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; kind: string; number: string }; Querystring: { agent: string } }>(
    "/api/threads/:owner/:repo/:kind/:number/workspace",
    async (request, reply) => {
      const ref = threadRef(request.params);
      const busy = listTasks({ status: "running,queued", agent: request.query.agent, repo: `${ref.owner}/${ref.repo}` }).some(
        (task) => task.threadKind === ref.kind && task.threadNumber === ref.number,
      );
      if (busy) return reply.code(409).send({ error: "The agent is still working on this thread" });
      rmSync(workspaceDir({ owner: ref.owner, repo: ref.repo, agent: request.query.agent, threadKind: ref.kind, threadNumber: ref.number }), {
        recursive: true,
        force: true,
      });
      return { ok: true };
    },
  );

  // ---------- deliveries ----------
  app.get("/api/deliveries", async () => listDeliveries(300));

  // ---------- settings ----------
  app.get("/api/settings", async () => ({ ...settingsView(), setup: await setupView() }));

  app.put<{ Body: { paused?: boolean; maxConcurrent?: number; liveIdleMinutes?: number; maxLiveSessions?: number; spendLimitDailyUsd?: number | null; spendLimitMonthlyUsd?: number | null } }>("/api/settings", async (request) => {
    if (typeof request.body?.paused === "boolean") scheduler.setPaused(request.body.paused);
    const limits: { dailyUsd?: number | null; monthlyUsd?: number | null } = {};
    if (request.body && "spendLimitDailyUsd" in request.body) limits.dailyUsd = Number(request.body.spendLimitDailyUsd) || null;
    if (request.body && "spendLimitMonthlyUsd" in request.body) limits.monthlyUsd = Number(request.body.spendLimitMonthlyUsd) || null;
    if (Object.keys(limits).length) {
      setSpendLimits(limits);
      scheduler.kick();
    }
    if (typeof request.body?.maxConcurrent === "number") scheduler.setMaxConcurrent(request.body.maxConcurrent);
    sessions.configure({ idleMinutes: request.body?.liveIdleMinutes, maxLive: request.body?.maxLiveSessions });
    return settingsView();
  });

  app.post("/api/workspaces/cleanup", async () => cleanUpWorkspaces());

  app.get("/api/backups", async () => ({ dir: backupDir(), keep: config.backupKeep, database: databaseSize(), detailRetentionDays: config.taskDetailRetentionDays, backups: listBackups().map(({ path: _path, ...backup }) => backup) }));
  app.post("/api/backups", async (_request, reply) => {
    try {
      const { path: _path, ...backup } = await backUp();
      return backup;
    } catch (error) {
      return reply.code(500).send({ error: `The backup failed: ${errorMessage(error)}` });
    }
  });

  /** Every limit that stops agents running away, with what each is set to, and recent trips. */
  app.get("/api/guards", async () => {
    const profiles = loadProfiles();
    const spend = spendStatus();
    const money = (value: number | null) => (value === null ? "no limit" : `$${value}`);
    return {
      global: [
        { name: "Spending per day", setting: "SPEND_LIMIT_DAILY_USD", value: money(spend.dailyUsd), what: "new tasks wait until the next UTC day once agents have spent this" },
        { name: "Spending per month", setting: "SPEND_LIMIT_MONTHLY_USD", value: money(spend.monthlyUsd), what: "new tasks wait until the next UTC month" },
        { name: "Agents starting agents", setting: "MAX_AGENT_CHAIN", value: config.maxAgentChain === 0 ? "off" : String(config.maxAgentChain), what: "how many agents in a row may start each other on related issues (start_related_agent), counted through board moves" },
        { name: "Related starts per task", setting: "built in", value: String(MAX_RELATED_STARTS_PER_TASK), what: "agents one task may start on related issues" },
        { name: "Pull requests per issue", setting: "MAX_PULL_REQUESTS_PER_ISSUE", value: config.maxPullRequestsPerIssue ? String(config.maxPullRequestsPerIssue) : "no limit", what: "pull requests agents may open for one issue, closed ones included" },
        { name: "Open agent PRs per repository", setting: "MAX_OPEN_AGENT_PRS_PER_REPO", value: config.maxOpenAgentPullsPerRepo ? String(config.maxOpenAgentPullsPerRepo) : "no limit", what: "past it, board and agent-started work that would open another pull request waits until some are merged or closed" },
        { name: "Comments per task", setting: "built in", value: String(MAX_COMMENTS_PER_TASK), what: "post_comment calls per task" },
        { name: "Sub-issues per task", setting: "built in", value: String(MAX_SUB_ISSUES_PER_TASK), what: "create_sub_issue calls per task" },
        { name: "Task timeout", setting: "TASK_TIMEOUT_MINUTES", value: `${config.defaultTimeoutMinutes} min`, what: "a task is stopped after this long (agents can set their own timeout_minutes)" },
        { name: "Agents at once", setting: "MAX_CONCURRENT_TASKS", value: String(scheduler.maxConcurrent), what: "tasks running at the same time" },
        { name: "Time between scheduled runs", setting: "SCHEDULE_MIN_MINUTES", value: `${config.scheduleMinMinutes} min`, what: "the shortest gap a schedule may have between two runs" },
        { name: "Schedules per agent", setting: "SCHEDULES_PER_AGENT", value: config.schedulesPerAgent ? String(config.schedulesPerAgent) : "no limit", what: "schedules one agent may have, its agent.md ones included" },
        { name: "Failed runs before a schedule pauses", setting: "SCHEDULE_PAUSE_AFTER_FAILURES", value: config.schedulePauseAfterFailures ? String(config.schedulePauseAfterFailures) : "never", what: "a schedule whose runs fail this many times in a row is paused until someone switches it back on" },
      ],
      boards: loadBoards(profiles).boards.map((board) => ({
        name: board.name,
        movesPerIssue: board.limits.movesPerIssue,
        entriesPerColumn: board.limits.entriesPerColumn,
        budgetUsdPerIssue: board.limits.budgetUsdPerIssue,
        maxRunning: board.limits.maxRunning,
        needsHuman: board.needsHuman,
      })),
      agents: profiles.agents.map((agent) => ({ name: agent.name, maxBudgetUsd: agent.maxBudgetUsd, maxTurns: agent.maxTurns, timeoutMinutes: agent.timeoutMinutes, replicas: agent.replicas })),
      recent: [...listIncidents(200, "loop_guard"), ...listIncidents(50, "spend_limit"), ...listIncidents(50, "schedule")].sort((a, b) => b.id - a.id).slice(0, 30),
    };
  });

  app.get<{ Querystring: { days?: string; agent?: string } }>("/api/outcomes", async (request) => outcomeReport(Number(request.query.days) || 30, request.query.agent || undefined));

  app.get<{ Querystring: { limit?: string; kind?: string } }>("/api/incidents", async (request) => listIncidents(Math.min(500, Number(request.query.limit) || 100), request.query.kind || undefined));

  // Prometheus scrapes this with METRICS_TOKEN as a bearer token (outside /api, so no sign-in).
  app.get("/metrics", async (request, reply) => {
    if (!config.metricsToken) return reply.code(404).send({ error: "Set METRICS_TOKEN to turn on /metrics" });
    const given = Buffer.from(String(request.headers.authorization ?? ""));
    const wanted = Buffer.from(`Bearer ${config.metricsToken}`);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return reply.code(401).send({ error: "Send METRICS_TOKEN as a bearer token" });
    const spend = spendStatus();
    reply.type("text/plain; version=0.0.4");
    return renderMetrics({
      atOnce: scheduler.effectiveConcurrent(),
      running: scheduler.runningIds().length,
      queued: listTasks({ status: "queued", limit: 10_000 }).length,
      paused: scheduler.paused,
      sessions: sessions.list().length,
      limited: Boolean(getLimit()),
      spendToday: spend.today,
      spendMonth: spend.month,
      isolated: isolationStatus().mode !== "off",
    });
  });

  app.get("/api/installations", async (_request, reply) => {
    if (!getCredentials()) return [];
    try {
      const octokit = getApp().octokit;
      const installations = await octokit.paginate("GET /app/installations", { per_page: 100 });
      return await Promise.all(
        installations.map(async (installation) => {
          const gh = await installationClient(installation.id);
          const { data } = await gh.request("GET /installation/repositories", { per_page: 100 });
          const account = installation.account as { login?: string; slug?: string } | null;
          return {
            id: installation.id,
            account: account?.login ?? account?.slug ?? "unknown",
            selection: installation.repository_selection,
            htmlUrl: installation.html_url,
            repositories: data.repositories.map((repo) => repo.full_name),
            totalRepositories: data.total_count,
          };
        }),
      );
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) });
    }
  });

  // ---------- GitHub App setup (manifest flow) ----------
  app.post<{ Body: { name?: string; org?: string } }>("/api/setup/manifest", async (request, reply) => {
    const name = String(request.body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "Give the app a name" });
    const org = String(request.body?.org ?? "").trim();
    const state = randomBytes(16).toString("base64url");
    setSetting("manifest_state", JSON.stringify({ state, expires: Date.now() + 3600_000 }));
    const base = org ? `${config.github.url}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${config.github.url}/settings/apps/new`;
    return { action: `${base}?state=${state}`, manifest: JSON.stringify(appManifest(name)) };
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/api/setup/callback", async (request, reply) => {
    const stored = JSON.parse(getSetting("manifest_state") ?? "{}") as { state?: string; expires?: number };
    if (!request.query.code || !stored.state || stored.state !== request.query.state || (stored.expires ?? 0) < Date.now()) {
      return reply.redirect("/#/settings?setup=expired");
    }
    setSetting("manifest_state", "{}");
    try {
      const response = await fetch(`${config.github.apiUrl}/app-manifests/${encodeURIComponent(request.query.code)}/conversions`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", "user-agent": "agent-orchestrator" },
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as {
        id: number;
        slug: string;
        pem: string;
        webhook_secret: string;
        client_id: string;
        client_secret: string;
        html_url: string;
        owner: { login: string; type: string } | null;
      };
      saveCredentials({
        appId: String(data.id),
        slug: data.slug,
        privateKey: data.pem,
        webhookSecret: data.webhook_secret,
        clientId: data.client_id,
        clientSecret: data.client_secret,
        htmlUrl: data.html_url,
        ownerLogin: data.owner?.type === "User" ? data.owner.login : "",
      });
      resetBotIdentity();
      return reply.redirect(`/#/settings?setup=created`);
    } catch (error) {
      return reply.redirect(`/#/settings?setup=error&message=${encodeURIComponent(errorMessage(error))}`);
    }
  });

  app.get("/api/setup", async () => setupView());

  // Point the App's webhooks at this PUBLIC_URL (after PUBLIC_URL changed).
  app.post("/api/setup/webhook-url", async (_request, reply) => {
    try {
      await setAppWebhookUrl(config.webhookProxyUrl || `${config.publicUrl}/api/github/webhooks`);
      return setupView();
    } catch (error) {
      return reply.code(502).send({ error: `GitHub didn't accept the new webhook URL: ${errorMessage(error)}` });
    }
  });
}
