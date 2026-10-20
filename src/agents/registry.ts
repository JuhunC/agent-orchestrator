import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { config } from "../config.ts";
import { deleteAgent, getAgent, getSetting, listAgents, setAgentEnabled, setSetting, upsertAgent, type AgentInput } from "../db.ts";
import { log } from "../log.ts";
import { OUTPUT_FORMATS, type Agent, type OutputFormat } from "../types.ts";

const HANDLE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const NAME = /^[a-z\d][a-z\d_-]{0,39}$/i;

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a list of strings`);
  return value.map((item) => String(item));
}

/** Validates and normalises an agent definition coming from YAML or the admin UI. */
export function normaliseAgent(raw: Record<string, unknown>, source: Agent["source"]): AgentInput {
  const name = String(raw.name ?? "").trim();
  if (!NAME.test(name)) throw new Error(`Invalid agent name "${name}": use letters, digits, - or _`);
  const handle = String(raw.handle ?? name).trim().replace(/^@/, "");
  if (!HANDLE.test(handle)) throw new Error(`Invalid handle "${handle}" for agent ${name}: must be a valid GitHub login`);
  const command = String(raw.command ?? "").trim();
  if (!command) throw new Error(`Agent ${name} needs a command`);
  const output = String(raw.output ?? "text") as OutputFormat;
  if (!OUTPUT_FORMATS.includes(output)) throw new Error(`Agent ${name}: output must be one of ${OUTPUT_FORMATS.join(", ")}`);
  const env: Record<string, string> = {};
  if (raw.env && typeof raw.env === "object") {
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) env[key] = String(value);
  }
  const timeout = raw.timeout_minutes ?? raw.timeoutMinutes;
  return {
    name,
    handle,
    description: String(raw.description ?? ""),
    command,
    args: stringList(raw.args, `${name}.args`),
    resumeArgs: stringList(raw.resume_args ?? raw.resumeArgs, `${name}.resume_args`),
    output,
    env,
    timeoutMinutes: timeout === undefined || timeout === null || timeout === "" ? null : Number(timeout),
    openPullRequest: (raw.open_pull_request ?? raw.openPullRequest ?? true) !== false,
    exposeGithubToken: (raw.expose_github_token ?? raw.exposeGithubToken ?? false) === true,
    enabled: (raw.enabled ?? true) !== false,
    source,
  };
}

/**
 * Syncs agents defined in agents.yaml into the database. File agents are owned by the file:
 * they're overwritten on every start and removed when they disappear from it. Agents created
 * in the UI are left alone. Turning a file agent on or off in the UI is remembered separately,
 * so it survives restarts.
 */
export function syncAgentsFromFile(path = config.agentsConfigPath): void {
  if (!existsSync(path)) {
    log.warn("No agents config file found; only agents created in the admin UI will be available", { path });
    return;
  }
  const doc = parse(readFileSync(path, "utf8")) as { agents?: Record<string, unknown>[] } | null;
  const defined = new Set<string>();
  for (const raw of doc?.agents ?? []) {
    try {
      const agent = normaliseAgent(raw, "file");
      const existing = getAgent(agent.name);
      if (existing && existing.source === "ui") {
        log.warn("Agent defined in both the UI and agents.yaml; the file wins", { agent: agent.name });
      }
      const override = getSetting(`agent_enabled:${agent.name}`);
      if (override !== null) agent.enabled = override === "true";
      upsertAgent(agent);
      defined.add(agent.name);
    } catch (error) {
      log.error("Skipping invalid agent in agents.yaml", { error: String(error) });
    }
  }
  for (const agent of listAgents()) {
    if (agent.source === "file" && !defined.has(agent.name)) deleteAgent(agent.name);
  }
  log.info("Loaded agents", { count: defined.size, path });
}

export function toggleAgent(agent: Agent, enabled: boolean): void {
  if (agent.source === "file") setSetting(`agent_enabled:${agent.name}`, String(enabled));
  setAgentEnabled(agent.name, enabled);
}
