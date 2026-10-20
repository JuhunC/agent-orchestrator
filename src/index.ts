import { mkdirSync } from "node:fs";
import { syncAgentsFromFile } from "./agents/registry.ts";
import { config } from "./config.ts";
import { getCredentials } from "./github/app.ts";
import { errorMessage, log } from "./log.ts";
import { scheduler } from "./runner/scheduler.ts";
import { buildServer } from "./server/http.ts";

async function main(): Promise<void> {
  mkdirSync(config.agentHome, { recursive: true });
  syncAgentsFromFile();

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
