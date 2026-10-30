import { existsSync, mkdirSync } from "node:fs";
import { config } from "./config.ts";
import { getCredentials } from "./github/app.ts";
import { errorMessage, log } from "./log.ts";
import { startBoards } from "./boards/engine.ts";
import { loadBoards } from "./boards/loader.ts";
import { loadProfiles } from "./profiles/loader.ts";
import { seedProfiles } from "./profiles/seed.ts";
import { scheduler } from "./runner/scheduler.ts";
import { startSchedules } from "./schedules/runner.ts";
import { startWorkspaceCleanup } from "./runtime/cleanup.ts";
import { startOutcomeChecks } from "./runner/outcomes.ts";
import { startAccountChecks } from "./github/accounts.ts";
import { startBackups, startRetention } from "./runtime/backup.ts";
import { setupIsolation } from "./runtime/isolation.ts";
import { sessions } from "./runtime/manager.ts";
import { buildServer } from "./server/http.ts";

async function main(): Promise<void> {
  mkdirSync(config.agentHome, { recursive: true });
  await setupIsolation();
  if (config.defaultProfilesDir) {
    try {
      seedProfiles();
    } catch (error) {
      log.error("Could not set up the profiles folder; check it's writable by the container user (uid 1000)", { dir: config.profilesDir, error: errorMessage(error) });
    }
  }
  const profiles = loadProfiles();
  log.info("Loaded agent profiles", { dir: config.profilesDir, agents: profiles.agents.map((agent) => `${agent.name} (@${agent.handle})`) });
  for (const agent of profiles.agents) if (agent.errors.length) log.warn("Agent profile has errors", { agent: agent.name, errors: agent.errors });
  const boards = loadBoards(profiles);
  if (boards.boards.length) log.info("Loaded project boards", { boards: boards.boards.map((board) => `${board.name} (${board.owner}/${board.projectNumber})`) });
  for (const board of boards.boards) if (board.errors.length) log.warn("Board has errors", { board: board.name, errors: board.errors });
  for (const problem of [...profiles.errors.map((error) => `${error.file}: ${error.message}`), ...profiles.library.errors]) log.warn("Profile problem", { problem });

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  log.info("Agent orchestrator is running", {
    url: config.publicUrl,
    github: config.github.url,
    githubApp: getCredentials() ? "configured" : "not configured — open the admin UI → Settings",
    claudeCode: config.claudeCodeExecutable || "bundled with the Agent SDK",
  });
  if (config.claudeCodeExecutable && !existsSync(config.claudeCodeExecutable)) {
    log.warn("CLAUDE_CODE_EXECUTABLE doesn't exist; agent tasks will fail until it does", { path: config.claudeCodeExecutable });
  }

  if (config.webhookProxyUrl) {
    const { default: SmeeClient } = await import("smee-client");
    const smee = new SmeeClient({
      source: config.webhookProxyUrl,
      target: `http://127.0.0.1:${config.port}/api/github/webhooks`,
      logger: { info: () => undefined, error: (...args: unknown[]) => log.warn("Webhook relay error", { error: args.map(String).join(" ") }) },
    });
    await smee.start();
    log.info("Forwarding webhooks from relay", { source: config.webhookProxyUrl });
  }

  sessions.start();
  await scheduler.start();
  startBoards();
  startWorkspaceCleanup();
  startOutcomeChecks();
  startAccountChecks();
  startBackups();
  startRetention();
  startSchedules();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("Shutting down; cancelling running agents", { signal });
    await app.close();
    await scheduler.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error) => {
  log.error("Failed to start", { error: errorMessage(error) });
  process.exit(1);
});
