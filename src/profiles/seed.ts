import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { log } from "../log.ts";

/**
 * First start: copy the bundled example profiles into an empty PROFILES_DIR, and make it a git
 * repository so every edit from the admin UI is a commit you can review, revert or push.
 */
export function seedProfiles(): void {
  const dir = config.profilesDir;
  mkdirSync(dir, { recursive: true });
  const empty = readdirSync(dir).filter((entry) => !entry.startsWith(".")).length === 0;
  if (empty && config.defaultProfilesDir && existsSync(config.defaultProfilesDir) && config.defaultProfilesDir !== dir) {
    cpSync(config.defaultProfilesDir, dir, { recursive: true });
    log.info("Copied the example agent profiles", { from: config.defaultProfilesDir, to: dir });
  }
  if (!existsSync(join(dir, ".git"))) {
    try {
      const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "agent-orchestrator", GIT_AUTHOR_EMAIL: "admin@agent-orchestrator", GIT_COMMITTER_NAME: "agent-orchestrator", GIT_COMMITTER_EMAIL: "admin@agent-orchestrator" } });
      run("init", "-q", "-b", "main");
      run("add", "-A");
      run("commit", "-q", "--allow-empty", "-m", "Agent profiles");
      log.info("Made the profiles folder a git repository", { dir });
    } catch (error) {
      log.warn("Could not initialise git in the profiles folder", { error: String(error) });
    }
  }
}
