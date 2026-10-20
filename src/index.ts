import { mkdirSync } from "node:fs";
import { config } from "./config.ts";
import { getCredentials } from "./github/app.ts";
import { errorMessage, log } from "./log.ts";
import { loadProfiles } from "./profiles/loader.ts";
import { seedProfiles } from "./profiles/seed.ts";
import { scheduler } from "./runner/scheduler.ts";
import { sessions } from "./runtime/manager.ts";
import { buildServer } from "./server/http.ts";

async function main(): Promise<void> {
  mkdirSync(config.agentHome, { recursive: true });
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
  for (const problem of [...profiles.errors.map((error) => `${error.file}: ${error.message}`), ...profiles.library.errors]) log.warn("Profile problem", { problem });

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  log.info("Agent orchestrator is running", {
    url: config.publicUrl,
    github: config.github.url,
    githubApp: getCredentials() ? "configured" : "not configured — open the admin UI → Settings",
  });

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
