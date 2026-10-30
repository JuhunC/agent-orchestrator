import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.ts";
import type { Library, Profile } from "./types.ts";

/**
 * Which version of an agent's profile ran a task: a short fingerprint of everything that shapes
 * the agent's work (its prompt, model, effort, fallback, tools, skills and their text, subagents
 * and their prompts, MCP servers, GitHub permissions, limits), and the profiles folder's git commit
 * that last changed it. Outcomes are compared by version, to see whether a change helped.
 */
export function profileVersion(profile: Profile, library: Library): string {
  const skillText = (dir: string) => (existsSync(join(dir, "SKILL.md")) ? readFileSync(join(dir, "SKILL.md"), "utf8") : "");
  const skills = [...profile.skills.map((name) => library.skills[name]).filter((skill) => skill !== undefined), ...profile.ownSkills].map((skill) => [skill.name, skillText(skill.dir)]);
  const roles = profile.subagents.map((name) => library.roles[name]).filter((role) => role !== undefined).map((role) => [role.name, role.prompt, role.tools, role.model, role.skills]);
  const shape = {
    prompt: profile.prompt,
    model: profile.model,
    effort: profile.effort,
    fallbackModel: profile.fallbackModel,
    toolsAllow: profile.toolsAllow,
    toolsDeny: profile.toolsDeny,
    skills,
    roles,
    mcp: [...profile.mcp, ...Object.keys(profile.ownMcp)].sort(),
    github: profile.github,
    limits: [profile.maxTurns, profile.maxBudgetUsd, profile.timeoutMinutes],
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 10);
}

const run = promisify(execFile);

/** The last commit in the profiles folder that changed this agent or the shared library, if it's a git repository. */
export async function profileCommit(profile: Profile): Promise<string | null> {
  if (!existsSync(join(config.profilesDir, ".git"))) return null;
  try {
    const { stdout } = await run("git", ["log", "-1", "--format=%h", "--", `agents/${profile.name}`, "library", "groups"], { cwd: config.profilesDir, timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
