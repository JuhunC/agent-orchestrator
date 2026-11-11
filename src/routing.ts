import { config } from "./config.ts";
import { getSetting, queuedTasks, setSetting, tasksWithStatus } from "./db.ts";
import { loadProfiles } from "./profiles/loader.ts";
import type { Profile } from "./profiles/types.ts";

/**
 * Routing: who gets work that names no agent. A new issue nobody mentioned or assigned an agent on
 * starts the triage agent (Settings → Routing, TRIAGE_AGENT), which passes it to the agent whose
 * kind of work it is with route_to_agent. Any agent with github.route can pass a thread on too.
 */

export interface Routing {
  /** The triage agent's name; null: new issues that name no agent start nobody. */
  agent: string | null;
  /** The repositories it triages (owner/name or owner/*, lower case); empty: every one. */
  repos: string[];
}

const SETTING = "routing";
const REPO = /^[\w.-]+\/([\w.-]+|\*)$/;

/** What's set in Settings → Routing, or TRIAGE_AGENT and TRIAGE_REPOS until it's changed there. */
export function routing(): Routing {
  const stored = getSetting(SETTING);
  if (stored) {
    try {
      const value = JSON.parse(stored) as Partial<Routing>;
      return { agent: value.agent ? String(value.agent) : null, repos: Array.isArray(value.repos) ? value.repos.map(String) : [] };
    } catch {
      // Unreadable: as if never set.
    }
  }
  return { agent: config.triageAgent || null, repos: config.triageRepos };
}

/** Changes the routing; a string says why it can't be. */
export function setRouting(next: { agent?: string | null; repos?: string[] }): Routing | string {
  const current = routing();
  const agent = next.agent === undefined ? current.agent : next.agent ? String(next.agent).trim() : null;
  const agents = loadProfiles().agents;
  if (agent && !agents.some((profile) => profile.name === agent)) return `There's no agent called "${agent}". Agents: ${agents.map((profile) => profile.name).join(", ") || "none"}.`;
  const repos = next.repos === undefined ? current.repos : [...new Set(next.repos.map((repo) => String(repo).trim().toLowerCase()).filter(Boolean))];
  const wrong = repos.find((repo) => !REPO.test(repo));
  if (wrong) return `"${wrong}" isn't a repository: write owner/name, or owner/* for all of an owner's.`;
  const value = { agent, repos };
  setSetting(SETTING, JSON.stringify(value));
  return value;
}

/** Why the triage agent that's set wouldn't start, or null when it would (or none is set). */
export function triageProblem(): string | null {
  const { agent } = routing();
  if (!agent) return null;
  const profile = loadProfiles().agents.find((candidate) => candidate.name === agent);
  if (!profile) return `${agent} doesn't exist any more, so new issues that name no agent start nobody.`;
  if (profile.errors.length) return `${agent}'s agent.md has errors, so new issues that name no agent start nobody.`;
  if (!profile.enabled) return `${agent} is turned off, so new issues that name no agent start nobody.`;
  return null;
}

/** The agent that routes new issues in this repository: set, there, and switched on. */
export function triageAgentFor(repoFull: string): Profile | null {
  const { agent, repos } = routing();
  if (!agent) return null;
  const full = repoFull.toLowerCase();
  if (repos.length && !repos.some((pattern) => pattern === full || pattern === `${full.split("/")[0]}/*`)) return null;
  const profile = loadProfiles().agents.find((candidate) => candidate.name === agent);
  return profile && profile.enabled && !profile.errors.length ? profile : null;
}

/** May this agent hand a thread to another (route_to_agent)? Its agent.md says so, or it's the triage agent. */
export const mayRoute = (profile: Pick<Profile, "name" | "github">): boolean => profile.github.route || routing().agent === profile.name;

/** An agent a thread can be passed to, as the routing agent's prompt lists it. */
export interface RoutableAgent {
  name: string;
  handle: string;
  description: string;
  /** Its tasks running and waiting right now, so work can go to whoever is free. */
  running: number;
  queued: number;
}

/**
 * The agents `except` could pass a thread to: every other one that's switched on, but not the
 * triage agent, which only passes work on.
 */
export function routableAgents(except: string): RoutableAgent[] {
  const running = tasksWithStatus("running");
  const queued = queuedTasks();
  const triage = routing().agent;
  return loadProfiles()
    .agents.filter((agent) => agent.name !== except && agent.name !== triage && agent.enabled && !agent.errors.length)
    .map((agent) => ({
      name: agent.name,
      handle: agent.handle,
      description: agent.description,
      running: running.filter((task) => task.agent === agent.name).length,
      queued: queued.filter((task) => task.agent === agent.name).length,
    }));
}
